import { createDecipheriv, createHash, pbkdf2Sync } from 'node:crypto'
import { execFileSync } from 'node:child_process'
import { copyFileSync, existsSync, mkdtempSync, readdirSync, rmSync, statSync } from 'node:fs'
import { homedir, tmpdir } from 'node:os'
import { isAbsolute, join, relative, resolve } from 'node:path'
import Database from 'better-sqlite3'
import type {
  BrowserCookie,
  BrowserCookieImportPreview,
  BrowserCookieReadResult,
  BrowserCookieSameSite,
} from './types'

const CHROME_EPOCH_OFFSET_SECONDS = 11_644_473_600
const CHROME_COOKIE_IV = Buffer.alloc(16, 0x20)

/** Prefix of the throwaway directory the locked cookie DB is copied into. */
const COOKIE_TEMP_PREFIX = 'craft-chrome-cookies-'

/**
 * A temp copy older than this is a leftover from a process that died before
 * its `finally` ran, never a read in flight. See `sweepStaleCookieTempDirs`.
 */
const STALE_COOKIE_TEMP_AGE_MS = 60 * 60 * 1000

/**
 * Profile directory names Chrome actually creates: `Default`, `Profile 1`,
 * `Guest Profile`. Anything else — notably `..` — is refused before the path
 * is built, because `join` happily resolves traversal segments.
 */
const CHROME_PROFILE_PATTERN = /^[A-Za-z0-9 _-]+$/

/**
 * Hosts whose cookies are never decrypted, not even to be discarded
 * afterwards. Matching is exact on the host (a leading dot is ignored), so the
 * list names each sensitive host rather than relying on suffix rules.
 *
 * Google is the default entry because it is where device-bound session
 * credentials (DBSC) actually bite: those cookies would not authenticate a
 * different browser even if copied, so withholding them is honest rather than
 * restrictive. Because the match is exact, every host that carries the same
 * account session has to be named individually — the master cookies (`SID`,
 * `SAPISID`, `__Secure-3PSID`) also ride on `.youtube.com` and on Google hosts
 * other than the account/mail ones, and withholding only some of them would
 * let an equivalent session through while the confirmation claims the account
 * is protected. Callers may pass their own list through `denylist`.
 */
export const DEFAULT_SENSITIVE_HOST_DENYLIST: readonly string[] = [
  'accounts.google.com',
  'google.com',
  'www.google.com',
  'mail.google.com',
  'docs.google.com',
  'drive.google.com',
  'myaccount.google.com',
  'googleapis.com',
  'youtube.com',
  'www.youtube.com',
]

const CHROMIUM_BROWSERS = {
  chrome: {
    applicationPath: ['Google', 'Chrome'],
    keychainService: 'Chrome Safe Storage',
    keychainAccount: 'Chrome',
  },
  chromium: {
    applicationPath: ['Chromium'],
    keychainService: 'Chromium Safe Storage',
    keychainAccount: 'Chromium',
  },
  brave: {
    applicationPath: ['BraveSoftware', 'Brave-Browser'],
    keychainService: 'Brave Safe Storage',
    keychainAccount: 'Brave',
  },
  edge: {
    applicationPath: ['Microsoft Edge'],
    keychainService: 'Microsoft Edge Safe Storage',
    keychainAccount: 'Microsoft Edge',
  },
} as const

export type ChromiumBrowser = keyof typeof CHROMIUM_BROWSERS

export type ChromeCookieReaderErrorCode =
  | 'unsupported-platform'
  | 'invalid-profile'
  | 'cookie-db-not-found'
  | 'keychain-read-failed'
  | 'cookie-db-read-failed'

export class ChromeCookieReaderError extends Error {
  readonly code: ChromeCookieReaderErrorCode

  constructor(code: ChromeCookieReaderErrorCode, message: string, cause?: unknown) {
    super(message, cause === undefined ? undefined : { cause })
    this.name = 'ChromeCookieReaderError'
    this.code = code
  }
}

/** Everything needed to locate and open the cookie DB, without decrypting it. */
export interface ChromeCookieScanOptions {
  browser?: ChromiumBrowser
  profile?: string
  domain?: string
  cookieDbPath?: string
  platform?: NodeJS.Platform
  /**
   * Replaces `DEFAULT_SENSITIVE_HOST_DENYLIST`. An empty array does NOT turn
   * the protection off: it falls back to the default, so a caller writing
   * `denylist: config.denylist ?? []` cannot silently disable it.
   */
  denylist?: readonly string[]
  openCookieDatabase?: ChromeCookieDatabaseFactory
}

export interface ReadChromeCookiesOptions extends ChromeCookieScanOptions {
  readKeychainPassword?: () => string
}

export interface ChromeCookieRow {
  host_key: string
  name: string
  encrypted_value: Buffer
  path: string
  expires_utc: number
  is_secure: number
  is_httponly: number
  samesite: number
}

export interface ChromeCookieHostRow {
  host_key: string
}

export interface ChromeCookieDatabase {
  readCookies<TRow = ChromeCookieRow>(sql: string, parameters: readonly string[]): TRow[]
  close(): void
}

export type ChromeCookieDatabaseFactory = (path: string) => ChromeCookieDatabase

const COOKIE_COLUMNS = `host_key, name, encrypted_value, path, expires_utc,
                 is_secure, is_httponly, samesite`
const HOST_COLUMNS = 'host_key'

function openBetterSqliteDatabase(path: string): ChromeCookieDatabase {
  const database = new Database(path, {
    readonly: true,
    fileMustExist: true,
  })
  return {
    readCookies<TRow>(sql: string, parameters: readonly string[]): TRow[] {
      return database
        .prepare<string[], TRow>(sql)
        .all(...parameters)
    },
    close() {
      database.close()
    },
  }
}

function locateCookieDatabase(browser: ChromiumBrowser, profile: string): string {
  if (!CHROME_PROFILE_PATTERN.test(profile)) {
    throw new ChromeCookieReaderError(
      'invalid-profile',
      `Invalid ${browser} profile name`,
    )
  }
  const browserConfig = CHROMIUM_BROWSERS[browser]
  const browserDirectory = resolve(
    homedir(),
    'Library',
    'Application Support',
    ...browserConfig.applicationPath,
  )
  const profileDirectory = resolve(browserDirectory, profile)
  const candidates = [
    resolve(profileDirectory, 'Network', 'Cookies'),
    resolve(profileDirectory, 'Cookies'),
  ]
  // Belt and braces: the pattern already rejects traversal, but the resolved
  // path is what actually gets opened, so that is what gets confined.
  const escapesBrowserDirectory = candidates.some((candidate) => {
    const relativePath = relative(browserDirectory, candidate)
    return relativePath === '' || relativePath.startsWith('..') || isAbsolute(relativePath)
  })
  if (escapesBrowserDirectory) {
    throw new ChromeCookieReaderError(
      'invalid-profile',
      `Invalid ${browser} profile name`,
    )
  }
  const found = candidates.find(candidate => existsSync(candidate))
  if (!found) {
    throw new ChromeCookieReaderError(
      'cookie-db-not-found',
      `Cookie database not found for ${browser} profile "${profile}"`,
    )
  }
  return found
}

function readPasswordFromKeychain(browser: ChromiumBrowser): string {
  const browserConfig = CHROMIUM_BROWSERS[browser]
  try {
    return execFileSync('security', [
      'find-generic-password',
      '-w',
      '-s',
      browserConfig.keychainService,
      '-a',
      browserConfig.keychainAccount,
    ], {
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'pipe'],
    }).trimEnd()
  } catch (cause) {
    throw new ChromeCookieReaderError(
      'keychain-read-failed',
      `Unable to read ${browserConfig.keychainService} from macOS Keychain`,
      cause,
    )
  }
}

function deriveEncryptionKey(password: string): Buffer {
  return pbkdf2Sync(password, 'saltysalt', 1003, 16, 'sha1')
}

function decryptCookieValue(row: ChromeCookieRow, key: Buffer): string {
  const encryptedValue = Buffer.from(row.encrypted_value)
  if (
    encryptedValue.length <= 3
    || encryptedValue.subarray(0, 3).toString('ascii') !== 'v10'
  ) {
    throw new Error('Unsupported encrypted cookie format')
  }

  const decipher = createDecipheriv('aes-128-cbc', key, CHROME_COOKIE_IV)
  let plaintext = Buffer.concat([
    decipher.update(encryptedValue.subarray(3)),
    decipher.final(),
  ])

  if (plaintext.length >= 32) {
    // Both sides are derived locally from the row's own host, so there is no
    // secret and no attacker to time here — a plain comparison is honest.
    const expectedDomainHash = createHash('sha256').update(row.host_key).digest()
    if (plaintext.subarray(0, 32).equals(expectedDomainHash)) {
      plaintext = plaintext.subarray(32)
    }
  }

  return plaintext.toString('utf8')
}

function normalizeSameSite(value: number): BrowserCookieSameSite {
  return value === 0 || value === 1 || value === 2 ? value : -1
}

function toBrowserCookie(row: ChromeCookieRow, key: Buffer): BrowserCookie {
  return {
    name: row.name,
    value: decryptCookieValue(row, key),
    domain: row.host_key,
    path: row.path,
    secure: row.is_secure === 1,
    httpOnly: row.is_httponly === 1,
    expirationDate: row.expires_utc === 0
      ? undefined
      : row.expires_utc / 1e6 - CHROME_EPOCH_OFFSET_SECONDS,
    sameSite: normalizeSameSite(row.samesite),
  }
}

function normalizeHost(host: string): string {
  return host.trim().toLowerCase().replace(/^\./, '')
}

function buildDenylist(denylist: readonly string[] | undefined): ReadonlySet<string> {
  // `?? DEFAULT` would not catch `[]`, which is not nullish — an empty
  // override must fall back to the default rather than withhold nothing.
  const entries = denylist?.length ? denylist : DEFAULT_SENSITIVE_HOST_DENYLIST
  return new Set(entries.map(normalizeHost).filter(entry => entry.length > 0))
}

function buildCookieQuery(
  columns: string,
  domain: string | undefined,
): { sql: string; parameters: string[] } {
  const normalizedDomain = domain === undefined ? '' : normalizeHost(domain)
  if (!normalizedDomain) {
    return { sql: `SELECT ${columns} FROM cookies`, parameters: [] }
  }
  return {
    sql: `SELECT ${columns} FROM cookies WHERE host_key = ? OR host_key = ?`,
    parameters: [normalizedDomain, `.${normalizedDomain}`],
  }
}

function resolveSourceDatabase(options: ChromeCookieScanOptions): {
  browser: ChromiumBrowser
  profile: string
  path: string
} {
  const platform = options.platform ?? process.platform
  if (platform !== 'darwin') {
    throw new ChromeCookieReaderError(
      'unsupported-platform',
      `Chrome cookie import is unsupported on platform "${platform}"`,
    )
  }

  const browser = options.browser ?? 'chrome'
  const profile = options.profile?.trim() || 'Default'
  const path = options.cookieDbPath ?? locateCookieDatabase(browser, profile)

  if (!existsSync(path)) {
    throw new ChromeCookieReaderError(
      'cookie-db-not-found',
      `Cookie database not found for ${browser} profile "${profile}"`,
    )
  }
  return { browser, profile, path }
}

/**
 * Copy the (locked) live cookie DB to a private temp dir, hand the open handle
 * to `use`, and always close and delete afterwards.
 */
function withCookieDatabase<T>(
  options: ChromeCookieScanOptions,
  use: (database: ChromeCookieDatabase) => T,
): T {
  const { browser, profile, path: sourceDatabasePath } = resolveSourceDatabase(options)
  const temporaryDirectory = mkdtempSync(join(tmpdir(), COOKIE_TEMP_PREFIX))
  const temporaryDatabasePath = join(temporaryDirectory, 'Cookies')
  let database: ChromeCookieDatabase | null = null

  try {
    copyFileSync(sourceDatabasePath, temporaryDatabasePath)
    database = (options.openCookieDatabase ?? openBetterSqliteDatabase)(
      temporaryDatabasePath,
    )
    return use(database)
  } catch (cause) {
    if (cause instanceof ChromeCookieReaderError) throw cause
    throw new ChromeCookieReaderError(
      'cookie-db-read-failed',
      `Unable to read cookies for ${browser} profile "${profile}"`,
      cause,
    )
  } finally {
    database?.close()
    rmSync(temporaryDirectory, { recursive: true, force: true })
  }
}

/**
 * Count what an import would carry without decrypting anything: this pass
 * selects `host_key` only, so no cookie value is ever materialized and the
 * Keychain is never touched. It exists so the confirmation the user sees is
 * not blind.
 */
export function previewChromeCookies(
  options: ChromeCookieScanOptions = {},
): BrowserCookieImportPreview {
  const denied = buildDenylist(options.denylist)

  return withCookieDatabase(options, (database) => {
    const { sql, parameters } = buildCookieQuery(HOST_COLUMNS, options.domain)
    const rows = database.readCookies<ChromeCookieHostRow>(sql, parameters)

    const hosts = new Set<string>()
    const blockedHosts = new Set<string>()
    let cookies = 0
    let blockedCookies = 0

    for (const row of rows) {
      const host = normalizeHost(row.host_key)
      if (denied.has(host)) {
        blockedCookies += 1
        blockedHosts.add(host)
        continue
      }
      cookies += 1
      hosts.add(host)
    }

    return {
      cookies,
      hosts: hosts.size,
      blockedCookies,
      blockedHosts: blockedHosts.size,
    }
  })
}

export function readChromeCookies(
  options: ReadChromeCookiesOptions = {},
): BrowserCookieReadResult {
  const denied = buildDenylist(options.denylist)
  const browser = options.browser ?? 'chrome'

  // Fail on platform/profile/missing-DB before prompting for the Keychain.
  const source = resolveSourceDatabase(options)

  let password: string
  try {
    password = (options.readKeychainPassword ?? (() => readPasswordFromKeychain(browser)))()
  } catch (cause) {
    if (cause instanceof ChromeCookieReaderError) throw cause
    throw new ChromeCookieReaderError(
      'keychain-read-failed',
      `Unable to read ${CHROMIUM_BROWSERS[browser].keychainService} from macOS Keychain`,
      cause,
    )
  }

  // This 16-byte key decrypts the whole cookie store; it must not outlive the
  // read. (`password` is an immutable JS string and cannot be wiped.)
  const key = deriveEncryptionKey(password)
  try {
    return withCookieDatabase({ ...options, cookieDbPath: source.path }, (database) => {
      const { sql, parameters } = buildCookieQuery(COOKIE_COLUMNS, options.domain)
      const rows = database.readCookies<ChromeCookieRow>(sql, parameters)

      const cookies: BrowserCookie[] = []
      let skipped = 0
      let blocked = 0

      for (const row of rows) {
        // Denylisted hosts are dropped before decryption, so their values are
        // never materialized — not even to be discarded afterwards.
        if (denied.has(normalizeHost(row.host_key))) {
          blocked += 1
          continue
        }
        try {
          cookies.push(toBrowserCookie(row, key))
        } catch {
          skipped += 1
        }
      }
      return { cookies, skipped, blocked }
    })
  } finally {
    key.fill(0)
  }
}

/**
 * Delete cookie-DB temp copies left behind by a process that died between the
 * copy and its `finally`. The copy keeps `host_key` and `name` in clear text —
 * the full list of sites the user is signed into — so a leftover is a real
 * disclosure.
 *
 * Startup sweep rather than an exit hook on purpose: an exit hook does not run
 * on SIGKILL or a hard crash, which is exactly the case that strands the file.
 *
 * Returns the number of directories removed.
 */
export function sweepStaleCookieTempDirs(options: {
  root?: string
  maxAgeMs?: number
  now?: number
} = {}): number {
  const root = options.root ?? tmpdir()
  const maxAgeMs = options.maxAgeMs ?? STALE_COOKIE_TEMP_AGE_MS
  const now = options.now ?? Date.now()

  let entries: string[]
  try {
    entries = readdirSync(root)
  } catch {
    return 0
  }

  let removed = 0
  for (const entry of entries) {
    if (!entry.startsWith(COOKIE_TEMP_PREFIX)) continue
    const candidate = join(root, entry)
    try {
      if (now - statSync(candidate).mtimeMs < maxAgeMs) continue
      rmSync(candidate, { recursive: true, force: true })
      removed += 1
    } catch {
      // Best effort: a concurrent sweep may have removed it already. Skipping
      // one leftover must not abort the rest of the sweep.
    }
  }
  return removed
}
