/**
 * IntegratedBrowserCard
 *
 * Renders the browser as a card inside the app instead of a separate OS window.
 *
 * The card is a *frame with a hole*: React draws the scrim, the rounded glass
 * edge and the shadow, but the page itself is a native WebContentsView the main
 * process positions into the hole. This component's only job is to measure that
 * hole and report it — the same contract vision-ui uses (see its
 * electron/main.cjs, `desktop-browser:set-bounds`).
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
import { X } from 'lucide-react'
import { browserInstancesAtom } from '../../atoms/browser-pane'
import { useTheme } from '@/context/ThemeContext'
import { BROWSER_CHROME_BG } from '../../../shared/browser-chrome'

/** Matches --vision-radius-card / the DESIGN.md §5.5 card radius. */
const CARD_RADIUS = 32
/** DESIGN.md §5.5: 32px horizontal, 40px vertical around the card. */
const CARD_INSET_X = 32
const CARD_INSET_Y = 40

interface IntegratedBrowserCardProps {
  /** Instance to embed. Falls back to the active one. */
  instanceId?: string | null
  open: boolean
  onClose: () => void
}

export function IntegratedBrowserCard({ instanceId, open, onClose }: IntegratedBrowserCardProps) {
  // No fallback to the active instance: an implicit target meant the overlay
  // could stay up pointing at a browser the user never chose to embed.
  const id = instanceId ?? null
  const { isDark } = useTheme()
  const instances = useAtomValue(browserInstancesAtom)
  const instanceExists = !!id && instances.some(i => i.id === id)
  const holeRef = useRef<HTMLDivElement>(null)
  const lastRectRef = useRef<string>('')

  const onCloseEvent = useEffectEvent(onClose)

  // Escape always dismisses. The card covers the whole window, so it must never
  // be the only thing between the user and their app.
  useEffect(() => {
    if (!open) return
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') onCloseEvent()
    }
    window.addEventListener('keydown', onKeyDown)
    return () => { window.removeEventListener('keydown', onKeyDown) }
  }, [open])

  // The instance can die from the browser's own toolbar ("Close Window
  // Entirely") or a crash, which the card would never hear about otherwise.
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
      CARD_RADIUS,
    )
  }, [id])

  // Enter/leave integrated mode with the card's lifetime.
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
    <div
      className="fixed inset-0 z-overlay flex flex-col"
      style={{ padding: `${CARD_INSET_Y}px ${CARD_INSET_X}px` }}
    >
      {/* §5.5 overlay: black/.20 scrim over a 12px blur, plus a vertical
          white/.10 → transparent → black/.20 gradient for depth. */}
      <button
        type="button"
        aria-label="Close browser"
        onClick={onClose}
        className="absolute inset-0 cursor-default bg-black/20 backdrop-blur-[12px]"
        style={{
          backgroundImage:
            'linear-gradient(to bottom, rgb(255 255 255 / 0.10), transparent 40%, rgb(0 0 0 / 0.20))',
        }}
      />

      {/* Visible way out. The scrim is also clickable, but an invisible click
          target is not an affordance — Escape works too. */}
      <button
        type="button"
        aria-label="Close browser card"
        onClick={onClose}
        className="absolute right-3 top-3 z-10 flex size-8 items-center justify-center rounded-full border border-white/20 bg-black/40 text-white/80 transition hover:bg-black/60 hover:text-white"
      >
        <X className="size-4" />
      </button>

      {/* The hole. Nothing may render inside: the native view paints over it.

          It is painted rather than transparent because the native views do not
          tile it perfectly — the toolbar, page and session panel are separate
          rounded siblings, so every seam between them exposes a sliver of
          whatever is behind. Chrome-coloured, those slivers read as dividers;
          transparent, they read as holes onto the app. */}
      <div
        ref={holeRef}
        className="relative flex-1 overflow-hidden border border-white/20 shadow-[0_24px_60px_rgb(0_0_0/0.35)]"
        style={{ borderRadius: CARD_RADIUS, background: BROWSER_CHROME_BG[isDark ? 'dark' : 'light'] }}
      />
    </div>
  )
}
