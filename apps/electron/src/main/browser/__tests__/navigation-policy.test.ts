/**
 * Navigation policy unit tests.
 *
 * These defend the F7/R1 scheme allowlist and the deep-link / custom-policy
 * ordering against the pure decision functions — no Electron window, no reaching
 * into private `_listeners`. BrowserPaneManager's handlers only wire these in.
 */

import { describe, it, expect } from 'bun:test'
import {
  isAllowedTopLevelUrl,
  isDeepLinkUrl,
  decideWillNavigate,
  decideWindowOpen,
  CRAFT_DEEPLINK_SCHEME_PREFIX,
} from '../navigation-policy'
import type { BrowserNavigationPolicy } from '../../browser-pane-manager'

describe('isAllowedTopLevelUrl', () => {
  it('allows http, https and about:blank', () => {
    expect(isAllowedTopLevelUrl('https://example.com')).toBe(true)
    expect(isAllowedTopLevelUrl('http://example.com/x?y=1')).toBe(true)
    expect(isAllowedTopLevelUrl('about:blank')).toBe(true)
  })

  it('blocks file/chrome/data and other local schemes (SSRF / local-file read)', () => {
    expect(isAllowedTopLevelUrl('file:///etc/passwd')).toBe(false)
    expect(isAllowedTopLevelUrl('chrome://settings')).toBe(false)
    expect(isAllowedTopLevelUrl('data:text/html,<h1>x')).toBe(false)
    expect(isAllowedTopLevelUrl('not a url')).toBe(false)
  })
})

describe('isDeepLinkUrl', () => {
  it('matches the craft deep-link scheme only', () => {
    expect(isDeepLinkUrl(`${CRAFT_DEEPLINK_SCHEME_PREFIX}settings`)).toBe(true)
    expect(isDeepLinkUrl('https://example.com')).toBe(false)
  })
})

describe('decideWillNavigate', () => {
  it('honors a custom policy deny before anything else', () => {
    const policy: BrowserNavigationPolicy = { willNavigate: () => ({ action: 'deny', reason: 'blocked-host' }) }
    expect(decideWillNavigate('https://ok.com', policy)).toEqual({ action: 'deny', reason: 'blocked-host' })
  })

  it('honors a custom policy external redirect', () => {
    const policy: BrowserNavigationPolicy = { willNavigate: () => ({ action: 'external' }) }
    expect(decideWillNavigate('https://ok.com', policy)).toEqual({ action: 'external' })
  })

  it('routes deep links after the policy defers', () => {
    expect(decideWillNavigate(`${CRAFT_DEEPLINK_SCHEME_PREFIX}settings`)).toEqual({ action: 'deep-link' })
  })

  it('denies a forbidden scheme with unsupported_scheme', () => {
    expect(decideWillNavigate('file:///etc/passwd')).toEqual({ action: 'deny', reason: 'unsupported_scheme' })
  })

  it('allows a normal https navigation', () => {
    expect(decideWillNavigate('https://ok.com/')).toEqual({ action: 'allow' })
  })
})

describe('decideWindowOpen', () => {
  it('intercepts deep links before the custom policy runs', () => {
    const policy: BrowserNavigationPolicy = { windowOpen: () => ({ action: 'deny', reason: 'should-not-run' }) }
    expect(decideWindowOpen(`${CRAFT_DEEPLINK_SCHEME_PREFIX}settings`, policy)).toEqual({ action: 'deep-link' })
  })

  it('denies a forbidden popup scheme', () => {
    expect(decideWindowOpen('file:///Users/victim/.aws/credentials')).toEqual({ action: 'deny', reason: 'unsupported_scheme' })
  })

  it('allows an https popup', () => {
    expect(decideWindowOpen('https://accounts.example.com/signin')).toEqual({ action: 'allow' })
  })
})
