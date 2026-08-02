/**
 * Tests for BrowserPaneManager.
 *
 * Mocks Electron BrowserWindow and session modules to validate lifecycle,
 * session binding, and navigation behavior.
 */

import { describe, it, expect, beforeEach, mock } from 'bun:test'
import * as sharedConfig from '@craft-agent/shared/config'

const createdWindows: any[] = []
let toolbarLoadFailuresRemaining = 0
let nextMockWebContentsId = 1
const mockShellOpenExternal = mock(async () => {})
const mockIpcMainHandle = mock(() => {})

function createMockWebContents() {
  const listeners: Record<string, Function[]> = {}
  let currentUrl = 'about:blank'
  return {
    id: nextMockWebContentsId++,
    userAgent: 'Mock Chrome Electron/99.0.0',
    session: {},
    on: (event: string, cb: Function) => {
      if (!listeners[event]) listeners[event] = []
      listeners[event].push(cb)
    },
    loadURL: mock(async (url: string) => {
      currentUrl = url
      const isToolbarUrl = typeof url === 'string' && url.includes('browser-toolbar.html')
      if (isToolbarUrl && toolbarLoadFailuresRemaining > 0) {
        toolbarLoadFailuresRemaining--
        throw new Error('mock toolbar load failure')
      }
    }),
    loadFile: mock(async (path: string, _opts?: unknown) => {
      // Only the toolbar view loads via loadFile with the toolbar HTML;
      // scope the simulated failure to it so an unrelated loadFile (e.g. the
      // page's empty-state) does not consume a toolbar retry budget.
      const isToolbarFile = typeof path === 'string' && path.includes('browser-toolbar.html')
      if (isToolbarFile && toolbarLoadFailuresRemaining > 0) {
        toolbarLoadFailuresRemaining--
        throw new Error('mock toolbar load failure')
      }
    }),
    getTitle: mock(() => 'Test Page'),
    getURL: mock(() => currentUrl),
    canGoBack: mock(() => false),
    canGoForward: mock(() => false),
    goBack: mock(() => {}),
    goForward: mock(() => {}),
    reload: mock(() => {}),
    stop: mock(() => {}),
    setUserAgent: mock(() => {}),
    setBackgroundColor: mock(() => {}),
    isDestroyed: mock(() => false),
    close: mock(() => {}),
    capturePage: mock(async () => {
      const img = {
        isEmpty: () => false,
        getSize: () => ({ width: 2400, height: 1800 }),
        resize: (_opts: any) => img,
        toPNG: () => Buffer.from('fake-png'),
        toJPEG: (_quality: number) => Buffer.from('fake-jpeg'),
      }
      return img
    }),
    executeJavaScript: mock(async (_expr: string) => undefined),
    focus: mock(() => {}),
    setWindowOpenHandler: mock((_handler: any) => {}),
    send: mock((_channel: string, _payload?: unknown) => {}),
    debugger: {
      attach: mock(() => {}),
      detach: mock(() => {}),
      sendCommand: mock(async () => ({ nodes: [] })),
      on: mock(() => {}),
    },
    _listeners: listeners,
    _emit: (event: string, ...args: any[]) => {
      for (const cb of listeners[event] || []) cb({}, ...args)
    },
  }
}

function createMockWebContentsView() {
  const webContents = createMockWebContents()
  return {
    webContents,
    setBounds: mock(() => {}),
    setBorderRadius: mock((_radius: number) => {}),
    setVisible: mock((_visible: boolean) => {}),
    setBackgroundColor: mock((_color: string) => {}),
  }
}

function createMockWindow(opts?: { width?: number; height?: number; minWidth?: number; minHeight?: number }) {
  const listeners: Record<string, Function[]> = {}
  const webContents = createMockWebContents()
  let contentWidth = opts?.width ?? 1200
  let contentHeight = opts?.height ?? 900
  const minWidth = opts?.minWidth ?? 0
  const minHeight = opts?.minHeight ?? 0
  let visible = true

  const win = {
    webContents,
    on: (event: string, cb: Function) => {
      if (!listeners[event]) listeners[event] = []
      listeners[event].push(cb)
    },
    once: (event: string, cb: Function) => {
      const wrapped = (...args: any[]) => {
        listeners[event] = (listeners[event] || []).filter(fn => fn !== wrapped)
        cb(...args)
      }
      if (!listeners[event]) listeners[event] = []
      listeners[event].push(wrapped)
    },
    _emit: (event: string, ...args: any[]) => {
      for (const cb of listeners[event] || []) cb(...args)
    },
    isDestroyed: mock(() => false),
    isMinimized: mock(() => false),
    isVisible: mock(() => visible),
    restore: mock(() => {}),
    show: mock(() => {
      visible = true
    }),
    showInactive: mock(() => {
      visible = true
    }),
    setWindowButtonVisibility: mock((_visible: boolean) => {}),
    hide: mock(() => {
      visible = false
      win._emit('hide')
    }),
    focus: mock(() => {}),
    destroy: mock(() => {
      win._emit('closed')
    }),
    // WebContentsView children live under window.contentView. Re-adding an
    // existing child reorders it to the top, which is how the manager raises
    // the toolbar now that setTopBrowserView is gone.
    contentView: {
      children: [] as any[],
      addChildView: mock(function (this: any, view: any) {
        const existing = win.contentView.children.indexOf(view)
        if (existing !== -1) win.contentView.children.splice(existing, 1)
        win.contentView.children.push(view)
      }),
      removeChildView: mock((view: any) => {
        const idx = win.contentView.children.indexOf(view)
        if (idx !== -1) win.contentView.children.splice(idx, 1)
      }),
    },
    getBounds: mock(() => ({ x: 0, y: 0, width: contentWidth, height: contentHeight })),
    setBounds: mock((_bounds: { x: number; y: number; width: number; height: number }) => {}),
    getContentSize: mock(() => [contentWidth, contentHeight]),
    setContentSize: mock((width: number, height: number) => {
      contentWidth = Math.max(minWidth, Math.floor(width))
      contentHeight = Math.max(minHeight, Math.floor(height))
    }),
    loadURL: mock(async (_url: string) => {}),
  }
  createdWindows.push(win)
  return win
}

mock.module('electron', () => ({
  app: {
    isReady: () => false,
    whenReady: async () => {},
  },
  webContents: {
    fromFrame: mock(() => undefined),
    fromId: mock(() => undefined),
    getAllWebContents: mock(() => []),
    getFocusedWebContents: mock(() => undefined),
  },
  BrowserWindow: class MockBrowserWindow {
    webContents: any
    constructor(opts?: any) {
      const win = createMockWindow(opts)
      this.webContents = win.webContents
      Object.assign(this, win)
    }
  },
  WebContentsView: class MockWebContentsView {
    webContents: any
    constructor(_opts?: any) {
      const view = createMockWebContentsView()
      this.webContents = view.webContents
      Object.assign(this, view)
    }
  },
  ipcMain: {
    handle: mockIpcMainHandle,
  },
  screen: {
    // 1440x900 work area with a menu-bar inset, so tiling maths that ignore
    // workArea.x/y show up as wrong coordinates instead of passing by accident.
    getDisplayMatching: mock(() => ({
      workArea: { x: 0, y: 25, width: 1440, height: 875 },
    })),
  },
  Menu: {
    buildFromTemplate: mock(() => ({
      popup: mock(() => {}),
    })),
  },
  nativeTheme: {
    shouldUseDarkColors: false,
  },
  shell: {
    openExternal: mockShellOpenExternal,
  },
  session: {
    defaultSession: {
      setProxy: mock(async () => {}),
    },
    fromPartition: mock(() => ({
      setPermissionCheckHandler: mock(() => {}),
      setPermissionRequestHandler: mock(() => {}),
      setProxy: mock(async () => {}),
      clearStorageData: mock(async () => {}),
      clearCache: mock(async () => {}),
      webRequest: {
        onBeforeRequest: mock((_cb: any) => {}),
        onCompleted: mock((_cb: any) => {}),
        onErrorOccurred: mock((_cb: any) => {}),
      },
      on: mock((_event: string, _cb: any) => {}),
    })),
  },
}))

mock.module('../logger', () => {
  const stubLog = { info: () => {}, error: () => {}, warn: () => {}, debug: () => {} }
  return {
    default: stubLog,
    mainLog: stubLog,
    sessionLog: stubLog,
    handlerLog: stubLog,
    windowLog: stubLog,
    agentLog: stubLog,
    searchLog: stubLog,
    isDebugMode: false,
    getLogFilePath: () => '/tmp/main.log',
  }
})

mock.module('../browser-cdp', () => ({
  BrowserCDP: class MockBrowserCDP {
    detach = mock(() => {})
    setColorSchemeEmulation = mock(async () => {})
    getAccessibilitySnapshot = mock(async () => ({
      url: 'https://example.com',
      title: 'Example',
      nodes: [],
    }))
    clickElement = mock(async () => ({
      ref: '@e1',
      box: { x: 0, y: 0, width: 10, height: 10 },
      clickPoint: { x: 5, y: 5 },
    }))
    fillElement = mock(async () => ({
      ref: '@e1',
      box: { x: 0, y: 0, width: 10, height: 10 },
      clickPoint: { x: 5, y: 5 },
    }))
    selectOption = mock(async () => ({
      ref: '@e1',
      box: { x: 0, y: 0, width: 10, height: 10 },
      clickPoint: { x: 5, y: 5 },
    }))
    renderTemporaryOverlay = mock(async () => {})
    clearTemporaryOverlay = mock(async () => {})
    getViewportMetrics = mock(async () => ({ width: 1200, height: 900, dpr: 2, scrollX: 0, scrollY: 0 }))
    getElementGeometry = mock(async () => ({
      ref: '@e1',
      box: { x: 0, y: 0, width: 10, height: 10 },
      clickPoint: { x: 5, y: 5 },
    }))
    getElementGeometryBySelector = mock(async () => ({
      ref: 'selector:div.card',
      box: { x: 5, y: 5, width: 20, height: 20 },
      clickPoint: { x: 15, y: 15 },
    }))
  },
}))

let mockAllowRemoteEvaluate = true
mock.module('@craft-agent/shared/config', () => ({
  ...sharedConfig,
  getAllowRemoteEvaluate: () => mockAllowRemoteEvaluate,
}))

process.env.CRAFT_BROWSER_SCREENSHOT_CAPTURE_TIMEOUT_MS = '50'

const { BrowserPaneManager } = await import('../browser-pane-manager')

describe('BrowserPaneManager', () => {
  let manager: InstanceType<typeof BrowserPaneManager>

  beforeEach(() => {
    createdWindows.length = 0
    toolbarLoadFailuresRemaining = 0
    mockShellOpenExternal.mockClear()
    mockIpcMainHandle.mockClear()
    manager = new BrowserPaneManager()
    mockAllowRemoteEvaluate = true
  })

  it('freezes the client:browser:invoke wire method names (protocol v1 — a rename is a breaking change)', () => {
    // capabilityDispatch is Record<BrowserCapabilityMethod, …>, so its keys ARE the
    // derived wire-method set. Renaming an interface method silently renames the
    // wire method (see browser-capability.ts); freezing the names here makes a
    // rename fail this test instead of breaking a staggered client/server rollout.
    const wireMethods = Object.keys((manager as any).capabilityDispatch).sort()
    expect(wireMethods).toEqual([
      'bindSession', 'clearAgentControl', 'clearAgentControlForInstance', 'clearVisualsForSession',
      'clickAtCoordinates', 'clickElement', 'createForSession', 'destroyForSession', 'destroyInstance',
      'detectSecurityChallenge', 'drag', 'evaluate', 'fillElement', 'focus', 'focusBoundForSession',
      'getAccessibilitySnapshot', 'getClipboard', 'getConsoleLogs', 'getDownloads', 'getInstance',
      'getNetworkLogs', 'getOrCreateForSession', 'goBack', 'goForward', 'hide', 'listInstances',
      'navigate', 'screenshot', 'screenshotRegion', 'scroll', 'selectOption', 'sendKey',
      'setAgentControl', 'setClipboard', 'typeText', 'unbindAllForSession', 'uploadFile', 'waitFor',
      'windowResize',
    ])
  })

  it('rejects an Object.prototype key as an unknown capability method (no prototype-chain dispatch)', async () => {
    // 'constructor' resolves to a function via the prototype chain on a plain
    // object literal; the Object.hasOwn guard must reject it, not invoke it.
    await expect(
      (manager as any).dispatchCapability({ v: 1, method: 'constructor', args: [], sessionId: 's', workspaceId: 'w' }),
    ).rejects.toThrow(/Unknown browser capability method/)
  })

  it('creates and lists instances', async () => {
    const id = manager.createInstance('test-1')
    const list = await manager.listInstances()
    expect(id).toBe('test-1')
    expect(list).toHaveLength(1)
    expect(list[0].id).toBe('test-1')
    expect(list[0].agentControlActive).toBe(false)
  })

  it('reparents views into the host window when switching to integrated mode', () => {
    manager.createInstance('mode-1')
    const instance = (manager as any).instances.get('mode-1')
    const host = createMockWindow()

    expect(instance.window.contentView.children).toHaveLength(3)

    const ok = manager.setDisplayMode('mode-1', 'integrated', host as any)

    expect(ok).toBe(true)
    expect(manager.getDisplayMode('mode-1')).toBe('integrated')
    // A view can only be presented in one window at a time.
    expect(instance.window.contentView.children).toHaveLength(0)
    expect(host.contentView.children).toHaveLength(3)
    // Toolbar must stay on top after the move.
    expect(host.contentView.children[2]).toBe(instance.toolbarView)
    expect(instance.window.hide).toHaveBeenCalled()
  })

  it('refuses integrated mode without a live host window', () => {
    manager.createInstance('mode-2')
    expect(manager.setDisplayMode('mode-2', 'integrated', null)).toBe(false)
    expect(manager.getDisplayMode('mode-2')).toBe('floating')
  })

  it('returns views to the instance window and clears rounding when going back to floating', () => {
    manager.createInstance('mode-3')
    const instance = (manager as any).instances.get('mode-3')
    const host = createMockWindow()

    manager.setDisplayMode('mode-3', 'integrated', host as any)
    manager.setDisplayMode('mode-3', 'floating')

    expect(manager.getDisplayMode('mode-3')).toBe('floating')
    expect(host.contentView.children).toHaveLength(0)
    expect(instance.window.contentView.children).toHaveLength(3)
    expect(instance.embeddedBounds).toBeNull()
    expect(instance.pageView.setBorderRadius).toHaveBeenCalledWith(0)
  })

  it('converts CSS px to DIPs with floor so the view never exceeds the card', () => {
    manager.createInstance('bounds-1')
    const instance = (manager as any).instances.get('bounds-1')
    const host = createMockWindow()
    manager.setDisplayMode('bounds-1', 'integrated', host as any)

    // zoom 1.5 with fractional results: every axis must round down.
    manager.setEmbeddedBounds('bounds-1', { x: 10.4, y: 20.7, width: 800.9, height: 600.9 }, 32, 1.5)

    expect(instance.embeddedBounds).toEqual({ x: 15, y: 31, width: 1201, height: 901 })
    expect(instance.pageView.setBorderRadius).toHaveBeenCalledWith(48)
  })

  it('ignores bounds reported while floating', () => {
    manager.createInstance('bounds-2')
    const instance = (manager as any).instances.get('bounds-2')

    expect(manager.setEmbeddedBounds('bounds-2', { x: 0, y: 0, width: 10, height: 10 })).toBe(false)
    expect(instance.embeddedBounds).toBeNull()
  })

  it('falls back to floating when the host window closes', () => {
    manager.createInstance('host-close')
    const instance = (manager as any).instances.get('host-close')
    const host = createMockWindow()

    manager.setDisplayMode('host-close', 'integrated', host as any)
    host._emit('closed')

    expect(manager.getDisplayMode('host-close')).toBe('floating')
    expect(instance.window.contentView.children).toHaveLength(3)
  })

  function windowManagerStub() {
    return {
      createWindow: mock((_options: unknown) => createMockWindow()),
      registerViewClient: mock((_id: number, _ws: string) => {}),
      unregisterViewClient: mock((_id: number) => {}),
    }
  }

  it('embeds the session panel as a sibling view, not a second window', () => {
    manager.createInstance('panel-1')
    const instance = (manager as any).instances.get('panel-1')
    const wm = windowManagerStub()
    manager.setWindowManager(wm as any)

    expect(manager.toggleSessionPanel('panel-1')).toBe(true)

    // The whole point of option A: one window.
    expect(wm.createWindow).not.toHaveBeenCalled()
    expect(instance.sessionView).not.toBeNull()
    expect(instance.window.contentView.children).toContain(instance.sessionView)
    // Registered before load, or the preload reads "no workspace".
    expect(wm.registerViewClient).toHaveBeenCalled()
    // Toolbar stays on top of the new sibling.
    const children = instance.window.contentView.children
    expect(children[children.length - 1]).toBe(instance.toolbarView)
  })

  it('gives the panel its width out of the page, not the window', () => {
    manager.createInstance('panel-2')
    const instance = (manager as any).instances.get('panel-2')
    manager.setWindowManager(windowManagerStub() as any)

    manager.toggleSessionPanel('panel-2')

    // Mock window content is 1200x900; panel defaults to 420.
    expect(instance.sessionPanelWidth).toBe(420)
    expect(instance.pageView.setBounds).toHaveBeenLastCalledWith(
      expect.objectContaining({ x: 0, width: 780 }),
    )
    expect(instance.sessionView.setBounds).toHaveBeenCalledWith(
      expect.objectContaining({ x: 780, width: 420 }),
    )
  })

  it('unloads the panel renderer when toggled off instead of parking it', () => {
    manager.createInstance('panel-3')
    const instance = (manager as any).instances.get('panel-3')
    const wm = windowManagerStub()
    manager.setWindowManager(wm as any)

    manager.toggleSessionPanel('panel-3')
    const view = instance.sessionView

    manager.toggleSessionPanel('panel-3')

    expect(instance.sessionPanelWidth).toBeNull()
    expect(instance.sessionView).toBeNull()
    expect(view.webContents.close).toHaveBeenCalled()
    expect(wm.unregisterViewClient).toHaveBeenCalled()
    // Page takes the room back.
    expect(instance.pageView.setBounds).toHaveBeenLastCalledWith(
      expect.objectContaining({ width: 1200 }),
    )
  })

  it('carries the open panel across a display-mode switch', () => {
    manager.createInstance('panel-4')
    const instance = (manager as any).instances.get('panel-4')
    manager.setWindowManager(windowManagerStub() as any)

    manager.toggleSessionPanel('panel-4')
    const view = instance.sessionView
    const host = createMockWindow()

    manager.setDisplayMode('panel-4', 'integrated', host as any)

    // Left behind, the panel would be stranded on the now-hidden window while
    // the page stayed shrunk for a panel nobody can see.
    expect(instance.window.contentView.children).not.toContain(view)
    expect(host.contentView.children).toContain(view)
    expect(host.contentView.children[host.contentView.children.length - 1]).toBe(instance.toolbarView)
  })

  it('splits a frame too narrow for both floors instead of overflowing it', () => {
    manager.createInstance('panel-5')
    const instance = (manager as any).instances.get('panel-5')
    manager.setWindowManager(windowManagerStub() as any)
    const host = createMockWindow()
    manager.setDisplayMode('panel-5', 'integrated', host as any)
    // A card, not a window: 500 DIPs cannot hold a 400 page next to a 320 panel.
    manager.setEmbeddedBounds('panel-5', { x: 0, y: 0, width: 500, height: 400 })

    manager.toggleSessionPanel('panel-5')

    expect(instance.sessionPanelWidth).toBe(250)
    expect(instance.pageView.setBounds).toHaveBeenLastCalledWith(
      expect.objectContaining({ x: 0, width: 250 }),
    )
    expect(instance.sessionView.setBounds).toHaveBeenLastCalledWith(
      expect.objectContaining({ x: 250, width: 250 }),
    )
  })

  it('gives the browser its window back when it stops being a card', () => {
    manager.createInstance('undock-1')
    const instance = (manager as any).instances.get('undock-1')
    instance.window.show()
    const host = createMockWindow()

    manager.setDisplayMode('undock-1', 'integrated', host as any)
    expect(instance.window.isVisible()).toBe(false)

    manager.setDisplayMode('undock-1', 'floating')

    // The views go back to this window. Left hidden, the browser just vanishes:
    // still alive, still in the tab strip, painting into nothing.
    expect(instance.window.isVisible()).toBe(true)
  })

  it('leaves a browser that was already hidden hidden after undocking', () => {
    manager.createInstance('undock-2')
    const instance = (manager as any).instances.get('undock-2')
    instance.window.hide()
    const host = createMockWindow()

    manager.setDisplayMode('undock-2', 'integrated', host as any)
    manager.setDisplayMode('undock-2', 'floating')

    // Undocking undoes what docking did — it is not a "show the browser" button.
    expect(instance.window.isVisible()).toBe(false)
  })

  it('paints the toolbar and overlay views transparent', () => {
    manager.createInstance('bg-1')
    const instance = (manager as any).instances.get('bg-1')

    // The View layer, not just the webContents: WebContentsView defaults to
    // opaque white and would white out the window when the toolbar expands.
    expect(instance.toolbarView.setBackgroundColor).toHaveBeenCalledWith('#00000000')
    expect(instance.nativeOverlayView.setBackgroundColor).toHaveBeenCalledWith('#00000000')
  })

  it('closes every view webContents on destroy so none outlive the window', () => {
    manager.createInstance('leak-1')
    const instance = (manager as any).instances.get('leak-1')

    manager.destroyInstance('leak-1')

    expect(instance.pageView.webContents.close).toHaveBeenCalled()
    expect(instance.toolbarView.webContents.close).toHaveBeenCalled()
    expect(instance.nativeOverlayView.webContents.close).toHaveBeenCalled()
  })

  it('is idempotent when explicit ID already exists', async () => {
    const first = manager.createInstance('same-id')
    const second = manager.createInstance('same-id')
    expect(first).toBe('same-id')
    expect(second).toBe('same-id')
    expect(await manager.listInstances()).toHaveLength(1)
  })

  it('allows http(s) popups with shared browser partition', () => {
    manager.createInstance('popup-allow')
    const instance = (manager as any).instances.get('popup-allow')
    const openHandler = instance.pageView.webContents.setWindowOpenHandler.mock.calls[0][0]

    const result = openHandler({
      url: 'https://accounts.google.com/o/oauth2/v2/auth',
      disposition: 'new-popup',
      frameName: 'oauth-popup',
    })

    expect(result.action).toBe('allow')
    expect(result.overrideBrowserWindowOptions?.webPreferences?.partition).toBe('persist:browser-pane')
    expect(result.overrideBrowserWindowOptions?.webPreferences?.nodeIntegration).toBe(false)
    expect(result.overrideBrowserWindowOptions?.webPreferences?.contextIsolation).toBe(true)
  })

  it('denies app deep-link popups and forwards to deep-link handler', async () => {
    manager.createInstance('popup-deeplink')
    const instance = (manager as any).instances.get('popup-deeplink')
    const openHandler = instance.pageView.webContents.setWindowOpenHandler.mock.calls[0][0]

    const result = openHandler({
      url: 'craftagents://settings',
      disposition: 'new-popup',
      frameName: '',
    })

    expect(result).toEqual({ action: 'deny' })
    await Bun.sleep(0)
    expect(mockShellOpenExternal).toHaveBeenCalledWith('craftagents://settings')
  })

  // F7/R1 — allowlist de esquema em navegação client-side e redirects
  it('will-navigate blocks file:// navigation initiated by the page', () => {
    manager.createInstance('nav-scheme-block')
    const instance = (manager as any).instances.get('nav-scheme-block')

    const event = { preventDefault: mock(() => {}) }
    for (const cb of instance.pageView.webContents._listeners['will-navigate'] || []) {
      cb(event, 'file:///etc/passwd')
    }

    expect(event.preventDefault).toHaveBeenCalled()
  })

  it('will-navigate does not block legitimate https navigation', () => {
    manager.createInstance('nav-scheme-ok')
    const instance = (manager as any).instances.get('nav-scheme-ok')

    const event = { preventDefault: mock(() => {}) }
    for (const cb of instance.pageView.webContents._listeners['will-navigate'] || []) {
      cb(event, 'https://ok.com/')
    }

    expect(event.preventDefault).not.toHaveBeenCalled()
  })

  it('will-navigate still routes Craft deep links to the deep-link handler', () => {
    manager.createInstance('nav-scheme-deeplink')
    const instance = (manager as any).instances.get('nav-scheme-deeplink')
    const deepLinkSpy = mock(async () => {})
    ;(manager as any).handleDeepLinkUrl = deepLinkSpy

    const event = { preventDefault: mock(() => {}) }
    for (const cb of instance.pageView.webContents._listeners['will-navigate'] || []) {
      cb(event, 'craftagents://settings')
    }

    expect(event.preventDefault).toHaveBeenCalled()
    expect(deepLinkSpy).toHaveBeenCalledWith('craftagents://settings')
  })

  it('did-redirect-navigation to a forbidden scheme stops load and bails to about:blank', () => {
    manager.createInstance('redirect-scheme-block')
    const instance = (manager as any).instances.get('redirect-scheme-block')
    const wc = instance.pageView.webContents
    wc.loadURL.mockClear()

    wc._emit('did-redirect-navigation', 'file:///Users/x/.aws/credentials', false, true)

    expect(wc.stop).toHaveBeenCalled()
    expect(wc.loadURL).toHaveBeenCalledWith('about:blank')
  })

  it('did-redirect-navigation to https does not interrupt the load', () => {
    manager.createInstance('redirect-scheme-ok')
    const instance = (manager as any).instances.get('redirect-scheme-ok')
    const wc = instance.pageView.webContents
    wc.loadURL.mockClear()

    wc._emit('did-redirect-navigation', 'https://ok.com/next', false, true)

    expect(wc.stop).not.toHaveBeenCalled()
  })

  it('popup will-navigate blocks forbidden schemes after opening', () => {
    manager.createInstance('popup-nav-block')
    const instance = (manager as any).instances.get('popup-nav-block')

    const popupWindow = createMockWindow({ width: 520, height: 720 })
    // did-create-window handlers receive (window, details) with no event arg
    for (const cb of instance.pageView.webContents._listeners['did-create-window'] || []) {
      cb(popupWindow, { url: 'https://accounts.google.com/signin' })
    }

    const event = { preventDefault: mock(() => {}) }
    for (const cb of popupWindow.webContents._listeners['will-navigate'] || []) {
      cb(event, 'file:///etc/passwd')
    }

    expect(event.preventDefault).toHaveBeenCalled()
  })

  it('destroys child popups when parent instance is destroyed', () => {
    manager.createInstance('popup-parent')
    const instance = (manager as any).instances.get('popup-parent')

    const popupWindow = createMockWindow({ width: 520, height: 720 })
    // did-create-window handlers receive (window, details) with no event arg
    for (const cb of instance.pageView.webContents._listeners['did-create-window'] || []) {
      cb(popupWindow, { url: 'https://accounts.google.com/signin' })
    }

    expect((manager as any).popupWindowsByParentInstanceId.get('popup-parent')?.size).toBe(1)

    manager.destroyInstance('popup-parent')

    expect(popupWindow.destroy).toHaveBeenCalledTimes(1)
    expect((manager as any).popupWindowsByParentInstanceId.has('popup-parent')).toBe(false)
  })

  it('destroys instances', async () => {
    manager.createInstance('d1')
    manager.destroyInstance('d1')
    expect(await manager.listInstances()).toHaveLength(0)
  })

  it('destroys instance via toolbar destroy IPC handler', async () => {
    manager.createInstance('d-ipc-destroy')
    manager.registerToolbarIpc()

    const destroyRegistration = (
      mockIpcMainHandle.mock.calls as unknown as Array<[
        string,
        (_event: unknown, instanceId: string) => Promise<void>,
      ]>
    ).find(([channel]) => channel === 'browser-toolbar:destroy')

    expect(destroyRegistration).toBeTruthy()
    if (!destroyRegistration) throw new Error('Expected browser-toolbar:destroy IPC registration')

    const [, destroyHandler] = destroyRegistration
    await destroyHandler({}, 'd-ipc-destroy')

    expect(await manager.listInstances()).toHaveLength(0)
  })

  it('emits removed callback exactly once when destroy triggers closed', async () => {
    const removed: string[] = []
    manager.onRemoved((id) => removed.push(id))

    manager.createInstance('d-removed-once')
    manager.destroyInstance('d-removed-once')

    expect(removed).toEqual(['d-removed-once'])
    expect(await manager.listInstances()).toHaveLength(0)
  })

  it('ignores late state events after instance was removed', () => {
    const states: string[] = []
    manager.onStateChange((info) => states.push(info.id))

    manager.createInstance('d-late-state')
    const instance = (manager as any).instances.get('d-late-state')
    states.length = 0

    manager.destroyInstance('d-late-state')
    const countAfterDestroy = states.length

    instance.window._emit('hide')
    instance.window._emit('show')

    expect(states.length).toBe(countAfterDestroy)
  })

  it('binds and unbinds sessions', async () => {
    manager.createInstance('b1')
    manager.bindSession('b1', 'session-abc')
    expect((await manager.listInstances())[0].boundSessionId).toBe('session-abc')
    expect((await manager.listInstances())[0].ownerType).toBe('session')

    manager.unbindSession('b1')
    expect((await manager.listInstances())[0].boundSessionId).toBeNull()
    expect((await manager.listInstances())[0].ownerType).toBe('manual')
  })

  it('createForSession returns canonical bound instance', async () => {
    const id1 = await manager.createForSession('sess-1')
    const id2 = await manager.createForSession('sess-1')
    const info = (await manager.listInstances())[0]

    expect(id1).toBe(id2)
    expect(info.ownerType).toBe('session')
    expect(info.ownerSessionId).toBe('sess-1')
    expect(await manager.listInstances()).toHaveLength(1)
  })

  it('getOrCreateForSession reuses existing instance', async () => {
    const id1 = await manager.getOrCreateForSession('sess-1')
    const id2 = await manager.getOrCreateForSession('sess-1')
    expect(id1).toBe(id2)
    expect(await manager.listInstances()).toHaveLength(1)
  })

  it('createForSession reuses an unbound manual window before creating new', async () => {
    manager.createInstance('manual-1')

    const id = await manager.createForSession('sess-reuse')

    expect(id).toBe('manual-1')
    const info = (await manager.listInstances())[0]
    expect(info.ownerType).toBe('session')
    expect(info.ownerSessionId).toBe('sess-reuse')
    expect(info.boundSessionId).toBe('sess-reuse')
    expect(await manager.listInstances()).toHaveLength(1)
  })

  it('does not adopt a capture-locked manual window', async () => {
    manager.createInstance('recording-1')
    manager.setCaptureLock('recording-1', { reason: 'meeting-recording', since: Date.now() })

    const id = await manager.createForSession('sess-no-steal')

    // A janela em gravação segue manual e intocada; a sessão ganha outra.
    expect(id).not.toBe('recording-1')
    expect(await manager.listInstances()).toHaveLength(2)
    const recording = (await manager.listInstances()).find(info => info.id === 'recording-1')
    expect(recording?.ownerType).toBe('manual')
    expect(recording?.boundSessionId).toBeNull()
    expect(recording?.captureLock).toEqual({ reason: 'meeting-recording', since: expect.any(Number) })
  })

  it('unbinds a capture-locked bound window and gives the session a new one', async () => {
    const bound = await manager.createForSession('sess-locked')
    manager.setCaptureLock(bound, { reason: 'meeting-recording', since: Date.now() })

    const next = await manager.createForSession('sess-locked')

    expect(next).not.toBe(bound)
    const infos = await manager.listInstances()
    const previous = infos.find(info => info.id === bound)
    expect(previous?.boundSessionId).toBeNull()
    expect(previous?.ownerType).toBe('manual')
    // ownerSessionId é preservado: a janela continua rastreável à sessão original.
    expect(previous?.ownerSessionId).toBe('sess-locked')
    expect(infos.find(info => info.id === next)?.boundSessionId).toBe('sess-locked')
  })

  it('clearing the capture lock makes the window adoptable again', async () => {
    manager.createInstance('recording-2')
    manager.setCaptureLock('recording-2', { reason: 'meeting-recording', since: Date.now() })
    manager.setCaptureLock('recording-2', null)

    expect(manager.getCaptureLock('recording-2')).toBeNull()
    expect(await manager.createForSession('sess-after-unlock')).toBe('recording-2')
  })

  it('fires the capture release hook when a locked pane is destroyed', () => {
    const released: string[] = []
    manager.setCaptureReleaseHook((instanceId) => { released.push(instanceId) })

    manager.createInstance('recording-3')
    manager.createInstance('idle-1')
    manager.setCaptureLock('recording-3', { reason: 'meeting-recording', since: Date.now() })

    manager.destroyInstance('idle-1')
    expect(released).toEqual([])

    manager.destroyInstance('recording-3')
    expect(released).toEqual(['recording-3'])
  })

  it('navigate normalizes hostnames to https', async () => {
    manager.createInstance('nav-1')
    await manager.navigate('nav-1', 'example.com')
    const instance = (manager as any).instances.get('nav-1')
    expect(instance.pageView.webContents.loadURL).toHaveBeenCalledWith('https://example.com')
  })

  it('navigate treats plain text as search query', async () => {
    manager.createInstance('nav-2')
    await manager.navigate('nav-2', 'craft agents browser tools')
    const instance = (manager as any).instances.get('nav-2')
    expect(instance.pageView.webContents.loadURL).toHaveBeenCalledWith(
      'https://duckduckgo.com/?q=craft%20agents%20browser%20tools'
    )
  })

  it('clears navigation timeout timer on success', async () => {
    manager.createInstance('nav-timeout')

    const originalClearTimeout = globalThis.clearTimeout
    const clearTimeoutSpy = mock((handle: Parameters<typeof clearTimeout>[0]) => originalClearTimeout(handle))
    ;(globalThis as any).clearTimeout = clearTimeoutSpy

    try {
      await manager.navigate('nav-timeout', 'https://example.com')
      expect(clearTimeoutSpy.mock.calls.length).toBeGreaterThan(0)
    } finally {
      ;(globalThis as any).clearTimeout = originalClearTimeout
    }
  })

  it('focus brings the instance window to front', () => {
    manager.createInstance('f1')
    manager.focus('f1')

    const instance = (manager as any).instances.get('f1')
    instance.toolbarView.webContents.getURL = mock(() => 'file:///mock/renderer/browser-toolbar.html')
    instance.toolbarView.webContents._emit('did-finish-load')

    expect(instance.window.show).toHaveBeenCalled()
    expect(instance.window.focus).toHaveBeenCalled()
  })

  it('dedupes repeated focus calls before ready-to-show', () => {
    manager.createInstance('f2')

    manager.focus('f2')
    manager.focus('f2')
    manager.focus('f2')

    const instance = (manager as any).instances.get('f2')
    instance.toolbarView.webContents.getURL = mock(() => 'file:///mock/renderer/browser-toolbar.html')
    instance.toolbarView.webContents._emit('did-finish-load')

    expect(instance.window.show.mock.calls.length).toBe(1)
    expect(instance.window.focus.mock.calls.length).toBe(1)
  })

  it('cancels deferred pre-ready focus when hide happens first', () => {
    manager.createInstance('f-hide-race')

    manager.focus('f-hide-race')
    manager.hide('f-hide-race')

    const instance = (manager as any).instances.get('f-hide-race')
    const showCallsBeforeReady = instance.window.show.mock.calls.length
    const focusCallsBeforeReady = instance.window.focus.mock.calls.length

    instance.window._emit('ready-to-show')

    expect(instance.window.show.mock.calls.length).toBe(showCallsBeforeReady)
    expect(instance.window.focus.mock.calls.length).toBe(focusCallsBeforeReady)
  })

  it('user close hides window and keeps instance alive', async () => {
    manager.createInstance('h1')
    const instance = (manager as any).instances.get('h1')

    const closeEvent = { preventDefault: mock(() => {}) }
    instance.window._emit('close', closeEvent)

    expect(closeEvent.preventDefault).toHaveBeenCalled()
    expect(instance.window.hide).toHaveBeenCalled()
    expect(await manager.listInstances()).toHaveLength(1)
    expect((await manager.listInstances())[0].isVisible).toBe(false)
  })

  it('does not intercept close when destroy is explicit', () => {
    manager.createInstance('h-explicit-destroy')
    const instance = (manager as any).instances.get('h-explicit-destroy')

    ;(manager as any).destroyingIds.add('h-explicit-destroy')

    const closeEvent = { preventDefault: mock(() => {}) }
    instance.window._emit('close', closeEvent)

    expect(closeEvent.preventDefault).not.toHaveBeenCalled()
    expect(instance.window.hide).not.toHaveBeenCalled()
  })

  it('still destroys instance when cleanup throws', async () => {
    manager.createInstance('destroy-cleanup-throw')
    const instance = (manager as any).instances.get('destroy-cleanup-throw')

    ;(manager as any).updateNativeOverlayState = () => {
      throw new Error('mock overlay cleanup failure')
    }

    expect(() => manager.destroyInstance('destroy-cleanup-throw')).not.toThrow()
    expect(instance.window.destroy).toHaveBeenCalledTimes(1)
    expect(await manager.listInstances()).toHaveLength(0)
  })

  it('emits removed callback when window closes', async () => {
    const removed: string[] = []
    manager.onRemoved((id) => removed.push(id))
    manager.createInstance('r1')

    const instance = (manager as any).instances.get('r1')
    instance.window._emit('closed')

    expect(removed).toEqual(['r1'])
    expect(await manager.listInstances()).toHaveLength(0)
  })

  it('retries toolbar load and recovers', async () => {
    toolbarLoadFailuresRemaining = 2
    manager.createInstance('retry-toolbar')

    await Bun.sleep(1400)

    const instance = (manager as any).instances.get('retry-toolbar')
    const toolbarWc = instance.toolbarView.webContents
    const fileAttempts = toolbarWc.loadFile.mock.calls.length
    const toolbarUrlAttempts = toolbarWc.loadURL.mock.calls
      .filter((args: [string]) => args[0]?.includes('browser-toolbar.html')).length
    const totalAttempts = fileAttempts + toolbarUrlAttempts

    expect(totalAttempts).toBe(3)
    expect(toolbarWc.loadURL).not.toHaveBeenCalledWith(expect.stringContaining('data:text/html'))
  })

  it('loads toolbar fallback page after retry exhaustion', async () => {
    toolbarLoadFailuresRemaining = 20
    manager.createInstance('fallback-toolbar')

    await Bun.sleep(3200)

    const instance = (manager as any).instances.get('fallback-toolbar')
    const toolbarWc = instance.toolbarView.webContents
    const fileAttempts = toolbarWc.loadFile.mock.calls.length
    const toolbarUrlAttempts = toolbarWc.loadURL.mock.calls
      .filter((args: [string]) => args[0]?.includes('browser-toolbar.html')).length
    const totalAttempts = fileAttempts + toolbarUrlAttempts

    expect(totalAttempts).toBe(5)
    expect(toolbarWc.loadURL).toHaveBeenCalledWith(expect.stringContaining('data:text/html'))
  })

  it('captures and filters console entries', async () => {
    manager.createInstance('console-1')
    const instance = (manager as any).instances.get('console-1')

    instance.pageView.webContents._emit('console-message', 2, 'warn message')
    instance.pageView.webContents._emit('console-message', 3, 'error message')

    const allEntries = await manager.getConsoleLogs('console-1', { level: 'all', limit: 10 })
    expect(allEntries).toHaveLength(2)

    const warnEntries = await manager.getConsoleLogs('console-1', { level: 'warn', limit: 10 })
    expect(warnEntries).toHaveLength(1)
    expect(warnEntries[0].message).toBe('warn message')
  })

  it('applies observer theme signal and skips regular console logging for it', async () => {
    manager.createInstance('theme-signal')
    const instance = (manager as any).instances.get('theme-signal')
    instance.themeObserverToken = 'tok-1'

    instance.pageView.webContents._emit('console-message', 1, '__craft_theme_color__:tok-1:#123456')

    expect((await manager.listInstances()).find(i => i.id === 'theme-signal')?.themeColor).toBe('#123456')
    expect(await manager.getConsoleLogs('theme-signal', { level: 'all', limit: 10 })).toHaveLength(0)
  })

  it('replays toolbar state with theme color when window is shown', () => {
    manager.createInstance('theme-show-replay')
    const instance = (manager as any).instances.get('theme-show-replay')

    instance.currentUrl = 'https://example.com'
    instance.title = 'Example'
    instance.canGoBack = true
    instance.canGoForward = false
    instance.themeColor = '#123456'

    const toolbarSend = instance.toolbarView.webContents.send
    const sendsBeforeShow = toolbarSend.mock.calls.length
    instance.window._emit('show')

    const stateUpdate = toolbarSend.mock.calls
      .slice(sendsBeforeShow)
      .find((c: [string, unknown]) => c[0] === 'browser-toolbar:state-update')
    expect(stateUpdate).toBeDefined()
    expect(stateUpdate![1]).toMatchObject({
      url: 'https://example.com',
      title: 'Example',
      isLoading: false,
      canGoBack: true,
      canGoForward: false,
      themeColor: '#123456',
    })
  })

  it('replays full toolbar state when toolbar renderer finishes loading', () => {
    toolbarLoadFailuresRemaining = 20
    manager.createInstance('toolbar-finish-load-replay')
    const instance = (manager as any).instances.get('toolbar-finish-load-replay')

    instance.currentUrl = 'https://craft.do'
    instance.title = 'Craft'
    instance.isLoading = true
    instance.canGoBack = true
    instance.canGoForward = true
    instance.themeColor = '#654321'

    instance.toolbarView.webContents.getURL = mock(() => 'http://localhost:5173/browser-toolbar.html?instanceId=toolbar-finish-load-replay')

    const toolbarSend = instance.toolbarView.webContents.send
    const sendsBeforeFinishLoad = toolbarSend.mock.calls.length
    instance.toolbarView.webContents._emit('did-finish-load')

    const stateUpdate = toolbarSend.mock.calls
      .slice(sendsBeforeFinishLoad)
      .find((c: [string, unknown]) => c[0] === 'browser-toolbar:state-update')
    expect(stateUpdate).toBeDefined()
    expect(stateUpdate![1]).toMatchObject({
      url: 'https://craft.do',
      title: 'Craft',
      isLoading: true,
      canGoBack: true,
      canGoForward: true,
      themeColor: '#654321',
    })
  })

  it('does not mark toolbar ready for about:blank did-finish-load', () => {
    toolbarLoadFailuresRemaining = 20
    manager.createInstance('toolbar-ignore-about-blank')
    const instance = (manager as any).instances.get('toolbar-ignore-about-blank')

    instance.toolbarView.webContents.getURL = mock(() => 'about:blank')
    instance.toolbarView.webContents._emit('did-finish-load')

    expect(instance.toolbarReady).toBe(false)
  })

  it('marks toolbar ready for fallback data page did-finish-load', () => {
    toolbarLoadFailuresRemaining = 20
    manager.createInstance('toolbar-fallback-ready')
    const instance = (manager as any).instances.get('toolbar-fallback-ready')

    instance.toolbarView.webContents.getURL = mock(() => 'data:text/html;charset=UTF-8,%3Chtml%3E%3C%2Fhtml%3E')
    instance.toolbarView.webContents._emit('did-finish-load')

    expect(instance.toolbarReady).toBe(true)
  })

  it('keeps focus deferred until a valid toolbar document loads', () => {
    toolbarLoadFailuresRemaining = 20
    manager.createInstance('toolbar-focus-guard')
    const instance = (manager as any).instances.get('toolbar-focus-guard')

    manager.focus('toolbar-focus-guard')
    expect(instance.pendingShowOnReady).toBe(true)
    expect(instance.window.show).toHaveBeenCalledTimes(0)

    instance.toolbarView.webContents.getURL = mock(() => 'about:blank')
    instance.toolbarView.webContents._emit('did-finish-load')
    expect(instance.window.show).toHaveBeenCalledTimes(0)

    instance.toolbarView.webContents.getURL = mock(() => 'file:///mock/renderer/browser-toolbar.html')
    instance.toolbarView.webContents._emit('did-finish-load')

    expect(instance.toolbarReady).toBe(true)
    expect(instance.window.show).toHaveBeenCalledTimes(1)
    expect(instance.window.focus).toHaveBeenCalledTimes(1)
  })

  it('runs early theme extraction shortly after navigation', async () => {
    manager.createInstance('theme-early')
    const instance = (manager as any).instances.get('theme-early')
    instance.pageView.webContents.executeJavaScript = mock(async () => '#0f1e2d')

    instance.pageView.webContents._emit('did-navigate', 'https://example.com')

    await Bun.sleep(140)

    expect((await manager.listInstances()).find(i => i.id === 'theme-early')?.themeColor).toBe('#0f1e2d')
  })

  it('clears pending in-page theme timer on full navigation', async () => {
    manager.createInstance('theme-timer-clear')
    const instance = (manager as any).instances.get('theme-timer-clear')

    instance.pageView.webContents._emit('did-navigate-in-page', 'https://example.com/route-a')
    await Bun.sleep(0)
    expect(instance.inPageThemeTimer).not.toBeNull()

    instance.pageView.webContents._emit('did-navigate', 'https://example.com/full-nav')
    expect(instance.inPageThemeTimer).toBeNull()
  })

  it('throws when screenshot capture returns empty NativeImage', async () => {
    manager.createInstance('screenshot-empty-image')
    const instance = (manager as any).instances.get('screenshot-empty-image')
    instance.pageView.webContents.capturePage = mock(async () => ({
      isEmpty: () => true,
      getSize: () => ({ width: 0, height: 0 }),
      resize: function() { return this },
      toPNG: () => Buffer.from('ignored'),
      toJPEG: () => Buffer.from('ignored'),
    }))

    await expect(manager.screenshot('screenshot-empty-image')).rejects.toThrow('Failed to capture screenshot: empty image buffer')
  })

  it('throws when screenshot capture returns empty PNG buffer', async () => {
    manager.createInstance('screenshot-empty-png')
    const instance = (manager as any).instances.get('screenshot-empty-png')
    instance.pageView.webContents.capturePage = mock(async () => ({
      isEmpty: () => false,
      getSize: () => ({ width: 2400, height: 1800 }),
      resize: function() { return this },
      toPNG: () => Buffer.alloc(0),
      toJPEG: () => Buffer.alloc(0),
    }))

    await expect(manager.screenshot('screenshot-empty-png')).rejects.toThrow('Failed to capture screenshot: empty image buffer')
  })

  it('times out instead of hanging when screenshot capture never resolves', async () => {
    manager.createInstance('screenshot-timeout')
    const instance = (manager as any).instances.get('screenshot-timeout')
    instance.pageView.webContents.capturePage = mock(() => new Promise(() => {}))

    await expect(manager.screenshot('screenshot-timeout')).rejects.toThrow('Timed out capturing screenshot after 50ms')
  })

  it('recovers screenshot via non-disruptive inactive reveal and restores hidden state', async () => {
    manager.createInstance('screenshot-rescue-success')
    const instance = (manager as any).instances.get('screenshot-rescue-success')

    let captureCalls = 0
    instance.pageView.webContents.capturePage = mock(async () => {
      captureCalls += 1
      if (captureCalls <= 3) {
        return {
          isEmpty: () => true,
          getSize: () => ({ width: 0, height: 0 }),
          resize: function() { return this },
          toPNG: () => Buffer.alloc(0),
          toJPEG: () => Buffer.alloc(0),
        }
      }

      const img = {
        isEmpty: () => false,
        getSize: () => ({ width: 2400, height: 1800 }),
        resize: () => img,
        toPNG: () => Buffer.from('rescued-png'),
        toJPEG: (_q: number) => Buffer.from('rescued-jpeg'),
      }
      return img
    })

    const result = await manager.screenshot('screenshot-rescue-success', { includeMetadata: true })

    expect(result.imageBuffer.toString()).toBe('rescued-png')
    expect(instance.window.showInactive).toHaveBeenCalledTimes(1)
    expect(instance.window.focus).not.toHaveBeenCalled()
    expect(instance.window.hide).toHaveBeenCalled()
    expect(result.metadata?.warnings?.some((w: string) => w.includes('temporary inactive reveal'))).toBe(true)
  })

  it('throws when region screenshot capture returns empty NativeImage', async () => {
    manager.createInstance('region-empty-image')
    const instance = (manager as any).instances.get('region-empty-image')
    instance.pageView.webContents.capturePage = mock(async () => ({
      isEmpty: () => true,
      getSize: () => ({ width: 0, height: 0 }),
      resize: function() { return this },
      toPNG: () => Buffer.from('ignored'),
      toJPEG: () => Buffer.from('ignored'),
    }))

    await expect(manager.screenshotRegion('region-empty-image', { x: 10, y: 20, width: 120, height: 80 })).rejects.toThrow(
      'Failed to capture region screenshot: empty image buffer'
    )
  })

  it('throws when region screenshot capture returns empty PNG buffer', async () => {
    manager.createInstance('region-empty-png')
    const instance = (manager as any).instances.get('region-empty-png')
    instance.pageView.webContents.capturePage = mock(async () => ({
      isEmpty: () => false,
      getSize: () => ({ width: 2400, height: 1800 }),
      resize: function() { return this },
      toPNG: () => Buffer.alloc(0),
      toJPEG: () => Buffer.alloc(0),
    }))

    await expect(manager.screenshotRegion('region-empty-png', { x: 10, y: 20, width: 120, height: 80 })).rejects.toThrow(
      'Failed to capture region screenshot: empty image buffer'
    )
  })

  it('captures screenshot region from ref target', async () => {
    manager.createInstance('region-ref')
    const result = await manager.screenshotRegion('region-ref', { ref: '@e1' })

    expect(result.imageBuffer).toBeInstanceOf(Buffer)
    expect(result.metadata?.targetMode).toBe('ref')
  })

  it('captures screenshot region from selector target', async () => {
    manager.createInstance('region-selector')
    const result = await manager.screenshotRegion('region-selector', { selector: 'div.card', padding: 4 })

    expect(result.imageBuffer).toBeInstanceOf(Buffer)
    expect(result.metadata?.targetMode).toBe('selector')
  })

  it('throws for ambiguous screenshot region target modes', async () => {
    manager.createInstance('region-ambiguous')

    await expect(
      manager.screenshotRegion('region-ambiguous', { ref: '@e1', selector: 'div.card' })
    ).rejects.toThrow('Region screenshot target is ambiguous')
  })

  it('throws when selector target cannot be resolved', async () => {
    manager.createInstance('region-selector-missing')
    const instance = (manager as any).instances.get('region-selector-missing')
    instance.cdp.getElementGeometryBySelector = mock(async () => {
      throw new Error('No element found for selector "div.missing"')
    })

    await expect(
      manager.screenshotRegion('region-selector-missing', { selector: 'div.missing' })
    ).rejects.toThrow('No element found for selector "div.missing"')
  })

  it('throws when resolved region is outside viewport', async () => {
    manager.createInstance('region-oob')

    await expect(
      manager.screenshotRegion('region-oob', { x: 5000, y: 5000, width: 100, height: 100 })
    ).rejects.toThrow('Resolved screenshot region is outside the current viewport')
  })

  it('resizes browser window viewport and returns effective applied size', async () => {
    manager.createInstance('resize-1')
    const resized = await manager.windowResize('resize-1', 1280, 720)

    const instance = (manager as any).instances.get('resize-1')
    expect(instance.window.setContentSize).toHaveBeenCalledWith(1280, 768)
    expect(resized).toEqual({ width: 1280, height: 720 })
  })

  it('returns effective viewport size when min window constraints apply', async () => {
    manager.createInstance('resize-min')
    const resized = await manager.windowResize('resize-min', 200, 200)

    // BrowserWindow minHeight is 500, toolbar is 48, so effective viewport height is 452.
    expect(resized).toEqual({ width: 700, height: 452 })
  })

  describe('evaluate gate (allowRemoteEvaluate)', () => {
    // The gate is enforced inside evaluate() itself — the single seam both the
    // local path (SessionManager → this) and the remote path (dispatch → this)
    // cross. This test fails if the gate ever moves back to only the dispatcher
    // and the local path slips under it: it rejects with the GATE error, which
    // only fires because the check runs before the instance lookup.
    it('rejects on the local path when allowRemoteEvaluate=false — single unified gate', async () => {
      manager.createInstance('eval-gate')
      mockAllowRemoteEvaluate = false
      await expect(manager.evaluate('eval-gate', '1 + 1')).rejects.toThrow(/allowRemoteEvaluate=false/)
    })

    it('rejects before touching the instance when the gate is closed', async () => {
      mockAllowRemoteEvaluate = false
      await expect(manager.evaluate('never-created', '1 + 1')).rejects.toThrow(/allowRemoteEvaluate=false/)
    })

    it('runs the evaluation when allowRemoteEvaluate=true', async () => {
      manager.createInstance('eval-ok')
      await expect(manager.evaluate('eval-ok', '1 + 1')).resolves.toBeUndefined()
    })
  })

  describe('agent control overlay', () => {
    it('setAgentControl activates native overlay on bound instance', async () => {
      manager.createInstance('ac-1')
      manager.bindSession('ac-1', 'sess-1')

      manager.setAgentControl('sess-1', { displayName: 'Navigate Page', intent: 'Loading example.com' })
      await Promise.resolve()

      const instance = (manager as any).instances.get('ac-1')
      expect(instance.agentControl).toEqual({
        active: true,
        sessionId: 'sess-1',
        displayName: 'Navigate Page',
        intent: 'Loading example.com',
      })
      expect(instance.nativeOverlayView.webContents.executeJavaScript).toHaveBeenCalled()
      expect(instance.nativeOverlayView.webContents.focus).not.toHaveBeenCalled()
      expect((await manager.listInstances()).find(i => i.id === 'ac-1')?.agentControlActive).toBe(true)
    })

    it('keeps native overlay visible for active session control', async () => {
      manager.createInstance('ac-idle')
      manager.bindSession('ac-idle', 'sess-idle')

      manager.setAgentControl('sess-idle', {
        displayName: 'Browser',
        intent: 'Session controls this window',
      })
      await Promise.resolve()

      const instance = (manager as any).instances.get('ac-idle')
      expect(instance.nativeOverlayView.setBounds).toHaveBeenCalledWith({ x: 0, y: 48, width: 1200, height: 852 })
      expect(instance.nativeOverlayView.webContents.focus).not.toHaveBeenCalled()
      expect((await manager.listInstances()).find(i => i.id === 'ac-idle')?.agentControlActive).toBe(true)
    })

    it('emits state change when agent control is set and cleared', () => {
      const stateEvents: any[] = []
      manager.onStateChange((info) => stateEvents.push(info))

      manager.createInstance('ac-state')
      manager.bindSession('ac-state', 'sess-state')

      manager.setAgentControl('sess-state', { displayName: 'Browser Snapshot' })
      manager.clearAgentControl('sess-state')

      const acStateEvents = stateEvents.filter((event) => event.id === 'ac-state')
      expect(acStateEvents.some((event) => event.agentControlActive === true)).toBe(true)
      expect(acStateEvents.some((event) => event.agentControlActive === false)).toBe(true)
    })

    it('reapplies native overlay after did-stop-loading while control is active', async () => {
      manager.createInstance('ac-reapply')
      manager.bindSession('ac-reapply', 'sess-reapply')

      manager.setAgentControl('sess-reapply', { displayName: 'Navigate Page', intent: 'Loading example.com' })
      await Promise.resolve()

      const instance = (manager as any).instances.get('ac-reapply')
      const callCountAfterSet = instance.nativeOverlayView.webContents.executeJavaScript.mock.calls.length

      instance.pageView.webContents._emit('did-stop-loading')
      await Promise.resolve()

      expect(instance.nativeOverlayView.webContents.executeJavaScript.mock.calls.length).toBeGreaterThan(callCountAfterSet)
    })

    it('reapplies native overlay after hide/show while control is active', async () => {
      manager.createInstance('ac-show-reapply')
      manager.bindSession('ac-show-reapply', 'sess-show-reapply')

      manager.setAgentControl('sess-show-reapply', { displayName: 'Click Button', intent: 'Clicking submit' })
      await Promise.resolve()

      const instance = (manager as any).instances.get('ac-show-reapply')
      const callCountAfterSet = instance.nativeOverlayView.webContents.executeJavaScript.mock.calls.length

      instance.window._emit('hide')
      instance.window._emit('show')
      await Promise.resolve()

      expect(instance.nativeOverlayView.webContents.executeJavaScript.mock.calls.length).toBeGreaterThan(callCountAfterSet)
    })

    it('setAgentControl uses fallback label when no intent', async () => {
      manager.createInstance('ac-2')
      manager.bindSession('ac-2', 'sess-2')

      manager.setAgentControl('sess-2', { displayName: 'Browser Snapshot' })
      await Promise.resolve()

      const instance = (manager as any).instances.get('ac-2')
      const calls = instance.nativeOverlayView.webContents.executeJavaScript.mock.calls
      expect(calls.length).toBeGreaterThan(0)
      expect(String(calls[calls.length - 1][0])).toContain('Browser Snapshot')
    })

    it('setAgentControl uses default label when no metadata', async () => {
      manager.createInstance('ac-3')
      manager.bindSession('ac-3', 'sess-3')

      manager.setAgentControl('sess-3', {})
      await Promise.resolve()

      const instance = (manager as any).instances.get('ac-3')
      const calls = instance.nativeOverlayView.webContents.executeJavaScript.mock.calls
      expect(calls.length).toBeGreaterThan(0)
      expect(String(calls[calls.length - 1][0])).toContain('Agent is working…')
    })

    it('clearAgentControl dismisses native overlay', () => {
      manager.createInstance('ac-4')
      manager.bindSession('ac-4', 'sess-4')

      manager.setAgentControl('sess-4', { displayName: 'Click Button', intent: 'Clicking submit' })
      manager.clearAgentControl('sess-4')

      const instance = (manager as any).instances.get('ac-4')
      expect(instance.agentControl).toBeNull()
      expect(instance.nativeOverlayView.setBounds).toHaveBeenCalledWith({ x: 0, y: 0, width: 0, height: 0 })
    })

    it('clearAgentControl is a no-op when not active', () => {
      manager.createInstance('ac-5')
      manager.bindSession('ac-5', 'sess-5')

      manager.clearAgentControl('sess-5')

      const instance = (manager as any).instances.get('ac-5')
      expect(instance.nativeOverlayView.webContents.executeJavaScript).not.toHaveBeenCalled()
    })

    it('clearVisualsForSession resets agent control state', async () => {
      manager.createInstance('ac-6')
      manager.bindSession('ac-6', 'sess-6')

      manager.setAgentControl('sess-6', { displayName: 'Fill Input', intent: 'Typing email' })
      await manager.clearVisualsForSession('sess-6')

      const instance = (manager as any).instances.get('ac-6')
      expect(instance.agentControl).toBeNull()
      expect(instance.nativeOverlayView.setBounds).toHaveBeenCalledWith({ x: 0, y: 0, width: 0, height: 0 })
    })

    it('setAgentControl ignores unbound sessions', () => {
      manager.createInstance('ac-7')

      manager.setAgentControl('nonexistent-session', { displayName: 'Test' })

      const instance = (manager as any).instances.get('ac-7')
      expect(instance.agentControl).toBeNull()
      expect(instance.nativeOverlayView.webContents.executeJavaScript).not.toHaveBeenCalled()
    })

    it('navigate does not trigger overlay by itself', async () => {
      manager.createInstance('ac-8')
      manager.bindSession('ac-8', 'sess-8')

      await manager.navigate('ac-8', 'https://example.com')

      const instance = (manager as any).instances.get('ac-8')
      expect(instance.agentControl).toBeNull()
      expect(instance.nativeOverlayView.webContents.executeJavaScript).not.toHaveBeenCalled()
    })
  })

  describe('failed interaction tracking', () => {
    it('clickElement records failed lastAction on error', async () => {
      manager.createInstance('fail-click')
      const instance = (manager as any).instances.get('fail-click')
      instance.cdp.clickElement = mock(async () => { throw new Error('click failed') })

      await expect(manager.clickElement('fail-click', '@e1')).rejects.toThrow('click failed')

      expect(instance.lastAction).toMatchObject({
        tool: 'browser_click',
        ref: '@e1',
        status: 'failed',
      })
    })

    it('fillElement records failed lastAction on error', async () => {
      manager.createInstance('fail-fill')
      const instance = (manager as any).instances.get('fail-fill')
      instance.cdp.fillElement = mock(async () => { throw new Error('fill failed') })

      await expect(manager.fillElement('fail-fill', '@e2', 'hello')).rejects.toThrow('fill failed')

      expect(instance.lastAction).toMatchObject({
        tool: 'browser_fill',
        ref: '@e2',
        status: 'failed',
      })
    })

    it('selectOption records failed lastAction on error', async () => {
      manager.createInstance('fail-select')
      const instance = (manager as any).instances.get('fail-select')
      instance.cdp.selectOption = mock(async () => { throw new Error('select failed') })

      await expect(manager.selectOption('fail-select', '@e3', 'opt-1')).rejects.toThrow('select failed')

      expect(instance.lastAction).toMatchObject({
        tool: 'browser_select',
        ref: '@e3',
        status: 'failed',
      })
    })
  })

  // SECURITY (auditoria 2026-07-14): browser agêntico endurecido contra a cadeia
  // de exfiltração de credenciais via prompt-injection. Findings F1.1 e F1.3.
  describe('agentic security hardening', () => {
    it('navigate rejects file:// scheme (F1.1 — local file read)', async () => {
      manager.createInstance('sec-file')
      await expect(manager.navigate('sec-file', 'file:///etc/passwd')).rejects.toThrow(/scheme "file:" is not allowed/)
      const instance = (manager as any).instances.get('sec-file')
      expect(instance.pageView.webContents.loadURL).not.toHaveBeenCalledWith('file:///etc/passwd')
    })

    it('navigate rejects chrome:// scheme (F1.1)', async () => {
      manager.createInstance('sec-chrome')
      await expect(manager.navigate('sec-chrome', 'chrome://settings')).rejects.toThrow(/scheme "chrome:" is not allowed/)
    })

    it('navigate allows https (F1.1 — legit traffic unaffected)', async () => {
      manager.createInstance('sec-https')
      await manager.navigate('sec-https', 'https://example.com')
      const instance = (manager as any).instances.get('sec-https')
      expect(instance.pageView.webContents.loadURL).toHaveBeenCalledWith('https://example.com')
    })

    it('windowOpen denies non-http popup schemes (F1.1)', () => {
      manager.createInstance('sec-popup')
      const instance = (manager as any).instances.get('sec-popup')
      const openHandler = instance.pageView.webContents.setWindowOpenHandler.mock.calls[0][0]

      const result = openHandler({ url: 'file:///Users/victim/.aws/credentials', disposition: 'new-popup', frameName: '' })
      expect(result).toEqual({ action: 'deny' })
    })

    it('registers permission handler for every distinct partition (F1.3)', () => {
      const sesA = { setPermissionCheckHandler: mock(() => {}), setPermissionRequestHandler: mock(() => {}), setDisplayMediaRequestHandler: mock(() => {}) }
      const sesB = { setPermissionCheckHandler: mock(() => {}), setPermissionRequestHandler: mock(() => {}), setDisplayMediaRequestHandler: mock(() => {}) }

      ;(manager as any).setupSessionPermissions(sesA)
      ;(manager as any).setupSessionPermissions(sesB)

      // The old boolean guard only registered the FIRST partition; second fell
      // through to Electron's permissive default. Both must register now.
      expect(sesA.setPermissionRequestHandler).toHaveBeenCalledTimes(1)
      expect(sesB.setPermissionRequestHandler).toHaveBeenCalledTimes(1)
    })

    it('is idempotent per partition (F1.3 — no double registration)', () => {
      const ses = { setPermissionCheckHandler: mock(() => {}), setPermissionRequestHandler: mock(() => {}), setDisplayMediaRequestHandler: mock(() => {}) }
      ;(manager as any).setupSessionPermissions(ses)
      ;(manager as any).setupSessionPermissions(ses)
      expect(ses.setPermissionRequestHandler).toHaveBeenCalledTimes(1)
    })
  })
})
