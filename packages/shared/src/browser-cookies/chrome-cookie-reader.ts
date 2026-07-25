import { createDecipheriv, createHash, pbkdf2Sync, timingSafeEqual } from 'node:crypto'
import { execFileSync } from 'node:child_process'
import { copyFileSync, existsSync, mkdtempSync, rmSync } from 'node:fs'
import { homedir, tmpdir } from 'node:os'
import { join } from 'node:path'
import Database from 'better-sqlite3'
import type {
  BrowserCookie,
  BrowserCookieReadResult,
  BrowserCookieSameSite,
} from './types'

const CHROME_EPOCH_OFFSET_SECONDS = 11_644_473_600
const CHROME_COOKIE_IV = Buffer.alloc(16, 0x20)

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

export interface ReadChromeCookiesOptions {
  browser?: ChromiumBrowser
  profile?: string
  domain?: string
  cookieDbPath?: string
  platform?: NodeJS.Platform
  readKeychainPassword?: () => string
  openCookieDatabase?: ChromeCookieDatabaseFactory
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

export interface ChromeCookieDatabase {
  readCookies(sql: string, parameters: readonly string[]): ChromeCookieRow[]
  close(): void
}

export type ChromeCookieDatabaseFactory = (path: string) => ChromeCookieDatabase

function openBetterSqliteDatabase(path: string): ChromeCookieDatabase {
  const database = new Database(path, {
    readonly: true,
    fileMustExist: true,
  })
  return {
    readCookies(sql, parameters) {
      return database
        .prepare<string[], ChromeCookieRow>(sql)
        .all(...parameters)
    },
    close() {
      database.close()
    },
  }
}

function locateCookieDatabase(browser: ChromiumBrowser, profile: string): string {
  const browserConfig = CHROMIUM_BROWSERS[browser]
  const profileDirectory = join(
    homedir(),
    'Library',
    'Application Support',
    ...browserConfig.applicationPath,
    profile,
  )
  const candidates = [
    join(profileDirectory, 'Network', 'Cookies'),
    join(profileDirectory, 'Cookies'),
  ]
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
    const expectedDomainHash = createHash('sha256').update(row.host_key).digest()
    if (timingSafeEqual(plaintext.subarray(0, 32), expectedDomainHash)) {
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

export function readChromeCookies(
  options: ReadChromeCookiesOptions = {},
): BrowserCookieReadResult {
  const platform = options.platform ?? process.platform
  if (platform !== 'darwin') {
    throw new ChromeCookieReaderError(
      'unsupported-platform',
      `Chrome cookie import is unsupported on platform "${platform}"`,
    )
  }

  const browser = options.browser ?? 'chrome'
  const profile = options.profile?.trim() || 'Default'
  const sourceDatabasePath = options.cookieDbPath
    ?? locateCookieDatabase(browser, profile)

  if (!existsSync(sourceDatabasePath)) {
    throw new ChromeCookieReaderError(
      'cookie-db-not-found',
      `Cookie database not found for ${browser} profile "${profile}"`,
    )
  }

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
  const key = deriveEncryptionKey(password)
  const temporaryDirectory = mkdtempSync(join(tmpdir(), 'craft-chrome-cookies-'))
  const temporaryDatabasePath = join(temporaryDirectory, 'Cookies')
  let database: ChromeCookieDatabase | null = null

  try {
    copyFileSync(sourceDatabasePath, temporaryDatabasePath)
    database = (options.openCookieDatabase ?? openBetterSqliteDatabase)(
      temporaryDatabasePath,
    )

    let rows: ChromeCookieRow[]
    const normalizedDomain = options.domain?.trim().toLowerCase().replace(/^\./, '')
    if (normalizedDomain) {
      rows = database.readCookies(`
          SELECT host_key, name, encrypted_value, path, expires_utc,
                 is_secure, is_httponly, samesite
          FROM cookies
          WHERE host_key = ? OR host_key = ?
        `, [normalizedDomain, `.${normalizedDomain}`])
    } else {
      rows = database.readCookies(`
          SELECT host_key, name, encrypted_value, path, expires_utc,
                 is_secure, is_httponly, samesite
          FROM cookies
        `, [])
    }

    const cookies: BrowserCookie[] = []
    let skipped = 0
    for (const row of rows) {
      try {
        cookies.push(toBrowserCookie(row, key))
      } catch {
        skipped += 1
      }
    }
    return { cookies, skipped }
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
