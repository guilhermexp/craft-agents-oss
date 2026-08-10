/**
 * Renderer-side frame, jank and memory collectors.
 *
 * These cover what the main process cannot see: the renderer's own frame rate,
 * the long tasks that block it, per-script attribution for those tasks, input
 * responsiveness, and JS heap growth. Everything accumulates into a rolling
 * window that `store.ts` drains once per second.
 *
 * All observers are created on `start()` and disconnected on `stop()`, so an
 * overlay that is off costs nothing.
 */

// --- Non-standard / newer APIs, declared narrowly ---------------------------

interface MemoryInfo {
  usedJSHeapSize: number
  totalJSHeapSize: number
  jsHeapSizeLimit: number
}

interface LoAFScript {
  readonly name?: string
  readonly invoker?: string
  readonly invokerType?: string
  readonly sourceURL?: string
  readonly sourceFunctionName?: string
  readonly duration: number
  readonly forcedStyleAndLayoutDuration?: number
}

interface LoAFEntry extends PerformanceEntry {
  readonly blockingDuration?: number
  readonly renderStart?: number
  readonly styleAndLayoutStart?: number
  readonly scripts?: readonly LoAFScript[]
}

interface EventTimingEntry extends PerformanceEntry {
  readonly processingStart: number
  readonly processingEnd: number
  readonly interactionId?: number
}

/** Longest-blocking scripts kept per window. */
const MAX_SCRIPT_ATTRIBUTIONS = 8
/** Ignore long-animation-frame scripts below this — noise, not a cause. */
const MIN_SCRIPT_MS = 4

export interface ScriptAttribution {
  /** Best available identity: invoker (e.g. `TIMER`, a handler) or source URL. */
  readonly label: string
  /** Total ms this script blocked the main thread during the window. */
  readonly ms: number
  readonly count: number
  /** Ms spent in synchronous style/layout forced by this script (layout thrash). */
  readonly forcedLayoutMs: number
}

export interface FrameWindow {
  /**
   * Frames served in the window. `null` while the window is hidden or
   * occluded — a hidden window legitimately serves zero frames, and reporting
   * `0` would look like a freeze.
   */
  readonly fps: number | null
  /** Worst gap between consecutive animation frames, in ms. */
  readonly worstFrameGapMs: number
  /** Long-task time per second of wall clock, in ms. */
  readonly longTaskMsPerSec: number
  readonly longTaskCount: number
  /** Sum of `blockingDuration` from long animation frames, in ms. */
  readonly blockingMs: number
  /** Worst input latency (event start → next paint) observed, in ms. */
  readonly worstInteractionMs: number
  readonly worstInteractionName: string | null
  readonly scripts: readonly ScriptAttribution[]
  readonly heapUsedMb: number | null
  readonly heapLimitMb: number | null
  readonly domNodes: number
}

interface MutableScript {
  ms: number
  count: number
  forcedLayoutMs: number
}

let running = false
let rafHandle = 0
let frames = 0
let lastFrameAt = 0
let worstFrameGapMs = 0
let hiddenDuringWindow = false

let longTaskMs = 0
let longTaskCount = 0
let blockingMs = 0
let worstInteractionMs = 0
let worstInteractionName: string | null = null
const scriptTotals = new Map<string, MutableScript>()

const observers: PerformanceObserver[] = []

function observe(type: string, callback: (list: PerformanceObserverEntryList) => void, extra?: Record<string, unknown>): void {
  try {
    const observer = new PerformanceObserver(callback)
    observer.observe({ type, buffered: false, ...extra })
    observers.push(observer)
  } catch {
    // Entry type unsupported on this Chromium build — that collector is simply
    // absent from the report rather than breaking the rest.
  }
}

function tick(now: number): void {
  if (!running) return
  frames++
  if (lastFrameAt !== 0) {
    const gap = now - lastFrameAt
    if (gap > worstFrameGapMs) worstFrameGapMs = gap
  }
  lastFrameAt = now
  if (document.hidden) hiddenDuringWindow = true
  rafHandle = requestAnimationFrame(tick)
}

export function startFrameCollectors(): void {
  if (running) return
  running = true
  hiddenDuringWindow = document.hidden
  lastFrameAt = 0
  rafHandle = requestAnimationFrame(tick)

  observe('longtask', (list) => {
    for (const entry of list.getEntries()) {
      longTaskMs += entry.duration
      longTaskCount++
    }
  })

  // Long Animation Frames give per-script attribution — the difference between
  // "something blocked for 300 ms" and "this handler blocked for 300 ms".
  observe('long-animation-frame', (list) => {
    for (const entry of list.getEntries() as LoAFEntry[]) {
      blockingMs += entry.blockingDuration ?? 0
      for (const script of entry.scripts ?? []) {
        if (script.duration < MIN_SCRIPT_MS) continue
        const label =
          script.sourceFunctionName ||
          script.invoker ||
          script.sourceURL ||
          script.invokerType ||
          'unknown'
        const bucket = scriptTotals.get(label) ?? { ms: 0, count: 0, forcedLayoutMs: 0 }
        bucket.ms += script.duration
        bucket.count++
        bucket.forcedLayoutMs += script.forcedStyleAndLayoutDuration ?? 0
        scriptTotals.set(label, bucket)
      }
    }
  })

  // `durationThreshold` is the spec minimum of 16 ms; anything faster is not a
  // responsiveness problem and would only add observer overhead.
  observe(
    'event',
    (list) => {
      for (const entry of list.getEntries() as EventTimingEntry[]) {
        if (entry.duration > worstInteractionMs) {
          worstInteractionMs = entry.duration
          worstInteractionName = entry.name
        }
      }
    },
    { durationThreshold: 16 },
  )
}

export function stopFrameCollectors(): void {
  if (!running) return
  running = false
  cancelAnimationFrame(rafHandle)
  rafHandle = 0
  for (const observer of observers) observer.disconnect()
  observers.length = 0
  drainFrameWindow(1000)
}

/** Snapshot and reset. `windowMs` is the real elapsed time, never assumed. */
export function drainFrameWindow(windowMs: number): FrameWindow {
  const seconds = Math.max(0.001, windowMs / 1000)

  const scripts: ScriptAttribution[] = [...scriptTotals.entries()]
    .map(([label, value]) => ({ label, ms: value.ms, count: value.count, forcedLayoutMs: value.forcedLayoutMs }))
    .sort((a, b) => b.ms - a.ms)
    .slice(0, MAX_SCRIPT_ATTRIBUTIONS)

  // `performance.memory` is Chromium-only and absent under some flags.
  const memory = (performance as Performance & { memory?: MemoryInfo }).memory
  const bytesToMb = 1 / (1024 * 1024)

  const snapshot: FrameWindow = {
    fps: hiddenDuringWindow ? null : Math.round(frames / seconds),
    worstFrameGapMs: Math.round(worstFrameGapMs),
    longTaskMsPerSec: Math.round(longTaskMs / seconds),
    longTaskCount,
    blockingMs: Math.round(blockingMs),
    worstInteractionMs: Math.round(worstInteractionMs),
    worstInteractionName,
    scripts,
    heapUsedMb: memory ? Math.round(memory.usedJSHeapSize * bytesToMb) : null,
    heapLimitMb: memory ? Math.round(memory.jsHeapSizeLimit * bytesToMb) : null,
    domNodes: document.getElementsByTagName('*').length,
  }

  frames = 0
  worstFrameGapMs = 0
  hiddenDuringWindow = document.hidden
  longTaskMs = 0
  longTaskCount = 0
  blockingMs = 0
  worstInteractionMs = 0
  worstInteractionName = null
  scriptTotals.clear()

  return snapshot
}
