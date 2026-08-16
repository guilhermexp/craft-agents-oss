/**
 * Icon probe caching contract.
 *
 * Guards the regression that made `workspace:readImage` the app's dominant RPC
 * cost: 872 calls in 22 s, enough to queue unrelated channels behind it for
 * ~270 ms each. Every entity without an icon file was re-probing four
 * extensions on every remount of an unvirtualized list row.
 */
import { afterEach, beforeEach, describe, expect, it, mock, spyOn } from 'bun:test'

const readWorkspaceImage = mock((_workspaceId: string, _path: string) => Promise.resolve<string | null>(null))

const originalWindow = globalThis.window

beforeEach(() => {
  readWorkspaceImage.mockReset()
  readWorkspaceImage.mockImplementation(() => Promise.resolve(null))
  ;(globalThis as unknown as { window: unknown }).window = {
    electronAPI: { readWorkspaceImage },
    getComputedStyle: () => ({ getPropertyValue: () => '#ffffff' }),
  }
})

afterEach(() => {
  ;(globalThis as unknown as { window: unknown }).window = originalWindow
})

// Dynamic import: the module reads `window.electronAPI` and must resolve the
// mocked global installed above.
const { resolveEntityIconFile, clearIconCaches, clearSourceIconCaches, iconCache, MISSING_ICON_TTL_MS } =
  await import('../icon-cache')

/** Four extensions are probed per auto-discovery: .svg, .png, .jpg, .jpeg. */
const EXTENSIONS_PER_DISCOVERY = 4

function probe(overrides: Partial<{ cacheKey: string; probeKey: string; iconDir: string }> = {}) {
  return {
    cacheKey: overrides.cacheKey ?? 'session:ws1:abc',
    probeKey: overrides.probeKey ?? 'session:ws1:abc|| .craft/sessions/abc |',
    workspaceId: 'ws1',
    iconDir: overrides.iconDir ?? '.craft/sessions/abc',
  }
}

describe('resolveEntityIconFile', () => {
  beforeEach(() => {
    clearIconCaches()
  })

  it('probes every extension once and records the miss', async () => {
    expect(await resolveEntityIconFile(probe())).toBeNull()
    expect(readWorkspaceImage).toHaveBeenCalledTimes(EXTENSIONS_PER_DISCOVERY)
  })

  it('issues no IPC at all after a recorded miss', async () => {
    await resolveEntityIconFile(probe())
    readWorkspaceImage.mockClear()

    // Three more mounts of the same row.
    expect(await resolveEntityIconFile(probe())).toBeNull()
    expect(await resolveEntityIconFile(probe())).toBeNull()
    expect(await resolveEntityIconFile(probe())).toBeNull()

    expect(readWorkspaceImage).toHaveBeenCalledTimes(0)
  })

  it('shares one round trip across callers racing in the same commit', async () => {
    const results = await Promise.all([
      resolveEntityIconFile(probe()),
      resolveEntityIconFile(probe()),
      resolveEntityIconFile(probe()),
    ])

    expect(results).toEqual([null, null, null])
    // Without dedupe this would be 3 × 4 = 12.
    expect(readWorkspaceImage).toHaveBeenCalledTimes(EXTENSIONS_PER_DISCOVERY)
  })

  it('keeps distinct probe keys independent', async () => {
    await resolveEntityIconFile(probe())
    readWorkspaceImage.mockClear()

    await resolveEntityIconFile(probe({ cacheKey: 'session:ws1:def', probeKey: 'session:ws1:def||d|', iconDir: 'd' }))

    expect(readWorkspaceImage).toHaveBeenCalledTimes(EXTENSIONS_PER_DISCOVERY)
  })

  it('caches a hit and stops probing', async () => {

    readWorkspaceImage.mockImplementation((_ws: string, path: string) =>
      Promise.resolve(path.endsWith('.png') ? 'data:image/png;base64,AAA' : null),
    )

    const first = await resolveEntityIconFile(probe())
    expect(first?.dataUrl).toBe('data:image/png;base64,AAA')
    expect(iconCache.get('session:ws1:abc')).toBe('data:image/png;base64,AAA')

    readWorkspaceImage.mockClear()
    const second = await resolveEntityIconFile(probe())

    expect(second?.dataUrl).toBe('data:image/png;base64,AAA')
    expect(readWorkspaceImage).toHaveBeenCalledTimes(0)
  })

  it('re-arms the probe when the cache is invalidated', async () => {
    await resolveEntityIconFile(probe())
    readWorkspaceImage.mockClear()

    clearIconCaches()
    await resolveEntityIconFile(probe())

    expect(readWorkspaceImage).toHaveBeenCalledTimes(EXTENSIONS_PER_DISCOVERY)
  })

  it('scoped invalidation re-arms only its own entity type', async () => {
    const sourceProbe = { cacheKey: 'source:ws1:s', probeKey: 'source:ws1:s||sources/s|', workspaceId: 'ws1', iconDir: 'sources/s' }
    await resolveEntityIconFile(sourceProbe)
    await resolveEntityIconFile(probe())
    readWorkspaceImage.mockClear()

    clearSourceIconCaches()

    await resolveEntityIconFile(sourceProbe)
    expect(readWorkspaceImage).toHaveBeenCalledTimes(EXTENSIONS_PER_DISCOVERY)

    readWorkspaceImage.mockClear()
    await resolveEntityIconFile(probe())
    expect(readWorkspaceImage).toHaveBeenCalledTimes(0)
  })

  it('does not probe when there is nothing to probe', async () => {
    expect(
      await resolveEntityIconFile({ cacheKey: 'skill:ws1:x', probeKey: 'skill:ws1:x|||', workspaceId: 'ws1' }),
    ).toBeNull()
    expect(readWorkspaceImage).toHaveBeenCalledTimes(0)
  })

  it('re-probes after a recorded miss expires (TTL)', async () => {
    const nowSpy = spyOn(Date, 'now')
    try {
      nowSpy.mockReturnValue(1_000)
      expect(await resolveEntityIconFile(probe())).toBeNull()
      expect(readWorkspaceImage).toHaveBeenCalledTimes(EXTENSIONS_PER_DISCOVERY)

      // Within the TTL the miss is trusted — a scroll/remount burst issues no IPC.
      readWorkspaceImage.mockClear()
      nowSpy.mockReturnValue(1_000 + MISSING_ICON_TTL_MS - 1)
      expect(await resolveEntityIconFile(probe())).toBeNull()
      expect(readWorkspaceImage).toHaveBeenCalledTimes(0)

      // The user added an icon file after the empty probe. Past the TTL the
      // probe re-runs and the new file surfaces without a window reload.
      nowSpy.mockReturnValue(1_000 + MISSING_ICON_TTL_MS + 1)
      readWorkspaceImage.mockImplementation((_ws: string, path: string) =>
        Promise.resolve(path.endsWith('.png') ? 'data:image/png;base64,NEW' : null),
      )
      expect((await resolveEntityIconFile(probe()))?.dataUrl).toBe('data:image/png;base64,NEW')
    } finally {
      nowSpy.mockRestore()
    }
  })

  it('an in-flight probe started before a clear cannot repopulate the miss cache', async () => {
    // Hold the IPC open so the probe is still in flight when the clear lands.
    let release: (value: string | null) => void = () => {}
    const gate = new Promise<string | null>((resolve) => { release = resolve })
    readWorkspaceImage.mockImplementation(() => gate)

    const inflight = resolveEntityIconFile(probe()) // begins in the current epoch
    clearIconCaches() // bumps the epoch and empties the in-flight map
    release(null) // the abandoned probe now settles as a miss
    expect(await inflight).toBeNull()

    // The clear armed the caches for a fresh probe. The stale miss must NOT have
    // been written back, so the next probe re-issues IPC instead of returning
    // the poisoned null.
    readWorkspaceImage.mockReset()
    readWorkspaceImage.mockImplementation(() => Promise.resolve(null))
    await resolveEntityIconFile(probe())
    expect(readWorkspaceImage).toHaveBeenCalledTimes(EXTENSIONS_PER_DISCOVERY)
  })
})
