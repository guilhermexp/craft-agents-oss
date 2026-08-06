import { beforeEach, describe, expect, it, mock } from 'bun:test'
import { RPC_NAMESPACES, getAllNamespaceValues } from '@craft-agent/shared/protocol'
import type { RpcServer } from '@craft-agent/server-core/transport'
import { CHANNEL_MAP } from '../../../transport/channel-map'
import type { HandlerDeps } from '../handler-deps'
import type { ServerHandlerContext } from '@craft-agent/server-core/handlers/rpc'

const registeredNamespaces: string[] = []

mock.module('electron', () => ({
  ipcMain: {
    // ipcMain is a separate transport from the RPC server this test verifies.
    // Channels registered here (meetings recording, hermes env, …) are a distinct
    // transport, so the mock intentionally ignores them.
    handle: () => {},
    on: () => {},
  },
  // Minimal stubs for symbols imported by IPC domain modules
  app: {
    isPackaged: false,
    getAppPath: () => '/',
    getPath: () => '/tmp/craft-agent-test',
    quit: () => {},
    dock: { setIcon: () => {}, setBadge: () => {} },
  },
  nativeTheme: { shouldUseDarkColors: false },
  nativeImage: {
    createFromPath: () => ({ isEmpty: () => true }),
    createFromDataURL: () => ({}),
  },
  dialog: {
    showOpenDialog: async () => ({ canceled: true, filePaths: [] }),
    showMessageBox: async () => ({ response: 0 }),
  },
  shell: {
    openExternal: async () => {},
    openPath: async () => '',
    showItemInFolder: () => {},
  },
  BrowserWindow: {
    fromWebContents: () => null,
    getFocusedWindow: () => null,
    getAllWindows: () => [],
  },
  webContents: { getAllWebContents: () => [] },
  BrowserView: class {},
  Menu: {
    buildFromTemplate: () => ({ popup: () => {} }),
  },
  session: {},
}))

function createMockServer(): RpcServer {
  return {
    handle(channel: string, _handler: unknown) {
      registeredNamespaces.push(channel)
    },
    push() {},
    async invokeClient() {},
    hasClientCapability() { return false },
    findClientsWithCapability() { return [] },
  }
}

function createMockDeps(): HandlerDeps {
  return {
    sessionManager: {} as HandlerDeps['sessionManager'],
    platform: {
      appRootPath: '',
      resourcesPath: '',
      isPackaged: false,
      appVersion: '0.0.0-test',
      isDebugMode: true,
      logger: console,
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
      setCaptureReleaseHook: () => {},
      setCaptureLock: () => {},
    } as unknown as NonNullable<HandlerDeps['browserPaneManager']>,
    oauthFlowStore: {
      store: () => {},
      getByState: () => null,
      remove: () => {},
      cleanup: () => {},
      dispose: () => {},
      size: 0,
    } as unknown as HandlerDeps['oauthFlowStore'],
    messagingRegistry: {} as unknown as HandlerDeps['messagingRegistry'],
  }
}

// The per-handler HANDLED_CHANNELS arrays were removed: they restated what each
// handler registers, and the array-vs-registration parity they backed is now a
// tautology. These checks compute the handled set from the registration itself.
describe('RPC handler registration', () => {
  beforeEach(() => {
    registeredNamespaces.length = 0
  })

  it('registers each RPC channel exactly once', async () => {
    // Dynamic import: mock.module('electron') must be registered before the
    // handler index (and its transitive electron imports) is evaluated.
    const { registerAllRpcHandlers } = await import('../index')
    registerAllRpcHandlers(createMockServer(), createMockDeps())

    const appChannels = registeredNamespaces.filter((ch) => ch.includes(':'))
    const counts = new Map<string, number>()
    for (const ch of appChannels) counts.set(ch, (counts.get(ch) ?? 0) + 1)
    const duplicates = [...counts.entries()]
      .filter(([, count]) => count > 1)
      .map(([channel, count]) => `${channel} (${count}x)`)
      .sort()

    expect(duplicates).toEqual([])
  })

  it('only registers channels declared in RPC_NAMESPACES', async () => {
    const { registerAllRpcHandlers } = await import('../index')
    registerAllRpcHandlers(createMockServer(), createMockDeps())

    const declared = new Set(getAllNamespaceValues())
    const undeclared = registeredNamespaces
      .filter((ch) => ch.includes(':') && !declared.has(ch))
      .sort()

    expect(undeclared).toEqual([])
  })

  it('keeps onboarding channels in registration coverage', async () => {
    const { registerAllRpcHandlers } = await import('../index')
    registerAllRpcHandlers(createMockServer(), createMockDeps())

    const registered = new Set(registeredNamespaces)
    const missingOnboarding = Object.values(RPC_NAMESPACES.onboarding).filter(
      (ch) => !registered.has(ch),
    )

    expect(missingOnboarding).toEqual([])
  })

  // CHANNEL_MAP derives the renderer's typed invoke methods from RPC_CONTRACT.
  // RPC_CONTRACT has no coupling to server.handle(), so a dropped or
  // short-circuited registration would leave the renderer with a typed method
  // and no server handler — invisible to typecheck. Assert every invoke channel
  // the client can call is actually registered. The mock deps supply everything
  // (messagingRegistry) and a serverCtx is passed so every conditional registrar
  // fires.
  it('registers every invoke channel exposed by CHANNEL_MAP', async () => {
    const { registerAllRpcHandlers } = await import('../index')
    registerAllRpcHandlers(createMockServer(), createMockDeps(), {} as unknown as ServerHandlerContext)

    const registered = new Set(registeredNamespaces)
    // Registered by the Electron main bootstrap (apps/electron/src/main/index.ts),
    // not by the RPC handler registrars this test exercises.
    const bootstrapOnly: Record<string, true> = {
      [RPC_NAMESPACES.settings.GET_SERVER_CONFIG]: true,
      [RPC_NAMESPACES.settings.SET_SERVER_CONFIG]: true,
      [RPC_NAMESPACES.settings.GET_SERVER_STATUS]: true,
    }
    const missing = Object.values(CHANNEL_MAP)
      .filter((entry) => entry.type === 'invoke')
      .map((entry) => entry.channel)
      .filter((channel) => !registered.has(channel) && !bootstrapOnly[channel])
      .sort()

    expect(missing).toEqual([])
  })
})
