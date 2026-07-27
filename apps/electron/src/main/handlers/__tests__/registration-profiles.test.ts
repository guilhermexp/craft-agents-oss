import { beforeEach, describe, expect, it, mock } from 'bun:test'
import { RPC_NAMESPACES } from '@craft-agent/shared/protocol'
import type { RpcServer } from '@craft-agent/server-core/transport'
import type { HandlerDeps } from '../handler-deps'

const registeredNamespaces: string[] = []

mock.module('electron', () => ({
  ipcMain: {
    handle: () => {},
    on: () => {},
  },
  app: {
    isPackaged: false,
    getAppPath: () => '/',
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
    } as unknown as NonNullable<HandlerDeps['browserPaneManager']>,
    oauthFlowStore: {
      store: () => {},
      getByState: () => null,
      remove: () => {},
      cleanup: () => {},
      dispose: () => {},
      size: 0,
    } as unknown as HandlerDeps['oauthFlowStore'],
  }
}

// Dry-run a register function against the recording server and snapshot the RPC
// channels it registered. Shared by every profile assertion below (lockstep).
function collectRegistered(register: (server: RpcServer, deps: HandlerDeps) => void): Set<string> {
  registeredNamespaces.length = 0
  register(createMockServer(), createMockDeps())
  return new Set(registeredNamespaces.filter((ch) => ch.includes(':')))
}

// Declared profile membership, independent of the register functions under test.
// The headless server build (scripts/build-server.ts, apps/webui) registers ONLY
// the core profile, so every Electron-dependent channel MUST stay GUI-only.
// A GUI channel that migrates into core keeps disjointness + union true, but is
// caught here: the member-by-member checks below assert core carries none of
// these and gui carries only these. Fully-GUI namespaces are pulled in whole
// (their event channels are pushed, never registered, so a superset is fine);
// split namespaces (window/power/settings) list their GUI channels explicitly.
const GUI_ONLY_CHANNELS = new Set<string>([
  ...Object.values(RPC_NAMESPACES.update),
  ...Object.values(RPC_NAMESPACES.badge),
  ...Object.values(RPC_NAMESPACES.notification),
  ...Object.values(RPC_NAMESPACES.menu),
  ...Object.values(RPC_NAMESPACES.browserPane),
  ...Object.values(RPC_NAMESPACES.meetings),
  RPC_NAMESPACES.remote.TEST_CONNECTION,
  RPC_NAMESPACES.window.OPEN_WORKSPACE,
  RPC_NAMESPACES.window.OPEN_SESSION_IN_NEW_WINDOW,
  RPC_NAMESPACES.window.CLOSE,
  RPC_NAMESPACES.window.CONFIRM_CLOSE,
  RPC_NAMESPACES.window.CANCEL_CLOSE,
  RPC_NAMESPACES.window.SET_TRAFFIC_LIGHTS,
  RPC_NAMESPACES.window.GET_FOCUS_STATE,
  RPC_NAMESPACES.power.SET_KEEP_AWAKE,
  RPC_NAMESPACES.settings.SET_NETWORK_PROXY,
])

describe('RPC handler profile registration', () => {
  beforeEach(() => {
    registeredNamespaces.length = 0
  })

  it('registers disjoint channels for the core and gui profiles', async () => {
    // Dynamic import: mock.module('electron') must be registered before the
    // handler index (and its transitive electron imports) is evaluated.
    const { registerCoreRpcHandlers, registerGuiRpcHandlers } = await import('../index')

    const core = collectRegistered(registerCoreRpcHandlers)
    const gui = collectRegistered(registerGuiRpcHandlers)

    const overlap = [...core].filter((ch) => gui.has(ch)).sort()
    expect(overlap).toEqual([])
    expect(core.size).toBeGreaterThan(0)
    expect(gui.size).toBeGreaterThan(0)
  })

  it('registerAllRpcHandlers is exactly the union of the core and gui profiles', async () => {
    const { registerAllRpcHandlers, registerCoreRpcHandlers, registerGuiRpcHandlers } = await import('../index')

    const core = collectRegistered(registerCoreRpcHandlers)
    const gui = collectRegistered(registerGuiRpcHandlers)
    const all = collectRegistered((server, deps) => registerAllRpcHandlers(server, deps))

    const union = new Set([...core, ...gui])
    expect([...all].filter((ch) => !union.has(ch)).sort()).toEqual([])
    expect([...union].filter((ch) => !all.has(ch)).sort()).toEqual([])
  })

  it('gui profile registers only channels declared GUI-only', async () => {
    const { registerGuiRpcHandlers } = await import('../index')
    const gui = collectRegistered(registerGuiRpcHandlers)
    const leaked = [...gui].filter((ch) => !GUI_ONLY_CHANNELS.has(ch)).sort()
    expect(leaked).toEqual([])
  })

  it('core profile registers no channel declared GUI-only', async () => {
    const { registerCoreRpcHandlers } = await import('../index')
    const core = collectRegistered(registerCoreRpcHandlers)
    const misplaced = [...core].filter((ch) => GUI_ONLY_CHANNELS.has(ch)).sort()
    expect(misplaced).toEqual([])
  })
})
