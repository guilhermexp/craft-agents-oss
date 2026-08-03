/**
 * BrowserTabContent
 *
 * The docked browser rendered as a tab inside the preview panel, beside file
 * and object tabs.
 *
 * This is a *frame with a hole*: React draws the surface, but the page itself
 * is a native WebContentsView the main process positions into the hole. The
 * component's only job is to measure that hole and report it.
 *
 * Two things are easy to get wrong and are handled here:
 *  - `getBoundingClientRect` is in renderer CSS px, while view bounds are window
 *    DIPs. On fractional-scale displays Electron zooms the renderer, so the main
 *    process resolves the zoom itself and converts.
 *  - The native view paints *over* React, so nothing rendered inside the hole
 *    would ever be visible, and anything the app draws on top of it is hidden.
 *
 * Lifetime is deliberately split. This component mounts only while its tab is
 * the active one, so it owns "is the browser on screen right now" — bounds and
 * view visibility. Docking and undocking belong to the tab's existence, not to
 * which tab is selected, and live in AppShell: switching to a file tab must not
 * fling the browser back into its own window.
 */

import { useCallback, useEffect, useRef } from 'react'
import { useTheme } from '@/context/ThemeContext'
import { OVERLAY_SELECTORS } from '@/lib/overlay-detection'
import { BROWSER_CHROME_BG } from '../../../shared/browser-chrome'

export function BrowserTabContent({ instanceId }: { instanceId: string }) {
  const { isDark } = useTheme()
  const holeRef = useRef<HTMLDivElement>(null)
  const lastRectRef = useRef<string>('')

  const reportBounds = useCallback(() => {
    const el = holeRef.current
    if (!el) return

    const rect = el.getBoundingClientRect()
    if (rect.width < 1 || rect.height < 1) return

    // Skip identical rects: every report triggers a native re-layout.
    const key = `${rect.x}|${rect.y}|${rect.width}|${rect.height}`
    if (key === lastRectRef.current) return
    lastRectRef.current = key

    void window.electronAPI.browserPane.setEmbeddedBounds(
      instanceId,
      { x: rect.x, y: rect.y, width: rect.width, height: rect.height },
    ).then(applied => {
      // Rejected because the browser had not finished docking yet. Forget the
      // rect or the retry with the same one is skipped and the views never get
      // bounds at all.
      if (!applied && lastRectRef.current === key) lastRectRef.current = ''
    })
  }, [instanceId])

  // Becoming the active tab: dock (idempotent when already docked) and only
  // then report, since the main process rejects bounds for a browser that is
  // not integrated yet.
  useEffect(() => {
    let cancelled = false
    void window.electronAPI.browserPane.setDisplayMode(instanceId, 'integrated').then(ok => {
      if (!ok || cancelled) return
      void window.electronAPI.browserPane.setViewsVisible(instanceId, true)
      reportBounds()
    })

    return () => {
      cancelled = true
      lastRectRef.current = ''
      // Another tab is taking the pane. The browser stays docked and simply
      // stops painting - its WebContents keeps running, so nothing reloads.
      void window.electronAPI.browserPane.setViewsVisible(instanceId, false)
    }
  }, [instanceId, reportBounds])

  // The hole moves for reasons a resize listener alone would miss (sidebar
  // collapse, panel splits), so observe the element itself and the window.
  useEffect(() => {
    const el = holeRef.current
    if (!el) return

    const observer = new ResizeObserver(reportBounds)
    observer.observe(el)
    window.addEventListener('resize', reportBounds)

    return () => {
      observer.disconnect()
      window.removeEventListener('resize', reportBounds)
    }
  }, [reportBounds])

  // A WebContentsView paints above the renderer, so an app dropdown that
  // reaches over the browser is drawn behind it. Nothing in CSS reaches the
  // native views - take them off screen for as long as such an overlay is up.
  //
  // Only overlaps count: a menu in the far sidebar must not blank the browser.
  // Radix and our Island primitive portal to the body, so watching the body's
  // own children catches every mount and unmount without a subtree observer
  // firing on each streamed token.
  useEffect(() => {
    let concealed = false
    const sync = () => {
      const el = holeRef.current
      if (!el) return
      const hole = el.getBoundingClientRect()
      const overlapped = Array.from(document.querySelectorAll(OVERLAY_SELECTORS.join(', '))).some(node => {
        const rect = node.getBoundingClientRect()
        return rect.width > 0 && rect.height > 0
          && rect.left < hole.right && rect.right > hole.left
          && rect.top < hole.bottom && rect.bottom > hole.top
      })
      if (overlapped === concealed) return
      concealed = overlapped
      void window.electronAPI.browserPane.setViewsVisible(instanceId, !overlapped)
    }

    const observer = new MutationObserver(sync)
    observer.observe(document.body, { childList: true })
    sync()

    return () => {
      observer.disconnect()
      // Leave visibility as the mount/unmount effect wants it, not as the last
      // overlay left it.
      if (concealed) void window.electronAPI.browserPane.setViewsVisible(instanceId, true)
    }
  }, [instanceId])

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
