/**
 * Partition hardening unit tests.
 *
 * Defends the F1.3 permission allow-set and handler wiring against the pure
 * decision + a properly-typed stub session (via the narrowed `PermissionSession`
 * surface) — no BrowserPaneManager, no `as any`/`as unknown as`, no reaching into
 * private state. BrowserPaneManager only adds the per-partition dedupe guard.
 */

import { describe, it, expect } from 'bun:test'
import { isBrowserPermissionAllowed, hardenSessionPermissions, type PermissionSession } from '../partition-hardening'

describe('isBrowserPermissionAllowed', () => {
  it('allows the agentic-browser permission set', () => {
    for (const p of ['geolocation', 'media', 'fullscreen', 'notifications', 'storage-access', 'top-level-storage-access']) {
      expect(isBrowserPermissionAllowed(p)).toBe(true)
    }
  })

  it('denies exfiltration-surface and unlisted permissions (clipboard-read, display-capture, ...)', () => {
    for (const p of ['clipboard-read', 'display-capture', 'background-sync', 'web-app-installation', 'anything-else']) {
      expect(isBrowserPermissionAllowed(p)).toBe(false)
    }
  })
})

describe('hardenSessionPermissions', () => {
  it('registers a check and request handler on the partition (F1.3 — per partition, not just the first)', () => {
    // Capture the registered handlers into properly-typed slots (derived from the
    // Electron session signature), so no cast is needed to prove registration.
    let checkHandler: Parameters<PermissionSession['setPermissionCheckHandler']>[0] = null
    let requestHandler: Parameters<PermissionSession['setPermissionRequestHandler']>[0] = null
    const ses: PermissionSession = {
      setPermissionCheckHandler(handler) { checkHandler = handler },
      setPermissionRequestHandler(handler) { requestHandler = handler },
    }

    hardenSessionPermissions(ses, { logDenied: () => {} })

    expect(checkHandler).not.toBeNull()
    expect(requestHandler).not.toBeNull()
  })

  it('registers independently for two distinct partitions (F1.3 regression guard)', () => {
    const registered: string[] = []
    const makeSes = (label: string): PermissionSession => ({
      setPermissionCheckHandler() { registered.push(`${label}:check`) },
      setPermissionRequestHandler() { registered.push(`${label}:request`) },
    })

    hardenSessionPermissions(makeSes('a'), { logDenied: () => {} })
    hardenSessionPermissions(makeSes('b'), { logDenied: () => {} })

    expect(registered).toEqual(['a:check', 'a:request', 'b:check', 'b:request'])
  })
})
