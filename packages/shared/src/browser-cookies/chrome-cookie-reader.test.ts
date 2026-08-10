import { afterEach, beforeEach, describe, expect, it } from 'bun:test'
import { createCipheriv, createHash, pbkdf2Sync } from 'node:crypto'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Database } from 'bun:sqlite'
import {
  ChromeCookieReaderError,
  previewChromeCookies,
  readChromeCookies,
  type ChromeCookieDatabase,
} from './chrome-cookie-reader'

const KEYCHAIN_PASSWORD = 'test-safe-storage-password'
const IV = Buffer.alloc(16, 0x20)

interface FixtureCookie {
  domain: string
  name: string
  value: string
  path?: string
  expiresUtc?: number
  secure?: boolean
  httpOnly?: boolean
  sameSite?: -1 | 0 | 1 | 2
  domainHashPrefix?: boolean
  /** Encrypt under a different Keychain password, so decryption throws. */
  password?: string
}

describe('readChromeCookies', () => {
  let fixtureDirectory: string
  let databasePath: string
  let database: Database | null

  beforeEach(() => {
    fixtureDirectory = mkdtempSync(join(tmpdir(), 'craft-cookie-reader-test-'))
    databasePath = join(fixtureDirectory, 'Cookies')
    database = new Database(databasePath, { create: true })
    database.exec(`
      CREATE TABLE cookies (
        host_key TEXT NOT NULL,
        name TEXT NOT NULL,
        encrypted_value BLOB NOT NULL,
        path TEXT NOT NULL,
        expires_utc INTEGER NOT NULL,
        is_secure INTEGER NOT NULL,
        is_httponly INTEGER NOT NULL,
        samesite INTEGER NOT NULL
      )
    `)
  })

  afterEach(() => {
    database?.close()
    database = null
    rmSync(fixtureDirectory, { recursive: true, force: true })
  })

  function encryptValue(
    domain: string,
    value: string,
    domainHashPrefix = false,
    password = KEYCHAIN_PASSWORD,
  ): Buffer {
    const key = pbkdf2Sync(password, 'saltysalt', 1003, 16, 'sha1')
    const prefix = domainHashPrefix
      ? createHash('sha256').update(domain).digest()
      : Buffer.alloc(0)
    const cipher = createCipheriv('aes-128-cbc', key, IV)
    return Buffer.concat([
      Buffer.from('v10'),
      cipher.update(Buffer.concat([prefix, Buffer.from(value, 'utf8')])),
      cipher.final(),
    ])
  }

  function insertCookie(cookie: FixtureCookie): void {
    if (!database) throw new Error('Fixture database is not open')
    database.prepare(`
      INSERT INTO cookies (
        host_key, name, encrypted_value, path, expires_utc,
        is_secure, is_httponly, samesite
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      cookie.domain,
      cookie.name,
      encryptValue(cookie.domain, cookie.value, cookie.domainHashPrefix, cookie.password),
      cookie.path ?? '/',
      cookie.expiresUtc ?? 0,
      cookie.secure ? 1 : 0,
      cookie.httpOnly ? 1 : 0,
      cookie.sameSite ?? -1,
    )
  }

  function read(domain?: string, denylist?: readonly string[]) {
    if (!database) throw new Error('Fixture database is not open')
    database.close()
    database = null
    return readChromeCookies({
      cookieDbPath: databasePath,
      domain,
      denylist,
      platform: 'darwin',
      readKeychainPassword: () => KEYCHAIN_PASSWORD,
      openCookieDatabase: openBunSqliteDatabase,
    })
  }

  function preview(domain?: string, denylist?: readonly string[]) {
    if (!database) throw new Error('Fixture database is not open')
    database.close()
    database = null
    // No `readKeychainPassword`: the preview must never need one.
    return previewChromeCookies({
      cookieDbPath: databasePath,
      domain,
      denylist,
      platform: 'darwin',
      openCookieDatabase: openBunSqliteDatabase,
    })
  }

  function openBunSqliteDatabase(path: string): ChromeCookieDatabase {
    const copiedDatabase = new Database(path, { readonly: true })
    return {
      readCookies<TRow>(sql: string, parameters: readonly string[]): TRow[] {
        return copiedDatabase.query(sql).all(...parameters) as TRow[]
      },
      close() {
        copiedDatabase.close()
      },
    }
  }

  it('decrypts a v10 cookie with a known key', () => {
    insertCookie({ domain: 'example.com', name: 'session', value: 'known-value' })

    const result = read()

    expect(result).toEqual({
      cookies: [{
        name: 'session',
        value: 'known-value',
        domain: 'example.com',
        path: '/',
        secure: false,
        httpOnly: false,
        expirationDate: undefined,
        sameSite: -1,
      }],
      skipped: 0,
      blocked: 0,
    })
  })

  it('strips the recent Chrome domain-hash prefix from the exact cookie value', () => {
    insertCookie({
      domain: '.example.com',
      name: 'hashed',
      value: 'exact-unprefixed-value',
      domainHashPrefix: true,
    })

    const result = read()

    expect(result.cookies[0]?.value).toBe('exact-unprefixed-value')
  })

  it('converts the Chrome epoch and leaves zero-expiry cookies session-scoped', () => {
    insertCookie({
      domain: 'example.com',
      name: 'persistent',
      value: 'persistent-value',
      expiresUtc: 13_350_000_000_000_000,
    })
    insertCookie({
      domain: 'example.com',
      name: 'session',
      value: 'session-value',
      expiresUtc: 0,
    })

    const result = read()

    expect(result.cookies.find(cookie => cookie.name === 'persistent')?.expirationDate)
      .toBe(1_705_526_400)
    expect(result.cookies.find(cookie => cookie.name === 'session')?.expirationDate)
      .toBeUndefined()
  })

  it('matches both exact and dot-prefixed hosts for a domain filter', () => {
    insertCookie({ domain: 'example.com', name: 'exact', value: 'one' })
    insertCookie({ domain: '.example.com', name: 'dotted', value: 'two' })
    insertCookie({ domain: 'other.com', name: 'other', value: 'three' })

    const result = read('example.com')

    expect(result.cookies.map(cookie => cookie.name).sort()).toEqual(['dotted', 'exact'])
  })

  it('skips a corrupt row while returning all three valid cookies', () => {
    insertCookie({ domain: 'example.com', name: 'one', value: 'one' })
    insertCookie({ domain: 'example.com', name: 'two', value: 'two' })
    insertCookie({ domain: 'example.com', name: 'three', value: 'three' })
    if (!database) throw new Error('Fixture database is not open')
    database.prepare(`
      INSERT INTO cookies (
        host_key, name, encrypted_value, path, expires_utc,
        is_secure, is_httponly, samesite
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)
    `).run('example.com', 'corrupt', Buffer.from('v10-not-valid-ciphertext'), '/', 0, 0, 0, -1)

    const result = read('example.com')

    expect(result.cookies).toHaveLength(3)
    expect(result.skipped).toBe(1)
  })

  it('wraps Keychain failures in a typed error without leaking raw stderr', () => {
    insertCookie({ domain: 'example.com', name: 'session', value: 'value' })
    database?.close()
    database = null

    expect(() => readChromeCookies({
      cookieDbPath: databasePath,
      platform: 'darwin',
      readKeychainPassword: () => {
        throw new Error('RAW_KEYCHAIN_STDERR')
      },
    })).toThrow(ChromeCookieReaderError)

    try {
      readChromeCookies({
        cookieDbPath: databasePath,
        platform: 'darwin',
        readKeychainPassword: () => {
          throw new Error('RAW_KEYCHAIN_STDERR')
        },
      })
      throw new Error('Expected readChromeCookies to throw')
    } catch (error) {
      expect(error).toBeInstanceOf(ChromeCookieReaderError)
      expect((error as ChromeCookieReaderError).code).toBe('keychain-read-failed')
      expect((error as Error).message).not.toContain('RAW_KEYCHAIN_STDERR')
    }
  })

  it('rejects non-macOS platforms explicitly', () => {
    expect(() => readChromeCookies({
      cookieDbPath: databasePath,
      platform: 'linux',
      readKeychainPassword: () => KEYCHAIN_PASSWORD,
    })).toThrow(ChromeCookieReaderError)

    try {
      readChromeCookies({
        cookieDbPath: databasePath,
        platform: 'linux',
        readKeychainPassword: () => KEYCHAIN_PASSWORD,
      })
      throw new Error('Expected readChromeCookies to throw')
    } catch (error) {
      expect(error).toBeInstanceOf(ChromeCookieReaderError)
      expect((error as ChromeCookieReaderError).code).toBe('unsupported-platform')
    }
  })

  it('withholds a denylisted host before it is ever decrypted', () => {
    insertCookie({ domain: 'example.com', name: 'ok', value: 'fine' })
    // Encrypted under a different password: decrypting it throws, so it would
    // land in `skipped`. Landing in `blocked` with `skipped: 0` is the proof
    // that the row was dropped before `decryptCookieValue` ever saw it.
    insertCookie({
      domain: 'accounts.google.com',
      name: 'SID',
      value: 'must-never-be-decrypted',
      password: 'a-different-password',
    })

    const result = read()

    expect(result.cookies.map(cookie => cookie.domain)).toEqual(['example.com'])
    expect(result.blocked).toBe(1)
    expect(result.skipped).toBe(0)
  })

  it('denies a dotted host the same as its bare form', () => {
    insertCookie({ domain: '.google.com', name: 'SID', value: 'domain-cookie' })
    insertCookie({ domain: 'mail.google.com', name: 'OSID', value: 'mail-cookie' })

    const result = read()

    expect(result.cookies).toHaveLength(0)
    expect(result.blocked).toBe(2)
  })

  it('does not deny an unlisted sibling host', () => {
    // Matching is exact per host, so the default list withholds exactly the
    // hosts it names and nothing else.
    insertCookie({ domain: 'notgoogle.com', name: 'a', value: 'one' })

    const result = read()

    expect(result.cookies.map(cookie => cookie.domain)).toEqual(['notgoogle.com'])
    expect(result.blocked).toBe(0)
  })

  it('withholds the sibling hosts that carry the same Google session', () => {
    // The master account cookies (`SID`, `SAPISID`, `__Secure-3PSID`) are set
    // on `.youtube.com` and on Google hosts other than the three originally
    // named. Each row is encrypted under a different password, so a value that
    // reached `decryptCookieValue` would land in `skipped`; `blocked` with
    // `skipped: 0` is the proof that none of them was decrypted.
    const sessionHosts = [
      '.youtube.com',
      'www.google.com',
      'docs.google.com',
      'drive.google.com',
      'myaccount.google.com',
      'googleapis.com',
    ]
    for (const domain of sessionHosts) {
      insertCookie({
        domain,
        name: 'SID',
        value: 'must-never-be-decrypted',
        password: 'a-different-password',
      })
    }
    insertCookie({ domain: 'example.com', name: 'ok', value: 'fine' })

    const result = read()

    expect(result.cookies.map(cookie => cookie.domain)).toEqual(['example.com'])
    expect(result.blocked).toBe(sessionHosts.length)
    expect(result.skipped).toBe(0)
  })

  it('accepts a caller-supplied denylist in place of the default', () => {
    insertCookie({ domain: 'accounts.google.com', name: 'SID', value: 'now-allowed' })
    insertCookie({ domain: 'intranet.example.com', name: 'sso', value: 'now-denied' })

    const result = read(undefined, ['intranet.example.com'])

    expect(result.cookies.map(cookie => cookie.domain)).toEqual(['accounts.google.com'])
    expect(result.blocked).toBe(1)
  })

  it('falls back to the default denylist when the override is empty', () => {
    // `[]` is not nullish, so a caller writing `denylist: config.denylist ?? []`
    // would otherwise disable the protection entirely and in silence.
    insertCookie({
      domain: 'accounts.google.com',
      name: 'SID',
      value: 'must-never-be-decrypted',
      password: 'a-different-password',
    })
    insertCookie({ domain: 'example.com', name: 'ok', value: 'fine' })

    const result = read(undefined, [])

    expect(result.cookies.map(cookie => cookie.domain)).toEqual(['example.com'])
    expect(result.blocked).toBe(1)
    expect(result.skipped).toBe(0)
  })

  it('previews cookie and host counts without a Keychain password', () => {
    insertCookie({ domain: 'example.com', name: 'a', value: 'one' })
    insertCookie({ domain: '.example.com', name: 'b', value: 'two' })
    insertCookie({ domain: 'other.com', name: 'c', value: 'three' })
    insertCookie({ domain: 'accounts.google.com', name: 'SID', value: 'four' })
    insertCookie({ domain: 'mail.google.com', name: 'OSID', value: 'five' })

    // `preview` passes no `readKeychainPassword`; needing one would throw.
    expect(preview()).toEqual({
      cookies: 3,
      hosts: 2,
      blockedCookies: 2,
      blockedHosts: 2,
    })
  })

  it('honors the domain filter in the preview pass', () => {
    insertCookie({ domain: 'example.com', name: 'a', value: 'one' })
    insertCookie({ domain: 'other.com', name: 'b', value: 'two' })

    expect(preview('example.com')).toEqual({
      cookies: 1,
      hosts: 1,
      blockedCookies: 0,
      blockedHosts: 0,
    })
  })

  it('refuses a Chrome profile name that could traverse out of the browser dir', () => {
    for (const profile of ['../../../../etc', 'Default/../../..', 'Default/Network']) {
      try {
        readChromeCookies({
          profile,
          platform: 'darwin',
          readKeychainPassword: () => KEYCHAIN_PASSWORD,
          openCookieDatabase: openBunSqliteDatabase,
        })
        throw new Error(`Expected readChromeCookies to refuse profile "${profile}"`)
      } catch (error) {
        expect(error).toBeInstanceOf(ChromeCookieReaderError)
        expect((error as ChromeCookieReaderError).code).toBe('invalid-profile')
      }
    }
  })

  it('accepts the profile names Chrome actually creates', () => {
    // These pass the name check and fail later, on the missing database —
    // which is what proves the check did not reject them.
    for (const profile of ['Default', 'Profile 1', 'Craft_Test-Profile 999']) {
      try {
        readChromeCookies({
          browser: 'chromium',
          profile: `${profile} craft-nonexistent`,
          platform: 'darwin',
          readKeychainPassword: () => KEYCHAIN_PASSWORD,
          openCookieDatabase: openBunSqliteDatabase,
        })
        throw new Error(`Expected readChromeCookies to throw for profile "${profile}"`)
      } catch (error) {
        expect(error).toBeInstanceOf(ChromeCookieReaderError)
        expect((error as ChromeCookieReaderError).code).toBe('cookie-db-not-found')
      }
    }
  })
})
