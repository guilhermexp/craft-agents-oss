import { describe, expect, it } from 'bun:test'

import { evaluatePoll, interactionDisplay } from '../interactions'

const base = {
  label: 'btn',
  startedAt: 1000,
  startSeq: 0,
  firstCommitAt: null as number | null,
  lastPollAt: 1990,
}

describe('interactionDisplay', () => {
  it('shows the settle number when commit tracking is available', () => {
    expect(interactionDisplay(true)).toEqual({ showSettle: true, warnUnavailable: false })
  })

  it('warns and suppresses settle when commit tracking is unavailable', () => {
    // A packaged renderer never advances commitClock, so every interaction is a
    // fake `settledMs: 0` — the overlay/report must warn, not print a number.
    expect(interactionDisplay(false)).toEqual({ showSettle: false, warnUnavailable: true })
  })
})

describe('evaluatePoll', () => {
  it('stays pending while the UI is still committing', () => {
    const decision = evaluatePoll({ ...base }, 2000, 1, 1950)
    expect(decision.resolution).toBeNull()
    expect(decision.firstCommitAt).toBe(1950)
  })

  it('settles after the quiet period, dating settle to the last commit', () => {
    const decision = evaluatePoll({ ...base }, 2000, 3, 1700)
    expect(decision.resolution?.kind).toBe('settled')
    const sample = decision.resolution?.kind === 'settled' ? decision.resolution.sample : null
    expect(sample?.firstCommitMs).toBe(700)
    expect(sample?.settledMs).toBe(700)
    expect(sample?.commits).toBe(3)
    expect(sample?.timedOut).toBe(false)
  })

  it('reports settledMs 0 for a settle with no commits', () => {
    const decision = evaluatePoll(
      { ...base, startedAt: 0, lastPollAt: 240 },
      250,
      0,
      0,
    )
    const sample = decision.resolution?.kind === 'settled' ? decision.resolution.sample : null
    expect(sample?.settledMs).toBe(0)
    expect(sample?.firstCommitMs).toBeNull()
    expect(sample?.commits).toBe(0)
  })

  it('hard-stops a permanently churning interaction as a timeout', () => {
    const decision = evaluatePoll({ ...base, startedAt: 0, lastPollAt: 14_990 }, 15_000, 0, 0)
    const sample = decision.resolution?.kind === 'settled' ? decision.resolution.sample : null
    expect(sample?.timedOut).toBe(true)
    expect(sample?.settledMs).toBe(15_000)
  })

  it('discards an interaction whose window was suspended', () => {
    // The tab was backgrounded: rAF stopped, so this poll arrives minutes late.
    // Without the gap guard, elapsed (120 s) would be reported as latency and
    // even trip the timeout — a lie that sorts to the top of the report.
    const decision = evaluatePoll({ ...base, startedAt: 0, lastPollAt: 50 }, 120_000, 0, 0)
    expect(decision.resolution?.kind).toBe('discarded')
  })
})
