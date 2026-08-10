/**
 * Production-path harness for the Chrome cookie reader.
 *
 * `readChromeCookies` opens the cookie DB through `better-sqlite3`, which Bun
 * cannot instantiate (oven-sh/bun#4290), so every bun test so far injected a
 * fake database and the real `openBetterSqliteDatabase` path had never run.
 * This harness closes that gap: it is executed by
 * `chrome-cookie-reader.production-path.test.ts` in a Node child process —
 * the same runtime Electron main uses — against a real SQLite file in Chrome's
 * cookie schema, with no database seam injected.
 *
 * It also proves the AES key is wiped: `node:crypto` is patched through the
 * CommonJS module object before the reader is imported, so the very Buffer
 * `pbkdf2Sync` returned can be inspected after the read returns.
 *
 * Run: node --experimental-strip-types <this file> <workdir>
 * Prints a single JSON object on stdout.
 */

import { createRequire } from 'node:module'
import { mkdirSync, readdirSync, rmSync } from 'node:fs'
import { join } from 'node:path'

const KEYCHAIN_PASSWORD = 'harness-safe-storage-password'
const IV = Buffer.alloc(16, 0x20)

const workdir = process.argv[2]
if (!workdir) throw new Error('usage: harness <workdir>')

// Patch before ANY ESM import of `node:crypto`. Node instantiates the builtin's
// ESM facade once, reading the CJS module object's properties at that moment —
// so a static `import ... from 'node:crypto'` anywhere in this file would
// snapshot the real `pbkdf2Sync` and leave the key unobservable. Everything
// crypto- and reader-related below therefore goes through `require` or a
// dynamic import placed after this patch.
const nodeRequire = createRequire(import.meta.url)
const cryptoModule = nodeRequire('node:crypto')
const realPbkdf2Sync = cryptoModule.pbkdf2Sync
const derivedKeys: Buffer[] = []
cryptoModule.pbkdf2Sync = (...args: unknown[]) => {
  const key = realPbkdf2Sync(...args)
  derivedKeys.push(key)
  return key
}

const Database = nodeRequire('better-sqlite3')
// Deliberately dynamic — see the patch note above.
const { previewChromeCookies, readChromeCookies, sweepStaleCookieTempDirs } =
  await import('./chrome-cookie-reader.ts')

function encrypt(domain: string, value: string, options: {
  domainHashPrefix?: boolean
  password?: string
} = {}): Buffer {
  const key = realPbkdf2Sync(
    options.password ?? KEYCHAIN_PASSWORD,
    'saltysalt',
    1003,
    16,
    'sha1',
  )
  const prefix = options.domainHashPrefix
    ? cryptoModule.createHash('sha256').update(domain).digest()
    : Buffer.alloc(0)
  const cipher = cryptoModule.createCipheriv('aes-128-cbc', key, IV)
  return Buffer.concat([
    Buffer.from('v10'),
    cipher.update(Buffer.concat([prefix, Buffer.from(value, 'utf8')])),
    cipher.final(),
  ])
}

// -- Build a real Chrome-shaped cookie database ------------------------------

mkdirSync(workdir, { recursive: true })
const databasePath = join(workdir, 'Cookies')
rmSync(databasePath, { force: true })

const fixture = new Database(databasePath)
fixture.exec(`
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
const insert = fixture.prepare(`
  INSERT INTO cookies (
    host_key, name, encrypted_value, path, expires_utc,
    is_secure, is_httponly, samesite
  ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)
`)
insert.run('example.com', 'session', encrypt('example.com', 'known-value'), '/', 0, 1, 1, 2)
insert.run('.example.com', 'dotted', encrypt('.example.com', 'dot-value'), '/app', 13_400_000_000_000_000, 0, 0, 1)
insert.run(
  'shop.example.org',
  'sid',
  encrypt('shop.example.org', 'prefixed-value', { domainHashPrefix: true }),
  '/',
  0,
  1,
  0,
  0,
)
// Denylisted. Encrypted under a different password, so decrypting it would
// throw: if the reader ever touched it, this row would land in `skipped`
// instead of `blocked`.
insert.run(
  'accounts.google.com',
  'SID',
  encrypt('accounts.google.com', 'must-never-be-decrypted', { password: 'other-password' }),
  '/',
  0,
  1,
  1,
  1,
)
// Not a v10 payload at all — the per-row failure path.
insert.run('corrupt.example.net', 'broken', Buffer.from('not-encrypted'), '/', 0, 0, 0, -1)
fixture.close()

// -- Exercise the production path (no database seam injected) ----------------

const tempRootBefore = readdirSync(workdir)

const preview = previewChromeCookies({
  cookieDbPath: databasePath,
  platform: 'darwin',
})

const read = readChromeCookies({
  cookieDbPath: databasePath,
  platform: 'darwin',
  readKeychainPassword: () => KEYCHAIN_PASSWORD,
})

const customDenylist = readChromeCookies({
  cookieDbPath: databasePath,
  platform: 'darwin',
  denylist: ['shop.example.org'],
  readKeychainPassword: () => KEYCHAIN_PASSWORD,
})

// -- Leftover sweep against a real directory ---------------------------------

mkdirSync(join(workdir, 'craft-chrome-cookies-aaa'), { recursive: true })
mkdirSync(join(workdir, 'craft-chrome-cookies-bbb'), { recursive: true })
mkdirSync(join(workdir, 'unrelated-dir'), { recursive: true })

// A read still in flight must survive: both temp dirs were created just now,
// so nothing is old enough to remove.
const sweptWhileFresh = sweepStaleCookieTempDirs({
  root: workdir,
  maxAgeMs: 60_000,
  now: Date.now(),
})

// Same directories seen from an hour later: now they are leftovers.
const sweptWhenStale = sweepStaleCookieTempDirs({
  root: workdir,
  maxAgeMs: 60_000,
  now: Date.now() + 60 * 60 * 1000,
})

process.stdout.write(JSON.stringify({
  preview,
  read: {
    cookies: read.cookies,
    skipped: read.skipped,
    blocked: read.blocked,
  },
  customDenylist: {
    hosts: customDenylist.cookies.map(cookie => cookie.domain).sort(),
    blocked: customDenylist.blocked,
    skipped: customDenylist.skipped,
  },
  keyWipe: {
    derivedKeyCount: derivedKeys.length,
    allZeroed: derivedKeys.every(key => key.every(byte => byte === 0)),
  },
  tempCopies: {
    // The reader must not leave its temp copy behind in tmpdir; the workdir
    // itself only ever holds the fixture DB plus what this harness created.
    workdirUnchangedByReads: tempRootBefore.join(',') === 'Cookies',
  },
  sweep: {
    sweptWhileFresh,
    sweptWhenStale,
    remaining: readdirSync(workdir).sort(),
  },
}))
