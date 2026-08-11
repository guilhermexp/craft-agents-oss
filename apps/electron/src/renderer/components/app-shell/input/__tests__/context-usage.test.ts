import { describe, it, expect } from 'bun:test'
import { deriveContextUsage } from '../context-usage'

const base = {
  usedTokens: 0,
  reportedContextWindow: undefined,
  fallbackContextWindow: undefined,
  isCompacting: false,
  isProcessing: false,
}

describe('deriveContextUsage', () => {
  it('reports the share of the window the backend reported', () => {
    expect(deriveContextUsage({ ...base, usedTokens: 270_100, reportedContextWindow: 1_000_000 }))
      .toMatchObject({ percent: 27, percentText: '27.0%', usedText: '270.1K', totalText: '1.0M', accent: null })
  })

  // The badge rounds to a whole percent, but the hover readout must be able to tell
  // 270k from 279k — "how much room is left" is the reason it exists.
  it('keeps a decimal and the raw counts that the badge digit rounds away', () => {
    const a = deriveContextUsage({ ...base, usedTokens: 154_400, reportedContextWindow: 200_000 })
    const b = deriveContextUsage({ ...base, usedTokens: 154_800, reportedContextWindow: 200_000 })
    expect(a?.percent).toBe(77)
    expect(b?.percent).toBe(77)
    expect(a?.percentText).toBe('77.2%')
    expect(b?.percentText).toBe('77.4%')
    expect(a?.usedText).toBe('154.4K')
    expect(b?.usedText).toBe('154.8K')
  })

  it('spells out small counts without a unit suffix', () => {
    expect(deriveContextUsage({ ...base, usedTokens: 940, reportedContextWindow: 200_000 })?.usedText).toBe('940')
  })

  // Regression: the badge read 99 % on every long session. The backend reported a
  // 200k window for a 1M model, the UI divided by 77.5 % of it, and `Math.min(99, …)`
  // hid the overflow instead of exposing it.
  it('does not pin a nearly-empty 1M window near the clamp', () => {
    const usage = deriveContextUsage({ ...base, usedTokens: 227_714, reportedContextWindow: 1_000_000 })
    expect(usage?.percent).toBeLessThan(50)
  })

  it('can reach 100 instead of stopping at 99', () => {
    expect(deriveContextUsage({ ...base, usedTokens: 200_000, reportedContextWindow: 200_000 }))
      .toMatchObject({ percent: 100, percentText: '100.0%' })
  })

  // Regression: sessions persisted before the backend learned the real window carry
  // an impossible pair — 441.9K tokens against a "200K" window on Opus 5. That window
  // is provably not this session's, so the registry wins and the badge reads 44 %.
  it('discards a window the token count contradicts', () => {
    expect(deriveContextUsage({
      ...base,
      usedTokens: 441_920,
      reportedContextWindow: 200_000,
      fallbackContextWindow: 1_000_000,
    })).toMatchObject({ percent: 44, usedText: '441.9K', totalText: '1.0M' })
  })

  it('shows nothing when the only window available is contradicted', () => {
    expect(deriveContextUsage({ ...base, usedTokens: 400_000, reportedContextWindow: 200_000 })).toBeNull()
  })

  it('stays visible well below the old 80 % warning gate', () => {
    expect(deriveContextUsage({ ...base, usedTokens: 2_000, reportedContextWindow: 200_000 }))
      .toMatchObject({ percent: 1, accent: null })
  })

  it('escalates to info then destructive as the window fills', () => {
    expect(deriveContextUsage({ ...base, usedTokens: 148_000, reportedContextWindow: 200_000 })?.accent).toBeNull()
    expect(deriveContextUsage({ ...base, usedTokens: 150_000, reportedContextWindow: 200_000 })?.accent).toBe('info')
    expect(deriveContextUsage({ ...base, usedTokens: 178_000, reportedContextWindow: 200_000 })?.accent).toBe('info')
    expect(deriveContextUsage({ ...base, usedTokens: 180_000, reportedContextWindow: 200_000 })?.accent).toBe('destructive')
  })

  it('falls back to the registry window until the backend reports one', () => {
    expect(deriveContextUsage({ ...base, usedTokens: 50_000, fallbackContextWindow: 200_000 })?.percent).toBe(25)
  })

  it('prefers the reported window over the registry fallback', () => {
    // 1M credits exhausted: the backend budgets against 200k while the registry
    // still claims 1M, so trusting the registry would under-report by 5x.
    expect(deriveContextUsage({
      ...base,
      usedTokens: 150_000,
      reportedContextWindow: 200_000,
      fallbackContextWindow: 1_000_000,
    })?.percent).toBe(75)
  })

  it('shows nothing when the window is unknown or nothing was consumed', () => {
    expect(deriveContextUsage({ ...base, usedTokens: 50_000 })).toBeNull()
    expect(deriveContextUsage({ ...base, reportedContextWindow: 200_000 })).toBeNull()
    expect(deriveContextUsage({ ...base, usedTokens: 50_000, reportedContextWindow: 0 })).toBeNull()
  })

  it('stays visible but blocks compaction while busy or already compacting', () => {
    const busy = deriveContextUsage({ ...base, usedTokens: 190_000, reportedContextWindow: 200_000, isProcessing: true })
    expect(busy).toMatchObject({ percent: 95, canCompact: false })

    const compacting = deriveContextUsage({ ...base, usedTokens: 190_000, reportedContextWindow: 200_000, isCompacting: true })
    expect(compacting).toMatchObject({ percent: 95, canCompact: false })
  })
})
