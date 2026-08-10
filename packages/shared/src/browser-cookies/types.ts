export type BrowserCookieSameSite = -1 | 0 | 1 | 2

export interface BrowserCookie {
  name: string
  value: string
  domain: string
  path: string
  secure: boolean
  httpOnly: boolean
  expirationDate?: number
  sameSite: BrowserCookieSameSite
}

export interface BrowserCookieReadResult {
  cookies: BrowserCookie[]
  skipped: number
  /** Rows whose host is on the denylist. Never decrypted, never counted as skipped. */
  blocked: number
}

/**
 * Counts shown to the user before the import is confirmed. Produced by a pass
 * that reads `host_key` only, so it neither decrypts a value nor needs the
 * Keychain password (no prompt before the user has agreed to anything).
 */
export interface BrowserCookieImportPreview {
  /** Cookies that would be imported. */
  cookies: number
  /** Distinct hosts among those cookies. */
  hosts: number
  /** Cookies withheld by the denylist. */
  blockedCookies: number
  /** Distinct hosts among the withheld cookies. */
  blockedHosts: number
}

/**
 * Why a cookie import (or its preview) was refused. The RPC layer cannot carry
 * a structured error, so the handler throws `PREFIX + reason` and the renderer
 * maps the reason to a distinct message. Only the reason ever crosses the
 * boundary — never a host, a cookie name, or a raw error string.
 */
export type BrowserCookieImportFailureReason =
  | 'user-only-required'
  | 'unsupported-platform'
  | 'invalid-profile'
  | 'cookie-db-not-found'
  | 'keychain-read-failed'
  | 'cookie-db-read-failed'
  | 'unknown'

export const COOKIE_IMPORT_FAILURE_PREFIX = 'browser-cookie-import:'
