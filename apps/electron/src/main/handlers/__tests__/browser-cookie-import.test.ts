/**
 * The RPC surface of the bulk Chrome cookie import.
 *
 * Two properties are asserted here and nowhere else:
 *  - the handler forwards only the `profileId` to the manager, which owns the
 *    known + user-only gate; the handler adds no domain, intent or second scan;
 *  - distinct failures reach the renderer as distinct reason codes, while the
 *    log line carries the code and nothing else (no host, no raw error). The
 *    manager's typed user-only refusal collapses to `user-only-required`.
 */

import { beforeEach, describe, expect, it, mock } from 'bun:test'
import { RPC_NAMESPACES } from '@craft-agent/shared/protocol'
import { ChromeCookieReaderError } from '@craft-agent/shared/browser-cookies/chrome-cookie-reader'
import { COOKIE_IMPORT_FAILURE_PREFIX } from '@craft-agent/shared/browser-cookies/types'
import type { BrowserProfile } from '@craft-agent/shared/config/types'
import type { RpcServer } from '@craft-agent/server-core/transport'
import type { HandlerDeps } from '../handler-deps'
import { registerBrowserHandlers } from '../browser'
import { UserOnlyBrowserProfileRequiredError } from '../../browser-profile-resolver'

type Handler = (ctx: unknown, ...args: never[]) => unknown

const profiles: BrowserProfile[] = [
  { id: 'default', name: 'Default', color: '#22c55e', createdAt: 0 },
  { id: 'connected', name: 'Connected', color: '#3b82f6', createdAt: 1, userOnly: true },
]

const importCookies = mock(async (_profileId: string) => ({ imported: 4, skipped: 1 }))
const previewCookieImport = mock(async (_profileId: string) => ({
  cookies: 9,
  hosts: 3,
  blockedCookies: 2,
  blockedHosts: 1,
}))
const logError = mock((..._args: unknown[]) => {})

function register(): Map<string, Handler> {
  const handlers = new Map<string, Handler>()
  const server = {
    handle(channel: string, handler: Handler) {
      handlers.set(channel, handler)
    },
    push() {},
    async invokeClient() {},
    hasClientCapability() { return false },
    findClientsWithCapability() { return [] },
  } as unknown as RpcServer

  const deps = {
    sessionManager: {} as HandlerDeps['sessionManager'],
    platform: {
      appRootPath: '',
      resourcesPath: '',
      isPackaged: false,
      appVersion: '0.0.0-test',
      isDebugMode: true,
      logger: { ...console, error: logError },
      imageProcessor: {
        getMetadata: async () => null,
        process: async () => Buffer.from(''),
      },
    },
    windowManager: {} as HandlerDeps['windowManager'],
    browserPaneManager: {
      onStateChange: () => {},
      onRemoved: () => {},
      onInteracted: () => {},
      onProfilesChanged: () => {},
      onProfileManagementRequested: () => {},
      onDisplayModeRequested: () => {},
      listProfiles: () => profiles,
      importCookies,
      previewCookieImport,
    } as unknown as NonNullable<HandlerDeps['browserPaneManager']>,
    oauthFlowStore: {
      store: () => {},
      getByState: () => null,
      remove: () => {},
      cleanup: () => {},
      dispose: () => {},
      size: 0,
    } as unknown as HandlerDeps['oauthFlowStore'],
  } satisfies HandlerDeps

  registerBrowserHandlers(server, deps)
  return handlers
}

function invoke(channel: string, profileId: string): Promise<unknown> {
  const handler = register().get(channel)
  if (!handler) throw new Error(`handler not registered: ${channel}`)
  return Promise.resolve(handler({}, profileId as never))
}

async function reasonFor(channel: string, profileId: string): Promise<string> {
  try {
    await invoke(channel, profileId)
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err)
    if (!message.startsWith(COOKIE_IMPORT_FAILURE_PREFIX)) {
      throw new Error(`unexpected error shape: ${message}`)
    }
    return message.slice(COOKIE_IMPORT_FAILURE_PREFIX.length)
  }
  throw new Error(`expected ${channel} to reject`)
}

describe('browserPane cookie import handlers', () => {
  beforeEach(() => {
    logError.mockClear()
    importCookies.mockClear()
    importCookies.mockImplementation(async () => ({ imported: 4, skipped: 1 }))
    previewCookieImport.mockClear()
    previewCookieImport.mockImplementation(async () => ({
      cookies: 9,
      hosts: 3,
      blockedCookies: 2,
      blockedHosts: 1,
    }))
  })

  it('forwards only the profileId when importing a user-only profile', async () => {
    const result = await invoke(RPC_NAMESPACES.browserPane.IMPORT_COOKIES, 'connected')

    expect(result).toEqual({ imported: 4, skipped: 1 })
    expect(importCookies).toHaveBeenCalledWith('connected')
  })

  it('forwards only the profileId when previewing a user-only profile', async () => {
    const result = await invoke(RPC_NAMESPACES.browserPane.PREVIEW_COOKIE_IMPORT, 'connected')

    expect(result).toEqual({ cookies: 9, hosts: 3, blockedCookies: 2, blockedHosts: 1 })
    expect(previewCookieImport).toHaveBeenCalledWith('connected')
  })

  it("maps the manager's user-only refusal to user-only-required on both channels", async () => {
    importCookies.mockImplementation(async () => {
      throw new UserOnlyBrowserProfileRequiredError('default')
    })
    previewCookieImport.mockImplementation(async () => {
      throw new UserOnlyBrowserProfileRequiredError('default')
    })

    expect(await reasonFor(RPC_NAMESPACES.browserPane.IMPORT_COOKIES, 'default'))
      .toBe('user-only-required')
    expect(await reasonFor(RPC_NAMESPACES.browserPane.PREVIEW_COOKIE_IMPORT, 'default'))
      .toBe('user-only-required')

    // The gate lives in the manager now: the handler forwards the raw id
    // rather than pre-screening it.
    expect(importCookies).toHaveBeenCalledWith('default')
    expect(previewCookieImport).toHaveBeenCalledWith('default')
  })

  it('maps each reader error code to its own reason', async () => {
    for (const code of [
      'unsupported-platform',
      'invalid-profile',
      'cookie-db-not-found',
      'keychain-read-failed',
      'cookie-db-read-failed',
    ] as const) {
      importCookies.mockImplementation(async () => {
        throw new ChromeCookieReaderError(code, `raw detail for ${code}`)
      })
      expect(await reasonFor(RPC_NAMESPACES.browserPane.IMPORT_COOKIES, 'connected')).toBe(code)
    }
  })

  it('collapses an untyped failure to the generic reason', async () => {
    importCookies.mockImplementation(async () => {
      throw new Error('some internal detail')
    })

    expect(await reasonFor(RPC_NAMESPACES.browserPane.IMPORT_COOKIES, 'connected')).toBe('unknown')
  })

  it('logs the reason code and never the underlying error', async () => {
    importCookies.mockImplementation(async () => {
      throw new ChromeCookieReaderError('keychain-read-failed', 'RAW_KEYCHAIN_DETAIL')
    })

    await reasonFor(RPC_NAMESPACES.browserPane.IMPORT_COOKIES, 'connected')

    const logged = logError.mock.calls.flat().map(String).join(' ')
    expect(logged).toContain('keychain-read-failed')
    expect(logged).not.toContain('RAW_KEYCHAIN_DETAIL')
  })

  it('never logs the caller-supplied profileId on either channel', async () => {
    // A profileId is caller-supplied and can be host/token-like; the log line
    // must carry only the static operation and the reason code.
    const sentinel = 'https://secret.internal.example.com/tok_ABCDEF0123456789'
    const failure = async () => {
      throw new ChromeCookieReaderError('keychain-read-failed', 'RAW_KEYCHAIN_DETAIL')
    }
    importCookies.mockImplementation(failure)
    previewCookieImport.mockImplementation(failure)

    for (const channel of [
      RPC_NAMESPACES.browserPane.IMPORT_COOKIES,
      RPC_NAMESPACES.browserPane.PREVIEW_COOKIE_IMPORT,
    ]) {
      logError.mockClear()
      await reasonFor(channel, sentinel)
      const logged = logError.mock.calls.flat().map(String).join(' ')
      expect(logged).toContain('keychain-read-failed')
      expect(logged).not.toContain(sentinel)
      expect(logged).not.toContain('RAW_KEYCHAIN_DETAIL')
    }
  })
})
