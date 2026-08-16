import { describe, expect, it } from 'bun:test'

import { buildPerfReport } from '../report'
import type { PerfSnapshot } from '../store'

function snapshot(overrides: Partial<PerfSnapshot> = {}): PerfSnapshot {
  return {
    enabled: true,
    ts: 1_700_000_000_000,
    windowMs: 1000,
    discontinuity: false,
    frames: {
      fps: 60,
      worstFrameGapMs: 20,
      longTaskMsPerSec: 0,
      longTaskCount: 0,
      blockingMs: 0,
      worstInteractionMs: 0,
      worstInteractionName: null,
      scripts: [],
      heapUsedMb: null,
      heapLimitMb: null,
      domNodes: 100,
    },
    commits: {
      commits: 0,
      renderedFibers: 0,
      visitedFibers: 0,
      totalSelfMs: 0,
      durationsAvailable: false,
      trackerSelfMs: 0,
      components: [],
    },
    rpc: [],
    interactions: [
      { label: 'save', firstCommitMs: 12, settledMs: 180, commits: 4, timedOut: false },
    ],
    main: null,
    smoothed: {
      fps: 60,
      longTaskMsPerSec: 0,
      commitsPerSec: 0,
      renderSelfMsPerSec: 0,
      mainCpuPercent: null,
      rendererCpuPercent: null,
    },
    commitTrackingAvailable: true,
    ...overrides,
  }
}

describe('buildPerfReport', () => {
  it('reports no samples for empty history', () => {
    expect(buildPerfReport([])).toContain('No samples collected.')
  })

  it('prints the settle table when commit tracking is available', () => {
    const report = buildPerfReport([snapshot()])
    expect(report).toContain('That is the number the user feels.')
    expect(report).toContain('|save|')
    expect(report).not.toContain('Settle latency unavailable')
  })

  it('suppresses the settle numbers when commit tracking is unavailable', () => {
    // Packaged build: settledMs is a fabricated 0. The section must warn and
    // omit the table rather than rank fake zeros as "the number the user feels".
    const report = buildPerfReport([snapshot({ commitTrackingAvailable: false })])
    expect(report).toContain('Settle latency unavailable in this build')
    expect(report).not.toContain('That is the number the user feels.')
    expect(report).not.toContain('|save|')
  })
})
