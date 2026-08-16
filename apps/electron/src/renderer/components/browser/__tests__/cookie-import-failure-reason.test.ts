import { describe, expect, it } from 'bun:test'
import { COOKIE_IMPORT_FAILURE_PREFIX } from '@craft-agent/shared/browser-cookies/types'
import { cookieImportFailureReason } from '../BrowserProfilePicker'

const PREFIX = COOKIE_IMPORT_FAILURE_PREFIX

describe('cookieImportFailureReason', () => {
  it('round-trips every real failure reason', () => {
    const reasons = [
      'user-only-required',
      'unsupported-platform',
      'invalid-profile',
      'cookie-db-not-found',
      'keychain-read-failed',
      'cookie-db-read-failed',
      'unknown',
    ] as const
    for (const reason of reasons) {
      expect(cookieImportFailureReason(new Error(`${PREFIX}${reason}`))).toBe(reason)
    }
  })

  it('collapses prototype-chain keys to unknown', () => {
    // `in` would reach Object.prototype and let these masquerade as reasons,
    // rendering a nonexistent i18n key to the user. The membership test must
    // be own-property only.
    for (const hostile of ['constructor', '__proto__', 'toString']) {
      expect(cookieImportFailureReason(new Error(`${PREFIX}${hostile}`))).toBe('unknown')
    }
  })

  it('collapses a message that only contains the prefix (not at the start) to unknown', () => {
    expect(cookieImportFailureReason(new Error(`prefixed ${PREFIX}invalid-profile`))).toBe('unknown')
  })

  it('collapses a non-Error value to unknown', () => {
    expect(cookieImportFailureReason('not an error')).toBe('unknown')
  })
})
