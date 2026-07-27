/**
 * Partition hardening for the agentic browser.
 *
 * SECURITY (auditoria 2026-07-14 / F1.3): every browser partition must register
 * a permission handler — the old boolean guard only configured the FIRST
 * partition, so a second one fell through to Electron's permissive default. This
 * module is the pure decision (`isBrowserPermissionAllowed`) plus the handler
 * wiring (`hardenSessionPermissions`), both unit-testable with a stub session.
 * `BrowserPaneManager` keeps the per-partition dedupe guard and the
 * instance-coupled bits (display-media, network/download observers).
 */

import type { Session as ElectronSession } from 'electron'

/** The Electron session surface partition hardening touches (permission handlers). */
export type PermissionSession = Pick<ElectronSession, 'setPermissionCheckHandler' | 'setPermissionRequestHandler'>

/**
 * Permissions the agentic browser grants. Everything else is denied by design.
 * clipboard-read and display-capture are intentionally absent (exfiltration
 * surface); storage-access is present so embedded Google sign-in / Meet work.
 */
const ALLOWED_PERMISSIONS: Record<string, true> = {
  fullscreen: true,
  pointerLock: true,
  'window-management': true,
  notifications: true,
  geolocation: true,
  media: true,
  'speaker-selection': true,
  'screen-wake-lock': true,
  'clipboard-sanitized-write': true,
  'idle-detection': true,
  'storage-access': true,
  'top-level-storage-access': true,
}

/** F1.3 decision: is this permission on the agentic-browser allow-set? */
export function isBrowserPermissionAllowed(permission: string): boolean {
  return ALLOWED_PERMISSIONS[permission] === true
}

export interface PermissionHardeningDeps {
  /** Record a denied permission (deduped/leveled by the caller). */
  logDenied(kind: 'check' | 'request', permission: string, origin: string): void
}

/**
 * Register the permission check + request handlers on an Electron partition so
 * only allow-set permissions are granted. Idempotency across partitions is the
 * caller's concern (a per-session guard); this always registers.
 */
export function hardenSessionPermissions(ses: PermissionSession, deps: PermissionHardeningDeps): void {
  if (typeof ses.setPermissionCheckHandler === 'function') {
    ses.setPermissionCheckHandler((_webContents, permission, requestingOrigin) => {
      const allowed = isBrowserPermissionAllowed(permission)
      if (!allowed) deps.logDenied('check', permission, requestingOrigin)
      return allowed
    })
  }

  if (typeof ses.setPermissionRequestHandler === 'function') {
    ses.setPermissionRequestHandler((_webContents, permission, callback, details) => {
      const allowed = isBrowserPermissionAllowed(permission)
      if (!allowed) deps.logDenied('request', permission, details?.requestingUrl ?? 'unknown')
      callback(allowed)
    })
  }
}
