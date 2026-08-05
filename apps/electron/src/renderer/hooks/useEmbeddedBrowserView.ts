/**
 * useEmbeddedBrowserView
 *
 * Wires a React element to a docked native browser: measure the hole, report
 * it, keep it in sync while the layout moves, and hide the views while an app
 * overlay reaches over them. The rules themselves live in
 * `embedded-browser-view.ts`; this file is only the React and DOM plumbing.
 *
 * The element the returned ref is attached to is a *hole*: the native views
 * paint over it, so nothing rendered inside it can ever be seen.
 *
 * `getBoundingClientRect` is in renderer CSS px while view bounds are window
 * DIPs. On fractional-scale displays Electron zooms the renderer, so the main
 * process resolves the zoom itself and converts — this side reports CSS px.
 */

import { useCallback, useEffect, useMemo, useRef, type RefObject } from 'react'
import { OVERLAY_SELECTORS } from '@/lib/overlay-detection'
import {
  createEmbeddedBoundsReporter,
  dockEmbeddedBrowser,
  isConcealedByOverlays,
  releaseEmbeddedBrowser,
  type EmbeddedBrowserPaneApi,
  type EmbeddedBrowserRelease,
} from './embedded-browser-view'

// Dereferenced per call: the preload bridge is installed before React runs, but
// keeping the indirection means the hook never captures a stale bridge object.
const paneApi: EmbeddedBrowserPaneApi = {
  setDisplayMode: (id, mode) => window.electronAPI.browserPane.setDisplayMode(id, mode),
  setEmbeddedBounds: (id, rect) => window.electronAPI.browserPane.setEmbeddedBounds(id, rect),
  setViewsVisible: (id, visible) => window.electronAPI.browserPane.setViewsVisible(id, visible),
}

export function useEmbeddedBrowserView({
  instanceId,
  release,
}: {
  instanceId: string
  release: EmbeddedBrowserRelease
}): RefObject<HTMLDivElement | null> {
  const holeRef = useRef<HTMLDivElement>(null)
  // Read only from cleanup, so a host that changed its mind must not look like
  // a reason to undock and dock again.
  const releaseRef = useRef(release)
  releaseRef.current = release

  const reporter = useMemo(() => createEmbeddedBoundsReporter(paneApi, instanceId), [instanceId])

  const reportBounds = useCallback(() => {
    const el = holeRef.current
    if (!el) return
    reporter.report(el.getBoundingClientRect())
  }, [reporter])

  // Mounting: dock, then report — the main process rejects bounds for a browser
  // that is not integrated yet.
  useEffect(() => {
    let cancelled = false
    void dockEmbeddedBrowser(paneApi, instanceId, () => cancelled).then(docked => {
      if (docked) reportBounds()
    })

    return () => {
      cancelled = true
      reporter.forget()
      releaseEmbeddedBrowser(paneApi, instanceId, releaseRef.current)
    }
  }, [instanceId, reportBounds, reporter])

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

  // Nothing in CSS reaches the native views - take them off screen for as long
  // as an overlay covers the hole. Radix and our Island primitive portal to the
  // body, so watching the body's own children catches every mount and unmount
  // without a subtree observer firing on each streamed token.
  useEffect(() => {
    let concealed = false
    const sync = () => {
      const el = holeRef.current
      if (!el) return
      const overlays = Array.from(document.querySelectorAll(OVERLAY_SELECTORS.join(', ')))
        .map(node => node.getBoundingClientRect())
      const overlapped = isConcealedByOverlays(el.getBoundingClientRect(), overlays)
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

  return holeRef
}
