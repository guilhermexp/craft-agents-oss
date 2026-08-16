/**
 * Data-URL cache for `image-preview` blocks, shared by every block on screen.
 *
 * The same artefact is routinely referenced by more than one message, and each
 * instance would otherwise read the file again — the dev log showed the same
 * PNG fetched twice per pass. Kept React-free so the caching contract is
 * testable without a renderer (mirrors `markdown-preview-helpers`).
 *
 * Two properties this cache must have, both regressions in the first version:
 *  - Bounded. A data URL is ~1.37× the file it encodes. The original per-mount
 *    cache died with its component; this module-level one does not, so it holds
 *    a byte budget and evicts least-recently-used entries past it. A single
 *    entry larger than the whole budget is served but not retained.
 *  - Fresh. Agents rewrite the SAME path in a loop (chart.png). Pinning the
 *    first read for the renderer's lifetime froze the preview on the stale
 *    image; entries carry a read time and expire, so a later mount re-reads.
 *
 * In-flight requests are deduplicated separately: concurrent blocks in one pass
 * share a single read; a rejection is not cached, so the next mount retries.
 */

export const blockDataUrlCacheLimits = {
  /** Total base64 characters retained before LRU eviction kicks in. */
  byteBudget: 32 * 1024 * 1024,
  /** How long a cached read is served before the path is re-read from disk. */
  ttlMs: 15_000,
}

interface BlockCacheEntry {
  dataUrl: string
  bytes: number
  readAt: number
}

// Map insertion order is the LRU order: a hit re-inserts to mark it recent.
const blockDataUrlCache = new Map<string, BlockCacheEntry>()
const blockDataUrlInFlight = new Map<string, Promise<string>>()
let blockDataUrlBytes = 0

/** Test-only: drop all cached reads so cases start from an empty cache. */
export function resetBlockDataUrlCache(): void {
  blockDataUrlCache.clear()
  blockDataUrlInFlight.clear()
  blockDataUrlBytes = 0
}

export function loadBlockDataUrl(
  src: string,
  read: (path: string) => Promise<string>,
): Promise<string> {
  const cached = blockDataUrlCache.get(src)
  if (cached && Date.now() - cached.readAt < blockDataUrlCacheLimits.ttlMs) {
    // Refresh recency for LRU: delete + re-insert moves it to the tail.
    blockDataUrlCache.delete(src)
    blockDataUrlCache.set(src, cached)
    return Promise.resolve(cached.dataUrl)
  }
  if (cached) {
    // Expired: drop it so a rewrite of the same path is picked up on re-read.
    blockDataUrlCache.delete(src)
    blockDataUrlBytes -= cached.bytes
  }

  const inFlight = blockDataUrlInFlight.get(src)
  if (inFlight) return inFlight

  const request = read(src)
    .then((dataUrl) => {
      const bytes = dataUrl.length
      blockDataUrlCache.set(src, { dataUrl, bytes, readAt: Date.now() })
      blockDataUrlBytes += bytes
      while (blockDataUrlBytes > blockDataUrlCacheLimits.byteBudget) {
        const oldest = blockDataUrlCache.keys().next().value
        if (oldest === undefined) break
        const evicted = blockDataUrlCache.get(oldest)!
        blockDataUrlCache.delete(oldest)
        blockDataUrlBytes -= evicted.bytes
      }
      return dataUrl
    })
    .finally(() => {
      blockDataUrlInFlight.delete(src)
    })
  blockDataUrlInFlight.set(src, request)
  return request
}
