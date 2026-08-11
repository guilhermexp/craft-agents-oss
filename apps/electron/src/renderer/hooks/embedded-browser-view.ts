/**
 * Embedded browser view mechanics
 *
 * The renderer-side half of docking a native browser into a React surface,
 * with no React and no DOM in it so the rules can be exercised directly.
 *
 * Two hosts share this: the session preview tab (`BrowserTabContent`) and the
 * Meetings page. They differ in exactly one thing — what letting go means.
 * A preview tab that loses the pane keeps the browser docked and merely stops
 * painting it, because docking follows the tab's existence, not which tab is
 * selected. A page that hosts the call owns the dock outright, so leaving the
 * page has to give the window back or the user is left with a browser they
 * cannot reach.
 */

export interface EmbeddedBrowserRect {
  x: number
  y: number
  width: number
  height: number
}

/** The slice of `window.electronAPI.browserPane` a host needs. */
export interface EmbeddedBrowserPaneApi {
  setDisplayMode: (instanceId: string, mode: 'floating' | 'integrated') => Promise<boolean>
  setEmbeddedBounds: (instanceId: string, rect: EmbeddedBrowserRect) => Promise<boolean>
  setViewsVisible: (instanceId: string, visible: boolean) => Promise<boolean>
}

/** What unmounting means for the host: see the file header. */
export type EmbeddedBrowserRelease = 'conceal' | 'floating'

/**
 * A WebContentsView paints above the renderer, so an app overlay reaching over
 * the hole is drawn behind it. Only overlaps count: a menu in the far sidebar
 * must not blank the browser.
 */
export function isConcealedByOverlays(
  hole: EmbeddedBrowserRect,
  overlays: readonly EmbeddedBrowserRect[],
): boolean {
  return overlays.some(overlay =>
    overlay.width > 0 && overlay.height > 0
    && hole.x < overlay.x + overlay.width && hole.x + hole.width > overlay.x
    && hole.y < overlay.y + overlay.height && hole.y + hole.height > overlay.y)
}

export interface EmbeddedBoundsReporter {
  report: (rect: EmbeddedBrowserRect | null) => void
  forget: () => void
}

/**
 * Reports the hole's geometry, skipping rects identical to the last accepted
 * one — every report costs a native re-layout. Sub-pixel holes are a
 * mid-layout artefact, not geometry worth reporting.
 *
 * The rect is re-read into a literal before it crosses the bridge.
 * `getBoundingClientRect()` returns a `DOMRect`, whose every field is a
 * prototype accessor, and contextBridge copies own enumerable properties only:
 * passing the `DOMRect` through lands `{}` in the main process, and each axis
 * floors to `NaN`, which Chromium clamps to a 0x0 view. The panel then shows
 * its empty hole with no browser in it.
 */
export function createEmbeddedBoundsReporter(
  api: EmbeddedBrowserPaneApi,
  instanceId: string,
): EmbeddedBoundsReporter {
  let lastKey = ''

  return {
    report(rect) {
      if (!rect || rect.width < 1 || rect.height < 1) return

      const key = `${rect.x}|${rect.y}|${rect.width}|${rect.height}`
      if (key === lastKey) return
      lastKey = key

      void api.setEmbeddedBounds(instanceId, {
        x: rect.x,
        y: rect.y,
        width: rect.width,
        height: rect.height,
      }).then(applied => {
        // Rejected because the browser had not finished docking yet. Forget the
        // rect or the retry with the same one is skipped and the views never
        // get bounds at all.
        if (!applied && lastKey === key) lastKey = ''
      })
    },
    forget() {
      lastKey = ''
    },
  }
}

/**
 * Dock (idempotent when already docked) and reveal. Bounds must wait for the
 * resolved `true`: the main process rejects them for a browser that is not
 * integrated yet.
 *
 * `isCancelled` is re-checked after the round trip. A host that unmounted while
 * docking was in flight has already concealed the views, and revealing them
 * afterwards would leave a browser painting over a surface that is gone.
 */
export async function dockEmbeddedBrowser(
  api: EmbeddedBrowserPaneApi,
  instanceId: string,
  isCancelled?: () => boolean,
): Promise<boolean> {
  const docked = await api.setDisplayMode(instanceId, 'integrated')
  if (!docked || isCancelled?.()) return false
  void api.setViewsVisible(instanceId, true)
  return true
}

/**
 * `'conceal'` keeps the dock and stops painting; the WebContents keeps running,
 * so nothing reloads. `'floating'` hands the window back — the main process
 * re-shows it and clears concealment itself, so no visibility call is needed.
 */
export function releaseEmbeddedBrowser(
  api: EmbeddedBrowserPaneApi,
  instanceId: string,
  release: EmbeddedBrowserRelease,
): void {
  if (release === 'floating') {
    void api.setDisplayMode(instanceId, 'floating')
    return
  }
  void api.setViewsVisible(instanceId, false)
}
