import { describe, expect, it } from 'bun:test'

import { buildSmoothed, type PerfSnapshot, type SmoothedReadout } from '../store'
import type { PerfProcessSample } from '@craft-agent/shared/perf'

const SENTINEL: SmoothedReadout = {
  fps: -1,
  longTaskMsPerSec: -1,
  commitsPerSec: -1,
  renderSelfMsPerSec: -1,
  mainCpuPercent: -1,
  rendererCpuPercent: -1,
}

function win(overrides: {
  fps?: number | null
  longTaskMsPerSec?: number
  commits?: number
  totalSelfMs?: number
  discontinuity?: boolean
  processes?: PerfProcessSample[]
}): PerfSnapshot {
  const processes = overrides.processes
  return {
    enabled: true,
    ts: 0,
    windowMs: 1000,
    discontinuity: overrides.discontinuity ?? false,
    frames: {
      fps: overrides.fps ?? null,
      worstFrameGapMs: 0,
      longTaskMsPerSec: overrides.longTaskMsPerSec ?? 0,
      longTaskCount: 0,
      blockingMs: 0,
      worstInteractionMs: 0,
      worstInteractionName: null,
      scripts: [],
      heapUsedMb: null,
      heapLimitMb: null,
      domNodes: 0,
    },
    commits: {
      commits: overrides.commits ?? 0,
      renderedFibers: 0,
      visitedFibers: 0,
      totalSelfMs: overrides.totalSelfMs ?? 0,
      durationsAvailable: true,
      trackerSelfMs: 0,
      components: [],
    },
    rpc: [],
    interactions: [],
    main: processes
      ? {
          ts: 0,
          windowMs: 1000,
          processes,
          eventLoop: { meanMs: 0, maxMs: 0 },
          heap: { heapUsedMb: 0, heapTotalMb: 0, externalMb: 0, rssMb: 0, gcMsPerSec: null },
          selfMs: 0,
        }
      : null,
    smoothed: SENTINEL,
    commitTrackingAvailable: true,
  }
}

function proc(key: string, cpuPercent: number): PerfProcessSample {
  return { key, label: key, pid: 1, cpuPercent, rssMb: 0 }
}

describe('buildSmoothed', () => {
  it('blends the prior windows with the current one, skipping null fps', () => {
    const w1 = win({ fps: 60, longTaskMsPerSec: 10, commits: 5, totalSelfMs: 20 })
    const w2 = win({ fps: 40, longTaskMsPerSec: 20, commits: 15, totalSelfMs: 40 })
    const latest = win({ fps: null, longTaskMsPerSec: 30, commits: 10, totalSelfMs: 60 })

    const smoothed = buildSmoothed(latest, [w1, w2])
    expect(smoothed.fps).toBe(50)
    expect(smoothed.longTaskMsPerSec).toBe(20)
    expect(smoothed.commitsPerSec).toBe(10)
    expect(smoothed.renderSelfMsPerSec).toBe(40)
  })

  it('takes main-process cpu and the busiest renderer tab', () => {
    const latest = win({ processes: [proc('main', 12), proc('tab:1', 30), proc('tab:2', 50)] })
    const smoothed = buildSmoothed(latest, [])
    expect(smoothed.mainCpuPercent).toBe(12)
    expect(smoothed.rendererCpuPercent).toBe(50)
  })

  it('falls back to the latest readout when every window is a discontinuity', () => {
    const latest = win({ fps: 60, discontinuity: true })
    expect(buildSmoothed(latest, [])).toBe(SENTINEL)
  })
})
