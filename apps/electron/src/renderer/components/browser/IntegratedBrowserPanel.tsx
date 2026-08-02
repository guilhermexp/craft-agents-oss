/**
 * IntegratedBrowserPanel
 *
 * The browser docked as a panel in the app's panel stack — same edge inset,
 * same 6px gutter, same corner radius and shadow as the session and preview
 * panels beside it. Not an overlay: it takes its width out of the layout, so
 * the chat next to it stays usable instead of being covered by a scrim.
 *
 * The panel is a *frame with a hole*: React draws the surface, but the page
 * itself is a native WebContentsView the main process positions into the hole.
 * This component's only job is to measure that hole and report it.
 *
 * Two things are easy to get wrong and are handled here:
 *  - `getBoundingClientRect` is in renderer CSS px, while view bounds are window
 *    DIPs. On fractional-scale displays Electron zooms the renderer, so the
 *    zoom factor has to travel with the rect (the main process multiplies).
 *  - The native view paints *over* React, so nothing rendered inside the hole
 *    would ever be visible. Chrome must live outside it.
 */

import { useCallback, useEffect, useEffectEvent, useRef } from 'react'
import { useAtomValue } from 'jotai'
import { browserInstancesAtom } from '../../atoms/browser-pane'
import { useTheme } from '@/context/ThemeContext'
import { RADIUS_EDGE, RADIUS_INNER } from '../app-shell/panel-constants'
import { BROWSER_CHROME_BG } from '../../../shared/browser-chrome'

interface IntegratedBrowserPanelProps {
  /** Instance to embed. */
  instanceId?: string | null
  /** Panel width in CSS px, owned by the shell like any other panel width. */
  width: number
  /**
   * True when nothing sits between this panel and the window's right edge, so
   * its bottom-right corner has to follow the window's rounding like the right
   * sidebar's does.
   */
  isLastPanel: boolean
  open: boolean
  onClose: () => void
}

export function IntegratedBrowserPanel({ instanceId, width, isLastPanel, open, onClose }: IntegratedBrowserPanelProps) {
  // No fallback to the active instance: an implicit target meant the panel
  // could stay up pointing at a browser the user never chose to embed.
  const id = instanceId ?? null
  const { isDark } = useTheme()
  const instances = useAtomValue(browserInstancesAtom)
  const instanceExists = !!id && instances.some(i => i.id === id)
  const holeRef = useRef<HTMLDivElement>(null)
  const lastRectRef = useRef<string>('')

  const onCloseEvent = useEffectEvent(onClose)

  // The instance can die from the browser's own toolbar ("Close Window
  // Entirely") or a crash, which the panel would never hear about otherwise.
  useEffect(() => {
    if (open && id && !instanceExists) onCloseEvent()
  }, [open, id, instanceExists])

  const reportBounds = useCallback(() => {
    const el = holeRef.current
    if (!el || !id) return

    const rect = el.getBoundingClientRect()
    if (rect.width < 1 || rect.height < 1) return

    // Skip identical rects: every report triggers a native re-layout.
    const key = `${rect.x}|${rect.y}|${rect.width}|${rect.height}`
    if (key === lastRectRef.current) return
    lastRectRef.current = key

    // Only the rect travels: the main process resolves this window's zoom
    // factor itself and converts CSS px → DIPs.
    void window.electronAPI.browserPane.setEmbeddedBounds(
      id,
      { x: rect.x, y: rect.y, width: rect.width, height: rect.height },
      RADIUS_INNER,
    )
  }, [id])

  // Enter/leave integrated mode with the panel's lifetime.
  useEffect(() => {
    if (!id) return

    if (!open) {
      void window.electronAPI.browserPane.setDisplayMode(id, 'floating')
      return
    }

    let cancelled = false
    void window.electronAPI.browserPane.setDisplayMode(id, 'integrated').then(ok => {
      if (ok && !cancelled) reportBounds()
    })

    return () => {
      cancelled = true
      lastRectRef.current = ''
      void window.electronAPI.browserPane.setDisplayMode(id, 'floating')
    }
  }, [id, open, reportBounds])

  // The hole moves for reasons a resize listener alone would miss (sidebar
  // collapse, panel splits), so observe the element itself and the window.
  useEffect(() => {
    if (!open || !id) return

    const el = holeRef.current
    if (!el) return

    const observer = new ResizeObserver(reportBounds)
    observer.observe(el)
    window.addEventListener('resize', reportBounds)

    return () => {
      observer.disconnect()
      window.removeEventListener('resize', reportBounds)
    }
  }, [open, id, reportBounds])

  if (!open || !id || !instanceExists) return null

  return (
    <aside
      data-panel-role="integrated-browser"
      className="h-full shrink-0 overflow-hidden shadow-middle relative z-panel"
      style={{
        width,
        // Same treatment as the right sidebar: interior radius everywhere, and
        // the window's larger radius only on the corner that touches it.
        borderTopLeftRadius: RADIUS_INNER,
        borderBottomLeftRadius: RADIUS_INNER,
        borderTopRightRadius: RADIUS_INNER,
        borderBottomRightRadius: isLastPanel ? RADIUS_EDGE : RADIUS_INNER,
      }}
    >
      {/* The hole. Nothing may render inside: the native views paint over it.
          Painted rather than transparent because the toolbar and the page are
          separate rounded siblings — the seam between them exposes whatever is
          behind, and chrome-coloured that reads as part of the browser. */}
      <div
        ref={holeRef}
        className="h-full w-full"
        style={{ background: BROWSER_CHROME_BG[isDark ? 'dark' : 'light'] }}
      />
    </aside>
  )
}
