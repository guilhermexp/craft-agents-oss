import { beforeEach, describe, expect, it, mock } from 'bun:test'
import { createInertNetStub } from './electron-net-stub'
import type { BrowserCookie } from '@craft-agent/shared/browser-cookies/types'
import type { BrowserProfile } from '@craft-agent/shared/config/types'
import { UserOnlyBrowserProfileRequiredError } from '../browser-profile-resolver'

const setCookie = mock(async (_details: Electron.CookiesSetDetails) => {})
const fromPartition = mock((_partition: string) => ({
  cookies: {
    set: setCookie,
  },
}))
const readChromeCookies = mock(async (_options: Record<string, unknown>) => ({
  cookies: [] as BrowserCookie[],
  skipped: 0,
  blocked: 0,
}))
const previewChromeCookies = mock((_options: Record<string, unknown>) => ({
  cookies: 0,
  hosts: 0,
  blockedCookies: 0,
  blockedHosts: 0,
}))

mock.module('electron', () => ({
  app: {
    getName: () => 'Craft Agents',
    isReady: () => false,
    whenReady: async () => {},
  },
  BrowserView: class MockBrowserView {},
  BrowserWindow: class MockBrowserWindow {},
  ipcMain: {
    handle: mock(() => {}),
  },
  nativeTheme: {
    shouldUseDarkColors: false,
  },
  // Bun's mock.module registry is global and last-registration-wins, so this
  // mock must cover every `electron` member any co-running suite resolves —
  // not just the ones this file exercises. `Menu` is window-manager's.
  Menu: {
    buildFromTemplate: mock(() => ({ popup: mock(() => {}) })),
    setApplicationMenu: mock(() => {}),
  },
  // Favicon transport (added on main) resolves `net` at module load. The stub
  // fails the request so the fetcher promise always settles — an inert `on`
  // would leave it pending and, because mock.module is global, hang whichever
  // suite loads next.
  net: createInertNetStub(),
  WebContentsView: class MockWebContentsView {},
  session: {
    defaultSession: {},
    fromPartition,
  },
  shell: {
    openExternal: mock(async () => {}),
  },
  webContents: {
    fromFrame: mock(() => undefined),
    fromId: mock(() => undefined),
    getAllWebContents: mock(() => []),
    getFocusedWebContents: mock(() => undefined),
  },
}))

// Spread the real module: mock.module replaces the whole namespace globally,
// so faking only the two functions would strip `ChromeCookieReaderError` from
// every other suite in the same run.
const actualCookieReader = await import('@craft-agent/shared/browser-cookies/chrome-cookie-reader')
mock.module('@craft-agent/shared/browser-cookies/chrome-cookie-reader', () => ({
  ...actualCookieReader,
  previewChromeCookies,
  readChromeCookies,
}))

mock.module('../logger', () => {
  const logger = {
    debug: () => {},
    error: () => {},
    info: () => {},
    warn: () => {},
  }
  return {
    default: logger,
    mainLog: logger,
  }
})

const { BrowserPaneManager } = await import('../browser-pane-manager')

const profiles: BrowserProfile[] = [
  {
    id: 'default',
    name: 'Default',
    color: '#22c55e',
    createdAt: 0,
  },
  {
    id: 'connected',
    name: 'Connected',
    color: '#3b82f6',
    createdAt: 1,
    userOnly: true,
  },
]

function cookie(overrides: Partial<BrowserCookie> = {}): BrowserCookie {
  return {
    name: 'session',
    value: 'secret-value',
    domain: 'example.com',
    path: '/',
    secure: false,
    httpOnly: true,
    expirationDate: 1_800_000_000,
    sameSite: -1,
    ...overrides,
  }
}

describe('BrowserPaneManager.importCookies', () => {
  beforeEach(() => {
    setCookie.mockReset()
    setCookie.mockImplementation(async () => {})
    fromPartition.mockClear()
    readChromeCookies.mockReset()
    readChromeCookies.mockImplementation(async () => ({
      cookies: [],
      skipped: 0,
      blocked: 0,
    }))
  })

  it('maps reader cookies into the resolved partition cookie store', async () => {
    readChromeCookies.mockResolvedValue({
      cookies: [
        cookie({
          name: 'plain',
          value: 'plain-secret',
          sameSite: -1,
        }),
        cookie({
          name: 'secure',
          value: 'secure-secret',
          domain: '.example.com',
          path: '/account',
          secure: true,
          sameSite: 0,
        }),
        cookie({
          name: 'lax',
          value: 'lax-secret',
          domain: 'sub.example.com',
          path: '/path',
          sameSite: 1,
        }),
      ],
      skipped: 0,
      blocked: 0,
    })
    const manager = new BrowserPaneManager(() => profiles)

    const result = await manager.importCookies('connected')

    expect(readChromeCookies).toHaveBeenCalledWith({})
    expect(fromPartition).toHaveBeenCalledWith('persist:browser-pane:connected')
    expect(setCookie).toHaveBeenCalledTimes(3)
    expect(setCookie).toHaveBeenNthCalledWith(1, {
      url: 'http://example.com/',
      name: 'plain',
      value: 'plain-secret',
      path: '/',
      secure: false,
      httpOnly: true,
      expirationDate: 1_800_000_000,
      sameSite: 'unspecified',
    })
    expect(setCookie).toHaveBeenNthCalledWith(2, {
      url: 'https://example.com/account',
      name: 'secure',
      value: 'secure-secret',
      domain: '.example.com',
      path: '/account',
      secure: true,
      httpOnly: true,
      expirationDate: 1_800_000_000,
      sameSite: 'no_restriction',
    })
    expect(setCookie).toHaveBeenNthCalledWith(3, {
      url: 'http://sub.example.com/path',
      name: 'lax',
      value: 'lax-secret',
      path: '/path',
      secure: false,
      httpOnly: true,
      expirationDate: 1_800_000_000,
      sameSite: 'lax',
    })
    expect(result).toEqual({ imported: 3, skipped: 0 })
    expect(JSON.stringify(result)).not.toContain('plain-secret')
    expect(JSON.stringify(result)).not.toContain('secure-secret')
    expect(JSON.stringify(result)).not.toContain('lax-secret')
  })

  it('omits domain for a host-only cookie and keeps it for a dotted one', async () => {
    readChromeCookies.mockResolvedValue({
      cookies: [
        cookie({ name: 'host-only', domain: 'example.com' }),
        cookie({ name: 'dotted', domain: '.example.com' }),
      ],
      skipped: 0,
      blocked: 0,
    })
    const manager = new BrowserPaneManager(() => profiles)

    await manager.importCookies('connected')

    // A dot-less host_key stays host-only: Electron would prepend a dot to any
    // domain we pass, widening the cookie to every subdomain.
    expect(setCookie.mock.calls[0]?.[0]).not.toHaveProperty('domain')
    // A genuinely dotted cookie was already subdomain-scoped in Chrome.
    expect(setCookie.mock.calls[1]?.[0].domain).toBe('.example.com')
  })

  it('imports a __Host- cookie without a domain', async () => {
    // The spec requires __Host- cookies to be host-only and forbids a Domain
    // attribute; forwarding one would make Electron reject the write.
    readChromeCookies.mockResolvedValue({
      cookies: [cookie({ name: '__Host-session', domain: 'example.com', secure: true, path: '/' })],
      skipped: 0,
      blocked: 0,
    })
    const manager = new BrowserPaneManager(() => profiles)

    await manager.importCookies('connected')

    expect(setCookie.mock.calls[0]?.[0]).not.toHaveProperty('domain')
    expect(setCookie.mock.calls[0]?.[0].name).toBe('__Host-session')
  })

  it('maps every Chrome sameSite value to Electron', async () => {
    readChromeCookies.mockResolvedValue({
      cookies: [
        cookie({ name: 'unspecified', sameSite: -1 }),
        cookie({ name: 'none', sameSite: 0 }),
        cookie({ name: 'lax', sameSite: 1 }),
        cookie({ name: 'strict', sameSite: 2 }),
      ],
      skipped: 0,
      blocked: 0,
    })
    const manager = new BrowserPaneManager(() => profiles)

    await manager.importCookies('connected')

    expect(setCookie.mock.calls.map(([details]) => details.sameSite)).toEqual([
      'unspecified',
      'no_restriction',
      'lax',
      'strict',
    ])
  })

  it('continues after an individual write rejection and reports it as skipped', async () => {
    readChromeCookies.mockResolvedValue({
      cookies: [
        cookie({ name: 'first' }),
        cookie({ name: 'rejected' }),
        cookie({ name: 'third' }),
      ],
      skipped: 0,
      blocked: 0,
    })
    setCookie.mockImplementation(async (details) => {
      if (details.name === 'rejected') {
        throw new Error('write rejected')
      }
    })
    const manager = new BrowserPaneManager(() => profiles)

    const result = await manager.importCookies('connected')

    expect(setCookie).toHaveBeenCalledTimes(3)
    expect(result).toEqual({ imported: 2, skipped: 1 })
  })

  it('continues after an individual synchronous write failure', async () => {
    readChromeCookies.mockResolvedValue({
      cookies: [
        cookie({ name: 'first' }),
        cookie({ name: 'throws-synchronously' }),
        cookie({ name: 'third' }),
      ],
      skipped: 0,
      blocked: 0,
    })
    setCookie.mockImplementation((details) => {
      if (details.name === 'throws-synchronously') {
        throw new Error('synchronous write failure')
      }
      return Promise.resolve()
    })
    const manager = new BrowserPaneManager(() => profiles)

    const result = await manager.importCookies('connected')

    expect(setCookie).toHaveBeenCalledTimes(3)
    expect(result).toEqual({ imported: 2, skipped: 1 })
  })

  it('refuses an unknown profile before reading or writing', async () => {
    const manager = new BrowserPaneManager(() => profiles)

    await expect(manager.importCookies('removed-profile'))
      .rejects.toBeInstanceOf(UserOnlyBrowserProfileRequiredError)

    expect(readChromeCookies).not.toHaveBeenCalled()
    expect(fromPartition).not.toHaveBeenCalled()
    expect(setCookie).not.toHaveBeenCalled()
  })

  it('refuses a profile that is not user-only before reading or writing', async () => {
    readChromeCookies.mockResolvedValue({
      cookies: [cookie()],
      skipped: 0,
      blocked: 0,
    })
    const manager = new BrowserPaneManager(() => profiles)

    await expect(manager.importCookies('default'))
      .rejects.toBeInstanceOf(UserOnlyBrowserProfileRequiredError)

    expect(readChromeCookies).not.toHaveBeenCalled()
    expect(fromPartition).not.toHaveBeenCalled()
    expect(setCookie).not.toHaveBeenCalled()
  })
})

describe('BrowserPaneManager.previewCookieImport', () => {
  beforeEach(() => {
    fromPartition.mockClear()
    setCookie.mockReset()
    readChromeCookies.mockReset()
    previewChromeCookies.mockReset()
    previewChromeCookies.mockImplementation(() => ({
      cookies: 12,
      hosts: 5,
      blockedCookies: 3,
      blockedHosts: 2,
    }))
  })

  it('returns counts without decrypting or writing anything', async () => {
    const manager = new BrowserPaneManager(() => profiles)

    const preview = await manager.previewCookieImport('connected')

    expect(preview).toEqual({
      cookies: 12,
      hosts: 5,
      blockedCookies: 3,
      blockedHosts: 2,
    })
    // The preview must not open a partition, write a cookie, or reach the
    // decrypting reader — otherwise it would trigger the Keychain prompt
    // before the user has confirmed anything.
    expect(readChromeCookies).not.toHaveBeenCalled()
    expect(fromPartition).not.toHaveBeenCalled()
    expect(setCookie).not.toHaveBeenCalled()
  })

  it('refuses a profile that is not user-only before scanning', async () => {
    const manager = new BrowserPaneManager(() => profiles)

    await expect(manager.previewCookieImport('default'))
      .rejects.toBeInstanceOf(UserOnlyBrowserProfileRequiredError)

    expect(previewChromeCookies).not.toHaveBeenCalled()
  })

  it('refuses an unknown profile before scanning', async () => {
    const manager = new BrowserPaneManager(() => profiles)

    await expect(manager.previewCookieImport('removed-profile'))
      .rejects.toBeInstanceOf(UserOnlyBrowserProfileRequiredError)

    expect(previewChromeCookies).not.toHaveBeenCalled()
  })
})
