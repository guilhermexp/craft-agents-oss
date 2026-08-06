/**
 * Icon probe caching contract.
 *
 * Guards the regression that made `workspace:readImage` the app's dominant RPC
 * cost: 872 calls in 22 s, enough to queue unrelated channels behind it for
 * ~270 ms each. Every entity without an icon file was re-probing four
 * extensions on every remount of an unvirtualized list row.
 */
import { afterEach, beforeEach, describe, expect, it, mock } from 'bun:test'

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
const { resolveEntityIconFile, clearIconCaches, clearSourceIconCaches, iconCache } =
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
})
