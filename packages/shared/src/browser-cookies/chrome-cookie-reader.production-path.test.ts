/**
 * Exercises the reader's PRODUCTION database path.
 *
 * Every other test in this directory injects a fake `ChromeCookieDatabase`,
 * so `openBetterSqliteDatabase` — the code that actually runs when the user
 * clicks "Import from Chrome" — was never executed by a test. Bun cannot
 * instantiate `better-sqlite3` (oven-sh/bun#4290), so this suite drives a
 * child process instead: Electron-as-Node when available (the ABI the addon
 * is built for), plain `node` otherwise, real `better-sqlite3`, real SQLite
 * file in Chrome's cookie schema, no seam injected.
 *
 * The harness lives in `chrome-cookie-reader.node-harness.ts`.
 */

import { describe, expect, it, beforeAll, afterAll } from 'bun:test'
import { existsSync, mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

interface HarnessResult {
  preview: {
    cookies: number
    hosts: number
    blockedCookies: number
    blockedHosts: number
  }
  read: {
    cookies: Array<{
      name: string
      value: string
      domain: string
      path: string
      secure: boolean
      httpOnly: boolean
      expirationDate?: number
      sameSite: number
    }>
    skipped: number
    blocked: number
  }
  customDenylist: {
    hosts: string[]
    blocked: number
    skipped: number
  }
  keyWipe: {
    derivedKeyCount: number
    allZeroed: boolean
  }
  tempCopies: {
    workdirUnchangedByReads: boolean
  }
  sweep: {
    sweptWhileFresh: number
    sweptWhenStale: number
    remaining: string[]
  }
}

const HARNESS = join(import.meta.dir, 'chrome-cookie-reader.node-harness.ts')

/**
 * Run the harness under the SAME Node ABI the app ships with.
 *
 * `better-sqlite3` is a native addon and this repo builds it for Electron
 * (NODE_MODULE_VERSION 148). Spawning the system `node` (ABI 127) makes the
 * addon refuse to load with ERR_DLOPEN_FAILED, so the test would report the
 * production path as broken on exactly the machines set up to ship it.
 * Electron with ELECTRON_RUN_AS_NODE=1 is plain Node on the right ABI.
 */
function resolveHarnessRuntime(): { command: string[]; env: Record<string, string> } {
  try {
    const electronBinary = require('electron') as unknown
    if (typeof electronBinary === 'string' && existsSync(electronBinary)) {
      return {
        command: [electronBinary, '--no-warnings', '--experimental-strip-types', HARNESS],
        env: { ...process.env, ELECTRON_RUN_AS_NODE: '1' } as Record<string, string>,
      }
    }
  } catch {
    // Electron not installed (CI without the binary download) — fall through.
  }
  return {
    command: ['node', '--no-warnings', '--experimental-strip-types', HARNESS],
    env: process.env as Record<string, string>,
  }
}

describe('readChromeCookies over real better-sqlite3', () => {
  let workdir: string
  let harness: HarnessResult

  beforeAll(async () => {
    workdir = mkdtempSync(join(tmpdir(), 'craft-cookie-prod-path-'))
    const runtime = resolveHarnessRuntime()
    const proc = Bun.spawn(
      [...runtime.command, workdir],
      { stdout: 'pipe', stderr: 'pipe', env: runtime.env },
    )
    const [stdout, stderr, exitCode] = await Promise.all([
      new Response(proc.stdout).text(),
      new Response(proc.stderr).text(),
      proc.exited,
    ])
    if (exitCode !== 0) {
      throw new Error(`harness exited ${exitCode}\n${stderr}`)
    }
    harness = JSON.parse(stdout) as HarnessResult
  })

  afterAll(() => {
    rmSync(workdir, { recursive: true, force: true })
  })

  it('decrypts every importable row through the real SQLite driver', () => {
    expect(harness.read.cookies).toEqual([
      {
        name: 'session',
        value: 'known-value',
        domain: 'example.com',
        path: '/',
        secure: true,
        httpOnly: true,
        sameSite: 2,
      },
      {
        name: 'dotted',
        value: 'dot-value',
        domain: '.example.com',
        path: '/app',
        secure: false,
        httpOnly: false,
        expirationDate: 1_755_526_400,
        sameSite: 1,
      },
      {
        name: 'sid',
        // Written with the 32-byte domain-hash prefix recent Chrome adds; the
        // exact value proves the prefix was stripped rather than mangled.
        value: 'prefixed-value',
        domain: 'shop.example.org',
        path: '/',
        secure: true,
        httpOnly: false,
        sameSite: 0,
      },
    ])
  })

  it('counts an undecryptable row as skipped without aborting the read', () => {
    expect(harness.read.skipped).toBe(1)
  })

  it('never decrypts a denylisted host', () => {
    // The `accounts.google.com` row is encrypted under a different password,
    // so any attempt to decrypt it throws and would land in `skipped`.
    // Landing in `blocked` instead is the proof it was dropped first.
    expect(harness.read).toMatchObject({ blocked: 1, skipped: 1 })
  })

  it('honors a caller-supplied denylist instead of the default', () => {
    // With only `shop.example.org` denied, the Google row is no longer withheld
    // and now fails decryption — skipped goes 1 -> 2.
    expect(harness.customDenylist).toEqual({
      hosts: ['.example.com', 'example.com'],
      blocked: 1,
      skipped: 2,
    })
  })

  it('previews counts without decrypting anything or reading the Keychain', () => {
    // The harness passes no `readKeychainPassword` to the preview: if the
    // preview needed the password it would hit the real Keychain and fail.
    // Four importable rows (the corrupt one is indistinguishable before
    // decryption) across three hosts, once `.example.com` folds into
    // `example.com`.
    expect(harness.preview).toEqual({
      cookies: 4,
      hosts: 3,
      blockedCookies: 1,
      blockedHosts: 1,
    })
  })

  it('zeroes the derived AES key once the read returns', () => {
    // Guards against a vacuous pass: the harness must have observed the real
    // pbkdf2 output for `allZeroed` to mean anything.
    expect(harness.keyWipe.derivedKeyCount).toBeGreaterThan(0)
    expect(harness.keyWipe.allZeroed).toBe(true)
  })

  it('leaves no temp copy of the cookie database behind', () => {
    expect(harness.tempCopies.workdirUnchangedByReads).toBe(true)
  })

  it('sweeps only stale craft cookie temp dirs', () => {
    expect(harness.sweep.sweptWhileFresh).toBe(0)
    expect(harness.sweep.sweptWhenStale).toBe(2)
    expect(harness.sweep.remaining).toEqual(['Cookies', 'unrelated-dir'])
  })
})
