/**
 * Browser dock routing
 *
 * A browser's own toolbar asks the app to dock or undock it. The app has two
 * surfaces that can hold a docked browser, and neither is always available:
 *
 *  - the preview panel beside a chat, which is session-scoped — with nothing
 *    selected there is nowhere to put it;
 *  - the Meetings page, which owns the main content area while it is open and
 *    hosts the call itself (D-06: the chat preview stays session-scoped).
 *
 * The Meetings page wins whenever it is open, because it is what the user is
 * looking at: docking into a preview panel the page is covering would be a
 * browser the user cannot see. Refusing beats docking into a pane that will not
 * render.
 */

export interface BrowserDockRequest {
  instanceId: string
  mode: 'floating' | 'integrated'
}

export interface BrowserDockContext {
  workspaceId: string | null
  /** Session the preview panel would open the tab for, if any. */
  previewSessionId: string | null
  /** The Meetings page is the active navigation target. */
  meetingsActive: boolean
}

export type BrowserDockRoute =
  /** Nowhere to host it: leave the browser in its own window. */
  | { kind: 'ignore' }
  /** Open a browser tab in the session-scoped preview panel. */
  | { kind: 'preview-tab' }
  /** Let the Meetings page host it. */
  | { kind: 'meetings-host' }
  /** Undock: close the preview tab and drop the Meetings host. */
  | { kind: 'release' }

export function resolveBrowserDockRoute(
  request: BrowserDockRequest,
  context: BrowserDockContext,
): BrowserDockRoute {
  if (!context.workspaceId) return { kind: 'ignore' }
  if (request.mode !== 'integrated') return { kind: 'release' }
  if (context.meetingsActive) return { kind: 'meetings-host' }
  if (!context.previewSessionId) return { kind: 'ignore' }
  return { kind: 'preview-tab' }
}
