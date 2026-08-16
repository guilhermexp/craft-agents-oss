/**
 * Data-URL cache contract for image-preview blocks.
 *
 * Guards two regressions the first cache shipped: it pinned the first read of a
 * path for the renderer's lifetime (agents rewrite the same artefact in a loop,
 * so the preview froze), and it grew without bound (a data URL is ~1.37× the
 * file it encodes, and unlike the old per-component cache it was never GC'd).
 */
import { afterEach, describe, expect, it, mock, spyOn } from 'bun:test'
import {
  blockDataUrlCacheLimits,
  loadBlockDataUrl,
  resetBlockDataUrlCache,
} from '../markdown-image-cache'

const defaults = { ...blockDataUrlCacheLimits }

afterEach(() => {
  resetBlockDataUrlCache()
  blockDataUrlCacheLimits.byteBudget = defaults.byteBudget
  blockDataUrlCacheLimits.ttlMs = defaults.ttlMs
})

describe('loadBlockDataUrl', () => {
  it('deduplicates repeated reads of the same path within the TTL', async () => {
    const read = mock((_path: string) => Promise.resolve('data:image/png;base64,AAA'))

    expect(await loadBlockDataUrl('chart.png', read)).toBe('data:image/png;base64,AAA')
    expect(await loadBlockDataUrl('chart.png', read)).toBe('data:image/png;base64,AAA')

    // Second call is served from cache — the file is read once, not per mount.
    expect(read).toHaveBeenCalledTimes(1)
  })

  it('shares one in-flight read across concurrent callers in the same pass', async () => {
    let resolveRead: (value: string) => void = () => {}
    const read = mock(
      (_path: string) => new Promise<string>((resolve) => { resolveRead = resolve }),
    )

    const a = loadBlockDataUrl('chart.png', read)
    const b = loadBlockDataUrl('chart.png', read)
    resolveRead('data:image/png;base64,AAA')

    expect(await a).toBe('data:image/png;base64,AAA')
    expect(await b).toBe('data:image/png;base64,AAA')
    expect(read).toHaveBeenCalledTimes(1)
  })

  it('serves the rewritten bytes once a stale entry expires', async () => {
    const nowSpy = spyOn(Date, 'now')
    try {
      nowSpy.mockReturnValue(1_000)
      const read = mock((_path: string) => Promise.resolve('data:image/png;base64,OLD'))
      expect(await loadBlockDataUrl('chart.png', read)).toBe('data:image/png;base64,OLD')

      // The agent rewrote chart.png; a data URL carries no mtime, so freshness
      // rides on the TTL. Before it expires the stale bytes are still served.
      read.mockImplementation(() => Promise.resolve('data:image/png;base64,NEW'))
      nowSpy.mockReturnValue(1_000 + blockDataUrlCacheLimits.ttlMs - 1)
      expect(await loadBlockDataUrl('chart.png', read)).toBe('data:image/png;base64,OLD')

      // Past the TTL the same path re-reads from disk and yields the new bytes.
      nowSpy.mockReturnValue(1_000 + blockDataUrlCacheLimits.ttlMs + 1)
      expect(await loadBlockDataUrl('chart.png', read)).toBe('data:image/png;base64,NEW')
      expect(read).toHaveBeenCalledTimes(2)
    } finally {
      nowSpy.mockRestore()
    }
  })

  it('does not cache a rejected read, so the next mount retries', async () => {
    const read = mock((_path: string) => Promise.reject(new Error('gone')))
    await expect(loadBlockDataUrl('chart.png', read)).rejects.toThrow('gone')

    read.mockImplementation(() => Promise.resolve('data:image/png;base64,AAA'))
    expect(await loadBlockDataUrl('chart.png', read)).toBe('data:image/png;base64,AAA')
    expect(read).toHaveBeenCalledTimes(2)
  })

  it('evicts least-recently-used entries once the byte budget is exceeded', async () => {
    // A small budget: two entries fit, a third forces eviction of the oldest.
    blockDataUrlCacheLimits.byteBudget = 20
    const bytes = (label: string) => `data:${label}${'x'.repeat(9 - label.length)}` // length 14

    const read = (label: string) => mock(() => Promise.resolve(bytes(label)))

    const readA = read('A')
    const readB = read('B')
    await loadBlockDataUrl('a.png', readA) // 14 bytes cached
    await loadBlockDataUrl('b.png', readB) // 28 > 20 → 'a.png' evicted

    // 'a.png' was evicted, so it re-reads from disk...
    await loadBlockDataUrl('a.png', readA)
    expect(readA).toHaveBeenCalledTimes(2)

    // ...while 'b.png' was just evicted by loading 'a.png' again (LRU), so it
    // also re-reads: the budget genuinely bounds retained bytes.
    await loadBlockDataUrl('b.png', readB)
    expect(readB).toHaveBeenCalledTimes(2)
  })

  it('serves an oversized entry but never retains it', async () => {
    blockDataUrlCacheLimits.byteBudget = 10
    const big = `data:image/png;base64,${'A'.repeat(50)}`
    const read = mock(() => Promise.resolve(big))

    expect(await loadBlockDataUrl('huge.png', read)).toBe(big)
    // A single entry larger than the whole budget is evicted immediately, so a
    // second access re-reads rather than pinning memory indefinitely.
    expect(await loadBlockDataUrl('huge.png', read)).toBe(big)
    expect(read).toHaveBeenCalledTimes(2)
  })
})
