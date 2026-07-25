import { afterEach, beforeEach, describe, expect, it } from 'bun:test'
import { createCipheriv, createHash, pbkdf2Sync } from 'node:crypto'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Database } from 'bun:sqlite'
import {
  ChromeCookieReaderError,
  readChromeCookies,
  type ChromeCookieDatabase,
  type ChromeCookieRow,
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

  function encryptValue(domain: string, value: string, domainHashPrefix = false): Buffer {
    const key = pbkdf2Sync(KEYCHAIN_PASSWORD, 'saltysalt', 1003, 16, 'sha1')
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
      encryptValue(cookie.domain, cookie.value, cookie.domainHashPrefix),
      cookie.path ?? '/',
      cookie.expiresUtc ?? 0,
      cookie.secure ? 1 : 0,
      cookie.httpOnly ? 1 : 0,
      cookie.sameSite ?? -1,
    )
  }

  function read(domain?: string) {
    if (!database) throw new Error('Fixture database is not open')
    database.close()
    database = null
    return readChromeCookies({
      cookieDbPath: databasePath,
      domain,
      platform: 'darwin',
      readKeychainPassword: () => KEYCHAIN_PASSWORD,
      openCookieDatabase: openBunSqliteDatabase,
    })
  }

  function openBunSqliteDatabase(path: string): ChromeCookieDatabase {
    const copiedDatabase = new Database(path, { readonly: true })
    return {
      readCookies(sql, parameters) {
        return copiedDatabase.query(sql).all(...parameters) as ChromeCookieRow[]
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
})
