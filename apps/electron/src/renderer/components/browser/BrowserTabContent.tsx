/**
 * BrowserTabContent
 *
 * The docked browser rendered as a tab inside the preview panel, beside file
 * and object tabs.
 *
 * This is a *frame with a hole*: React draws the surface, but the page itself
 * is a native WebContentsView the main process positions into the hole. The
 * component's only job is to measure that hole and report it — the measuring,
 * zoom conversion and overlay concealment live in `useEmbeddedBrowserView`,
 * shared with the Meetings page host.
 *
 * Lifetime is deliberately split. This component mounts only while its tab is
 * the active one, so it owns "is the browser on screen right now" — bounds and
 * view visibility. Docking and undocking belong to the tab's existence, not to
 * which tab is selected, and live in AppShell: switching to a file tab must not
 * fling the browser back into its own window. That is why unmounting only
 * conceals ('conceal'), while a host that owns the dock releases to 'floating'.
 */

import { useTheme } from '@/context/ThemeContext'
import { useEmbeddedBrowserView } from '@/hooks/useEmbeddedBrowserView'
import { BROWSER_CHROME_BG } from '../../../shared/browser-chrome'

export function BrowserTabContent({ instanceId }: { instanceId: string }) {
  const { isDark } = useTheme()
  const holeRef = useEmbeddedBrowserView({ instanceId, release: 'conceal' })

  return (
    // The hole. Nothing may render inside: the native views paint over it.
    // Painted rather than transparent because the toolbar and the page are
    // separate rounded siblings - the seam between them exposes whatever is
    // behind, and chrome-coloured that reads as part of the browser.
    <div
      ref={holeRef}
      className="h-full w-full"
      style={{ background: BROWSER_CHROME_BG[isDark ? 'dark' : 'light'] }}
    />
  )
}
