import { describe, expect, it } from 'bun:test'

import type { FrameWindow } from '../frames'

// frames.ts touches `document`, `requestAnimationFrame` and `PerformanceObserver`
// only inside its functions, so the fakes have to exist before those run. The
// module is therefore imported dynamically after the globals are installed —
// the same load-boundary pattern as react-commits.test.ts; a static import
// would evaluate the module against a DOM-less bun global.

const rafCbs: FrameRequestCallback[] = []
let rafHandle = 0
const observerCallbacks: Record<string, (list: { getEntries: () => unknown[] }) => void> = {}

class FakePerformanceObserver {
  private readonly cb: (list: { getEntries: () => unknown[] }) => void
  constructor(cb: (list: { getEntries: () => unknown[] }) => void) {
    this.cb = cb
  }
  observe(opts: { type: string }): void {
    observerCallbacks[opts.type] = this.cb
  }
  disconnect(): void {}
}

const g = globalThis as unknown as Record<string, unknown>
g.requestAnimationFrame = (cb: FrameRequestCallback) => {
  rafCbs.push(cb)
  return ++rafHandle
}
g.cancelAnimationFrame = () => {}
g.PerformanceObserver = FakePerformanceObserver
g.document = { hidden: false, getElementsByTagName: () => ({ length: 7 }) }

const { startFrameCollectors, drainFrameWindow } = await import('../frames')

/** Fire the pending `tick` callback with a controlled timestamp. */
function frame(now: number): void {
  const cb = rafCbs.pop()
  cb?.(now)
}

describe('drainFrameWindow', () => {
  it('aggregates frames, long tasks and dom nodes, then resets on drain', () => {
    startFrameCollectors()
    frame(100)
    frame(116)
    frame(140)
    observerCallbacks.longtask?.({ getEntries: () => [{ duration: 50 }] })

    const w: FrameWindow = drainFrameWindow(1000)
    expect(w.fps).toBe(3)
    expect(w.worstFrameGapMs).toBe(24)
    expect(w.longTaskMsPerSec).toBe(50)
    expect(w.longTaskCount).toBe(1)
    expect(w.domNodes).toBe(7)

    const empty = drainFrameWindow(1000)
    expect(empty.fps).toBe(0)
    expect(empty.longTaskMsPerSec).toBe(0)
  })

  it('clamps a zero-length window instead of dividing by zero', () => {
    const w = drainFrameWindow(0)
    expect(Number.isFinite(w.fps)).toBe(true)
    expect(w.fps).toBe(0)
  })
})
