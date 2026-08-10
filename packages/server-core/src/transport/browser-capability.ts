/**
 * Wire protocol for the `client:browser:invoke` capability.
 *
 * The remote `RemoteBrowserPaneManager` packages an `IBrowserPaneManager`
 * method call into a `BrowserCapabilityRequest` and the local dispatcher
 * (Electron main IPC) executes it on the real `BrowserPaneManager`.
 *
 * See docs/adr-transport-locality.md for the locality boundary definition.
 */

import type { IBrowserPaneManager } from '../handlers/browser-pane-manager-interface'

export const BROWSER_CAPABILITY_VERSION = 1

/**
 * Wire method names for the `client:browser:invoke` capability.
 *
 * DERIVED from `IBrowserPaneManager` so a new capability never restates this
 * list — add the method to the interface and it appears here automatically.
 * `setSessionPathResolver` and `assertEvaluateAllowed` are local-only (never
 * cross the wire), so they are the excluded keys. Positional `args` carry the
 * method's arguments in declaration order.
 *
 * PROTOCOL SAFETY: because this type is DERIVED, renaming an interface method
 * silently renames the wire method too — a breaking change that still ships
 * `v: 1`, so a new server × old desktop (or the reverse) fails at runtime with
 * `Unknown browser capability method` and there is NO compile-time signal. The
 * wire-name set is frozen by a snapshot test ("freezes the client:browser:invoke
 * wire method names") in `apps/electron/.../browser-pane-manager.test.ts`, whose
 * assertion runs over the compiler-exhaustive `capabilityDispatch` keys. Any
 * rename MUST update that snapshot AND bump `BROWSER_CAPABILITY_VERSION` — that
 * turns a silent production break into a caught test failure.
 */
export type BrowserCapabilityMethod = Exclude<keyof IBrowserPaneManager, 'setSessionPathResolver' | 'assertEvaluateAllowed'>

export interface BrowserCapabilityRequest {
  /** Protocol version. Always `1` for now; bumped on breaking shape changes. */
  v: 1
  method: BrowserCapabilityMethod
  /** Positional args matching `IBrowserPaneManager[method]` signature. */
  args: unknown[]
  /** Owning session — used for owner-key namespacing on the client dispatcher. */
  sessionId: string
  /** Owning workspace — combined with `sessionId` to form the owner-key prefix. */
  workspaceId: string
}

/**
 * Wire shape for `screenshot` / `screenshotRegion` results.
 *
 * The local `BrowserScreenshotResult` carries a Node `Buffer` for `imageBuffer`,
 * which doesn't survive structured cloning over WS. The dispatcher converts
 * `Buffer → Uint8Array` here, and `RemoteBrowserPaneManager` converts it back.
 */
export interface ScreenshotResultWire {
  imageFormat: 'png' | 'jpeg'
  imageBytes: Uint8Array
  metadata?: Record<string, unknown>
}
