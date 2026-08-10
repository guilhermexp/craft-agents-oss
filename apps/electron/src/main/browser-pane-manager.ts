/**
 * BrowserPaneManager
 *
 * Owns browser instances as dedicated BrowserWindow objects.
 * Each instance maps 1:1 to a full native window while preserving
 * shared session/cookie partition and CDP automation support.
 */

import { join, parse as parsePath } from 'path'
import { existsSync, mkdirSync } from 'fs'
import { Readable } from 'stream'
import { validateFilePath, getWorkspaceAllowedDirs } from '@craft-agent/server-core/handlers'
import { BrowserWindow, WebContentsView, app, ipcMain, nativeTheme, net, session, shell, webContents, type Session as ElectronSession, type Streams } from 'electron'
import { mainLog } from './logger'
import type { WindowManager } from './window-manager'
import { BrowserCDP, type AccessibilitySnapshot, type ElementGeometry } from './browser-cdp'
import { BrowserVisualCapture } from './browser/browser-visual-capture'
import { BrowserToolbarHost } from './browser/toolbar-host'
import { BrowserThemeExtractor } from './browser/theme-extractor'
import { normalizeChromeClientHints } from './browser-client-hints'
import {
  type BrowserEmptyStateLaunchPayload,
  type BrowserEmptyStateLaunchResult,
  type BrowserInstanceInfo,
} from '../shared/types'
import { DEFAULT_THEME, loadAppTheme, getAllowRemoteEvaluate } from '@craft-agent/shared/config'
import { CodedError } from '@craft-agent/shared/protocol'
import { getBrowserLiveFxCornerRadii } from '../shared/browser-live-fx'
import type { IBrowserPaneManager, BrowserInstanceSnapshot } from '@craft-agent/server-core/handlers'
import type { BrowserCapabilityRequest, BrowserCapabilityMethod, ScreenshotResultWire } from '@craft-agent/server-core/transport'

export type { BrowserInstanceInfo }

const VITE_DEV_SERVER_URL = process.env.VITE_DEV_SERVER_URL
const TOOLBAR_HEIGHT = 48
/** Embedded session panel: default and the floors that keep both sides usable. */
const DEFAULT_SESSION_PANEL_WIDTH = 420
const MIN_SESSION_PANEL_WIDTH = 320
const MIN_PAGE_WIDTH = 400
const MAX_CONSOLE_LOG_ENTRIES = 500
const MAX_NETWORK_LOG_ENTRIES = 500
const MAX_DOWNLOAD_LOG_ENTRIES = 200
const DEFAULT_WAIT_TIMEOUT_MS = 10_000
const DEFAULT_WAIT_POLL_MS = 100
const BROWSER_EMPTY_STATE_PAGE = 'browser-empty-state.html'

import { TOOLBAR_CHANNELS } from '../shared/browser-toolbar-channels'
import { BROWSER_CHROME_BG, PANEL_INTERIOR_RADIUS } from '../shared/browser-chrome'
import { isAllowedTopLevelUrl, CRAFT_DEEPLINK_SCHEME_PREFIX, decideWillNavigate, decideWindowOpen } from './browser/navigation-policy'
import { hardenSessionPermissions } from './browser/partition-hardening'
import {
  fetchFaviconDataUrl,
  firstHeaderValue,
  isFetchableFaviconUrl,
  shouldFollowFaviconRedirect,
  type FaviconFetcher,
  type FaviconHttpResponse,
} from './browser/favicon-transport'
import {
  getProfilePartition,
  DEFAULT_BROWSER_PROFILE_PARTITION,
} from './browser-profile-resolver'
import {
  DEFAULT_BROWSER_PROFILE_ID,
  type BrowserProfile,
  type BrowserProfileSettings,
} from '@craft-agent/shared/config/types'
import {
  sanitizeBrowserProfileInput,
  type BrowserProfileInput,
} from '@craft-agent/shared/config/browser-profiles'
import {
  getBrowserProfiles,
  setBrowserProfiles,
  getBrowserProfileSettings,
  setLastUsedBrowserProfileId,
  setBrowserPickerAlwaysAsk,
} from '@craft-agent/shared/config'
import { applyProxyToProfilePartition } from './network-proxy'
import { randomUUID } from 'crypto'

/**
 * Favicon candidates tried per announcement.
 *
 * `page-favicon-updated` hands us the page's whole candidate list, and the
 * content-type allowlist rejects SVG — so a site that lists `favicon.svg`
 * first must still be able to reach its PNG/ICO. Attempts stay sequential and
 * single-in-flight, so the cap is what bounds the worst case at four timeouts.
 */
const FAVICON_MAX_CANDIDATES = 4

/**
 * Legacy export — preserved for callers that still depend on a single
 * partition string (e.g. network-proxy bootstrap before profiles are loaded).
 * Equivalent to `getProfilePartition(DEFAULT_BROWSER_PROFILE_ID)`.
 */
export const BROWSER_PANE_SESSION_PARTITION = DEFAULT_BROWSER_PROFILE_PARTITION

interface AgentControlState {
  active: boolean
  sessionId: string
  displayName?: string
  intent?: string
}

interface AgentControlLockState {
  active: boolean
  previousResizable: boolean
}

/**
 * Marca um pane cuja tela está sendo capturada (gravação de reunião). Enquanto
 * existe, o pane não pode ser adotado por sessão de agente: navegar a página
 * não encerra as faixas capturadas — a gravação continuaria, gravando a tela do
 * agente no mesmo arquivo.
 */
export interface BrowserPaneCaptureLock {
  reason: 'meeting-recording'
  since: number
}

export type BrowserDisplayMode = 'floating' | 'integrated'

export interface EmbeddedBounds {
  x: number
  y: number
  width: number
  height: number
}

export interface BrowserInstance {
  id: string
  profileId: string
  workspaceId: string | null
  window: BrowserWindow
  toolbarView: WebContentsView
  pageView: WebContentsView
  nativeOverlayView: WebContentsView
  /**
   * `floating` keeps the views in the instance's own frameless window (the
   * historical behaviour). `integrated` reparents them into a host window's
   * contentView so they render as a card inside the app, positioned by bounds
   * the renderer measures. The WebContents survive the move, so the page keeps
   * its session, scroll position and navigation history.
   */
  /**
   * Craft's own renderer, embedded as a sibling view on the right of the page.
   * Created lazily — a second full renderer is not free, so browsers that never
   * open the panel never pay for it.
   */
  sessionView: WebContentsView | null
  /** Panel width in DIPs, or null when closed. */
  sessionPanelWidth: number | null
  displayMode: BrowserDisplayMode
  /**
   * True when docking hid the instance's own window. Undocking hands the views
   * back to that window, so without this the browser would simply vanish —
   * alive, listed in the tab strip, painting into something invisible.
   */
  hiddenByIntegration: boolean
  /** Window the views are currently parented to while integrated. */
  hostWindow: BrowserWindow | null
  /** Card rect in host content coordinates (DIPs). Null until the renderer reports it. */
  embeddedBounds: EmbeddedBounds | null
  /** Radius currently applied to every native view, in DIPs. */
  viewRadius: number
  cdp: BrowserCDP
  currentUrl: string
  title: string
  /**
   * Validated `data:` URL, never the URL the page asked for — see
   * `browser/favicon-transport.ts` for why the raw URL stays in main.
   */
  favicon: string | null
  /**
   * The page's whole candidate announcement, joined. Pages re-announce the same
   * list on every SPA route change, so this is what dedupes them.
   */
  faviconCandidateKey: string | null
  /** Monotonic per-instance token; a fetch whose token went stale is dropped. */
  faviconToken: number
  /** Aborts the in-flight favicon fetch on navigation or destroy. */
  faviconAbort: AbortController | null
  isLoading: boolean
  canGoBack: boolean
  canGoForward: boolean
  boundSessionId: string | null
  ownerType: 'session' | 'manual'
  ownerSessionId: string | null
  isVisible: boolean
  /** Não-nulo enquanto uma captura de tela está ativa neste pane. */
  captureLock: BrowserPaneCaptureLock | null
  keepAliveOnWindowClose: boolean
  toolbarReady: boolean
  toolbarMenuOpen: boolean
  toolbarMenuHeight: number
  toolbarMenuOverlayActive: boolean
  showOnCreate: boolean
  pendingShowOnReady: boolean
  pendingShowToken: number
  lastAction: LastBrowserAction | null
  agentControl: AgentControlState | null
  lockState: AgentControlLockState
  nativeOverlayReady: boolean
  themeColor: string | null
  inPageThemeTimer: ReturnType<typeof setTimeout> | null
  themeObserverToken: string | null
  consoleLogs: BrowserConsoleEntry[]
  networkLogs: BrowserNetworkEntry[]
  downloads: BrowserDownloadEntry[]
  lastLaunchToken: string | null
  navigationPolicy?: BrowserNavigationPolicy
}

export type BrowserNavigationDecision =
  | { action: 'allow' }
  | { action: 'deny'; reason?: string }
  | { action: 'external'; reason?: string }

export interface BrowserNavigationPolicy {
  willNavigate?(url: string): BrowserNavigationDecision
  windowOpen?(url: string): BrowserNavigationDecision
}

interface CreateBrowserInstanceOptions {
  show?: boolean
  workspaceId?: string | null
  ownerType?: 'session' | 'manual'
  ownerSessionId?: string
  /** Initial URL to load instead of the browser empty-state page. */
  url?: string
  /**
   * Browser profile id (controls session partition isolation). When omitted,
   * resolves to the default profile, which uses the legacy partition string.
   */
  profileId?: string
  navigationPolicy?: BrowserNavigationPolicy
}

export interface BrowserScreenshotOptions {
  mode?: 'raw' | 'agent'
  refs?: string[]
  includeLastAction?: boolean
  includeMetadata?: boolean
  /** Annotate screenshot with @eN labels on all interactive elements from accessibility tree */
  annotate?: boolean
  format?: 'png' | 'jpeg'
  jpegQuality?: number
}

export interface BrowserConsoleEntry {
  timestamp: number
  level: 'log' | 'info' | 'warn' | 'error'
  message: string
}

export interface BrowserConsoleOptions {
  level?: 'all' | BrowserConsoleEntry['level']
  limit?: number
}

export interface BrowserScreenshotRegionTarget {
  x?: number
  y?: number
  width?: number
  height?: number
  ref?: string
  selector?: string
  padding?: number
  format?: 'png' | 'jpeg'
  jpegQuality?: number
}

export interface BrowserNetworkEntry {
  timestamp: number
  method: string
  url: string
  status: number
  resourceType: string
  ok: boolean
}

export interface BrowserNetworkOptions {
  limit?: number
  status?: 'all' | 'failed' | '2xx' | '3xx' | '4xx' | '5xx'
  method?: string
  resourceType?: string
}

export interface BrowserWaitArgs {
  kind: 'selector' | 'text' | 'url' | 'network-idle'
  value?: string
  timeoutMs?: number
  pollMs?: number
  idleMs?: number
}

export interface BrowserWaitResult {
  ok: true
  kind: BrowserWaitArgs['kind']
  elapsedMs: number
  detail: string
}

export interface BrowserKeyArgs {
  key: string
  modifiers?: Array<'shift' | 'control' | 'alt' | 'meta'>
}

export interface BrowserDownloadEntry {
  id: string
  timestamp: number
  url: string
  filename: string
  state: 'started' | 'completed' | 'interrupted' | 'cancelled'
  bytesReceived: number
  totalBytes: number
  mimeType: string
  savePath?: string
}

export interface BrowserDownloadOptions {
  action?: 'list' | 'wait'
  limit?: number
  timeoutMs?: number
}

export interface BrowserScreenshotResult {
  imageBuffer: Buffer
  imageFormat: 'png' | 'jpeg'
  metadata?: {
    mode: 'raw' | 'agent'
    viewport?: {
      width: number
      height: number
      dpr: number
      scrollX: number
      scrollY: number
    }
    targets?: Array<{
      ref: string
      role?: string
      name?: string
      box: { x: number; y: number; width: number; height: number }
      clickPoint: { x: number; y: number }
    }>
    action?: {
      tool: string
      ref?: string
      status: 'succeeded' | 'failed'
      timestamp: number
    }
    annotationPartial?: boolean
    warnings?: string[]
    region?: {
      x: number
      y: number
      width: number
      height: number
    }
    targetMode?: 'coords' | 'ref' | 'selector'
  }
}

interface LastBrowserAction {
  tool: string
  ref?: string
  status: 'succeeded' | 'failed'
  geometry?: ElementGeometry
  timestamp: number
}

let instanceCounter = 0

/** Context passed to every capability handler in {@link BrowserPaneManager.capabilityDispatch}. */
interface CapabilityContext {
  /** Owner-key namespace for this (workspaceId, sessionId) — see {@link BrowserPaneManager.toOwnerKey}. */
  readonly ownerKey: string
  readonly workspaceId: string
}

/** One wire-capability handler: unpacks positional args and runs the local method. */
type CapabilityHandler = (args: unknown[], ctx: CapabilityContext) => unknown

export class BrowserPaneManager implements IBrowserPaneManager {
  private instances: Map<string, BrowserInstance> = new Map()
  private destroyingIds: Set<string> = new Set()
  private stateChangeCallback: ((info: BrowserInstanceInfo) => void) | null = null
  private removedCallback: ((id: string) => void) | null = null
  private interactedCallback: ((id: string) => void) | null = null
  private captureReleaseHook: ((browserInstanceId: string) => void) | null = null
  private profilesChangeCallback: ((settings: BrowserProfileSettings) => void) | null = null
  private profileManagementRequestCallback: ((instanceId: string) => void) | null = null
  private displayModeRequestCallback: ((instanceId: string, mode: BrowserDisplayMode) => void) | null = null
  // SECURITY (auditoria 2026-07-14): dedup POR partition, não por instância.
  // O guard booleano antigo só registrava o handler na 1ª partition; profiles
  // secundários caíam no default permissivo do Electron. `session.fromPartition`
  // devolve o mesmo objeto por partition, então o WeakSet dedupe por partition.
  private readonly configuredPermissionSessions = new WeakSet<ElectronSession>()
  // Dedupe the Sec-CH-UA normalization handler per partition (same rationale as
  // configuredPermissionSessions — one onBeforeSendHeaders handler per session).
  private readonly configuredClientHintSessions = new WeakSet<ElectronSession>()
  // Dedupe permission-denial logs: a page's service workers re-request the same
  // always-denied permissions (web-app-installation, background-sync) on a timer —
  // sometimes for many minutes after the pane is gone — which floods the log with
  // identical lines. We log each unique kind:permission:origin once.
  private loggedPermissionDenials = new Set<string>()
  private partitionObserversInitialized = false
  private inFlightRequestsByWebContentsId = new Map<number, number>()
  private lastNetworkActivityByWebContentsId = new Map<number, number>()
  private popupWindowsByParentInstanceId = new Map<string, Set<BrowserWindow>>()
  private popupParentByWebContentsId = new Map<number, string>()
  // webContents id captured while the popup window is still alive. Popup
  // teardown ('closed' / parent-destroy) races Electron's lifecycle where the
  // window's webContents is already destroyed, so reading `webContents.id` there
  // throws "Object has been destroyed". Look the id up here instead.
  private readonly popupWebContentsIdByWindow = new WeakMap<BrowserWindow, number>()
  private windowManager: WindowManager | null = null
  private sessionPathResolver: ((sessionId: string) => string | null) | null = null

  /** Screenshot capture pipeline (full-page, region, recovery, encoding). */
  private visualCapture = new BrowserVisualCapture({
    requireAliveInstance: (id) => this.requireAliveInstance(id),
    getInstance: (id) => this.instances.get(id),
    emitStateChange: (instance) => this.emitStateChange(instance),
    updateNativeOverlayState: (instance) => this.updateNativeOverlayState(instance),
    waitFor: (id, args) => this.waitFor(id, args),
    sleep: (ms) => this.sleep(ms),
  })

  /** Toolbar surface: load/retry/fallback, state DTO push, ready gating, IPC. */
  private toolbarHost = new BrowserToolbarHost({
    getInstance: (id) => this.instances.get(id),
    listProfiles: () => this.listProfiles(),
    navigate: (id, url) => this.navigate(id, url),
    goBack: (id) => this.goBack(id),
    goForward: (id) => this.goForward(id),
    reload: (id) => this.reload(id),
    stop: (id) => this.stop(id),
    hide: (id) => this.hide(id),
    destroyInstance: (id) => this.destroyInstance(id),
    forceCloseToolbarMenu: (instance, reason) => this.forceCloseToolbarMenu(instance, reason),
    layoutAllViews: (instance) => this.layoutAllViews(instance),
    switchProfile: (instanceId, targetProfileId) => this.switchProfile(instanceId, targetProfileId),
    requestProfileManagement: (instanceId) => this.profileManagementRequestCallback?.(instanceId),
    toggleSessionPanel: (instanceId) => this.toggleSessionPanel(instanceId),
    requestDisplayMode: (instanceId, mode) => this.displayModeRequestCallback?.(instanceId, mode),
    emitStateChange: (instance) => this.emitStateChange(instance),
    sleep: (ms) => this.sleep(ms),
  })

  /** Theme-color derivation: one-shot extract, in-page observer, apply/dedupe. */
  private themeExtractor = new BrowserThemeExtractor({
    hasInstance: (id) => this.instances.has(id),
    emitStateChange: (instance) => this.emitStateChange(instance),
  })

  setWindowManager(windowManager: WindowManager): void {
    this.windowManager = windowManager
  }

  setSessionPathResolver(fn: (sessionId: string) => string | null): void {
    this.sessionPathResolver = fn
  }

  onStateChange(callback: (info: BrowserInstanceInfo) => void): void {
    this.stateChangeCallback = callback
  }

  onRemoved(callback: (id: string) => void): void {
    this.removedCallback = callback
  }

  onInteracted(callback: (id: string) => void): void {
    this.interactedCallback = callback
  }

  /**
   * Resolve a requested profile id to one that actually exists in storage.
   * Falls back to the default profile when the requested id is missing or
   * was deleted, so callers never end up with an orphan partition.
   */
  private resolveProfileId(requested?: string): string {
    if (!requested || requested === DEFAULT_BROWSER_PROFILE_ID) {
      return DEFAULT_BROWSER_PROFILE_ID
    }
    try {
      const exists = getBrowserProfiles().some(p => p.id === requested)
      if (!exists) {
        mainLog.warn(`[browser-pane] Unknown profileId=${requested}; falling back to default`)
        return DEFAULT_BROWSER_PROFILE_ID
      }
      return requested
    } catch (err) {
      mainLog.warn(`[browser-pane] resolveProfileId failed: ${err instanceof Error ? err.message : String(err)}`)
      return DEFAULT_BROWSER_PROFILE_ID
    }
  }

  private touchProfileLastUsed(profileId: string): void {
    try {
      setLastUsedBrowserProfileId(profileId)
    } catch (err) {
      mainLog.warn(`[browser-pane] failed to update lastUsedProfileId: ${err instanceof Error ? err.message : String(err)}`)
    }
  }

  createInstance(id?: string, options?: CreateBrowserInstanceOptions): string {
    const instanceId = id || `browser-${++instanceCounter}`
    const shouldShow = options?.show ?? false
    const ownerType = options?.ownerType ?? 'manual'
    const ownerSessionId = ownerType === 'session' ? (options?.ownerSessionId ?? null) : null
    const workspaceId = options?.workspaceId ?? this.resolveLaunchWorkspaceId()
    const profileId = this.resolveProfileId(options?.profileId)
    const partition = getProfilePartition(profileId)

    if (this.instances.has(instanceId)) {
      mainLog.warn(`[browser-pane] Instance already exists, reusing: ${instanceId}`)
      return instanceId
    }

    const ses = session.fromPartition(partition)
    this.setupSessionPermissions(ses)
    this.setupSessionObservers(ses)
    this.setupSessionClientHints(ses)

    // Native window chrome follows the OS theme. Embedded pages are left to honor
    // their own prefers-color-scheme (like a normal browser) — we do not override
    // the page color scheme.
    const chromeBgColor = BROWSER_CHROME_BG[nativeTheme.shouldUseDarkColors ? 'dark' : 'light']
    const pageBgColor = '#ffffff'

    const window = new BrowserWindow({
      width: 1200,
      height: 900,
      minWidth: 700,
      minHeight: 500,
      show: false, // Always hidden until toolbar is painted (ready-to-show)
      backgroundColor: chromeBgColor,
      // Fully chromeless — toolbar is rendered in a dedicated WebContentsView
      frame: false,
      webPreferences: {
        partition,
        session: ses,
        contextIsolation: true,
        nodeIntegration: false,
        sandbox: true,
      },
    })

    const toolbarView = new WebContentsView({
      webPreferences: {
        preload: join(__dirname, 'browser-toolbar-preload.cjs'),
        partition,
        session: ses,
        contextIsolation: true,
        nodeIntegration: false,
        sandbox: false,
      },
    })

    const pageView = new WebContentsView({
      webPreferences: {
        partition,
        session: ses,
        contextIsolation: true,
        nodeIntegration: false,
        sandbox: true,
      },
    })

    const supportsMultiView = typeof window.contentView?.addChildView === 'function'
    if (!supportsMultiView) {
      throw new Error('[browser-pane] Native overlay requires BrowserWindow.contentView.addChildView')
    }

    const nativeOverlayView = new WebContentsView({
      webPreferences: {
        partition,
        session: ses,
        contextIsolation: true,
        nodeIntegration: false,
        sandbox: true,
      },
    })

    // Set view backgrounds. External pages should not inherit Craft's dark
    // chrome color behind transparent document areas.
    const toolbarWcWithBg = toolbarView.webContents as typeof toolbarView.webContents & { setBackgroundColor?: (color: string) => void }
    toolbarWcWithBg.setBackgroundColor?.('#00000000')
    const pageWcWithBg = pageView.webContents as typeof pageView.webContents & { setBackgroundColor?: (color: string) => void }
    pageWcWithBg.setBackgroundColor?.(pageBgColor)
    const overlayWcWithBg = nativeOverlayView.webContents as typeof nativeOverlayView.webContents & { setBackgroundColor?: (color: string) => void }
    overlayWcWithBg.setBackgroundColor?.('#00000000')

    // A WebContentsView paints its own background *behind* the page, and it
    // defaults to opaque white. BrowserView had no such layer, so setting the
    // webContents colour used to be enough. Without this the toolbar — which
    // expands to cover the window while its menu is open — turns the whole
    // browser white, and the overlay tap-catcher stops being see-through.
    toolbarView.setBackgroundColor('#00000000')
    nativeOverlayView.setBackgroundColor('#00000000')
    pageView.setBackgroundColor(pageBgColor)

    const cdp = new BrowserCDP(pageView.webContents)

    const instance: BrowserInstance = {
      id: instanceId,
      profileId,
      workspaceId,
      window,
      toolbarView,
      pageView,
      nativeOverlayView,
      sessionView: null,
      sessionPanelWidth: null,
      displayMode: 'floating',
      hiddenByIntegration: false,
      hostWindow: null,
      embeddedBounds: null,
      viewRadius: 0,
      cdp,
      currentUrl: 'about:blank',
      title: 'New Tab',
      favicon: null,
      faviconCandidateKey: null,
      faviconToken: 0,
      faviconAbort: null,
      isLoading: false,
      canGoBack: false,
      canGoForward: false,
      boundSessionId: ownerSessionId,
      ownerType,
      ownerSessionId,
      isVisible: false,
      captureLock: null,
      keepAliveOnWindowClose: true,
      toolbarReady: false,
      toolbarMenuOpen: false,
      toolbarMenuHeight: 0,
      toolbarMenuOverlayActive: false,
      showOnCreate: shouldShow,
      pendingShowOnReady: false,
      pendingShowToken: 0,
      lastAction: null,
      agentControl: null,
      lockState: {
        active: false,
        previousResizable: this.getWindowResizable(window),
      },
      nativeOverlayReady: false,
      themeColor: null,
      inPageThemeTimer: null,
      themeObserverToken: null,
      consoleLogs: [],
      networkLogs: [],
      downloads: [],
      lastLaunchToken: null,
      navigationPolicy: options?.navigationPolicy,
    }

    const defaultUa = pageView.webContents.userAgent || ''
    toolbarView.webContents.on('console-message', (_event, level, message) => {
      if (message.includes('[browser-toolbar]')) {
        mainLog.info(`[browser-pane] toolbar console id=${instance.id} level=${level}: ${message}`)
      }
    })

    // Strip Electron's default app tokens so the UA reads as vanilla Chrome.
    // Electron appends both `Electron/<ver>` and an app token derived from
    // app.getName() with spaces removed (e.g. `CraftAgents/<ver>`); either one
    // is a passive bot-detection tell at page load (Cloudflare Layer 1).
    const appToken = (typeof app.getName === 'function' ? app.getName() : '').replace(/[^A-Za-z0-9]/g, '')
    let sanitizedUa = defaultUa.replace(/\sElectron\/[^\s]+/g, '')
    if (appToken) {
      sanitizedUa = sanitizedUa.replace(new RegExp(`\\s${appToken}\\/[^\\s]+`, 'g'), '')
    }
    sanitizedUa = sanitizedUa.replace(/\s{2,}/g, ' ').trim()
    if (sanitizedUa && sanitizedUa !== defaultUa) {
      pageView.webContents.setUserAgent(sanitizedUa)
      // Popups opened via window.open (Google/Gmail/Meet sign-in open a
      // foreground-tab popup) get a fresh webContents that does NOT inherit the
      // pane's per-webContents UA override — it falls back to Electron's default
      // UA, which still carries `Electron/<ver>` and `<AppToken>/<ver>`. Google's
      // sign-in then flags the popup as an insecure/embedded browser
      // ("Não foi possível fazer o login"). Setting the sanitized UA on the
      // shared partition session covers the pane, its popups (created with
      // `session: pageWc.session`), and subframes consistently.
      if (typeof ses.setUserAgent === 'function') {
        ses.setUserAgent(sanitizedUa)
      }
    }

    // Stacking order is the child order: last added paints on top.
    window.contentView.addChildView(pageView)
    window.contentView.addChildView(nativeOverlayView)
    window.contentView.addChildView(toolbarView)
    void this.loadNativeOverlayPage(instance)

    this.layoutAllViews(instance)

    this.setupWindowListeners(instance)
    this.instances.set(instanceId, instance)
    this.emitStateChange(instance)
    this.touchProfileLastUsed(profileId)
    mainLog.info(`[browser-pane] toolbar version: v4-react-chromeless`)
    mainLog.info(`[browser-pane] Created instance: ${instanceId} (show=${shouldShow}, ownerType=${ownerType}, ownerSessionId=${ownerSessionId ?? 'none'}, profileId=${profileId}, workspaceId=${workspaceId ?? 'none'})`)

    void this.toolbarHost.loadPage(instance)
      .finally(() => {
        // Safety net: if Electron never fires ready-to-show, still unblock focus/show behavior.
        if (!instance.toolbarReady) {
          this.toolbarHost.markReady(instance, 'toolbar-load-finalized')
        }
      })

    const initialUrl = options?.url?.trim()
    if (initialUrl) {
      void this.navigate(instance.id, initialUrl).catch((error) => {
        const message = error instanceof Error ? error.message : String(error)
        mainLog.warn(`[browser-pane] initial URL load failed id=${instance.id}: ${message}`)
        // ERR_ABORTED is commonly emitted when a site redirects/replaces a navigation
        // while Electron is still awaiting loadURL(). Do not blank the page in that case.
        if (!message.includes('ERR_ABORTED')) {
          void pageView.webContents.loadURL('about:blank')
        }
      })
    } else {
      void this.loadEmptyStatePage(instance).catch((error) => {
        const message = error instanceof Error ? error.message : String(error)
        mainLog.warn(`[browser-pane] empty-state load failed id=${instance.id}: ${message}`)
        // If a caller navigates immediately after creating the view, the empty
        // state data URL can be aborted by the real navigation. Loading about:blank
        // here races and can overwrite the requested page, so only blank on real errors.
        if (!message.includes('ERR_ABORTED')) {
          void pageView.webContents.loadURL('about:blank')
        }
      })
    }

    return instanceId
  }

  /**
   * Marca/desmarca o pane como sob captura de tela. O dono da gravação chama
   * isso no início e no fim; enquanto marcado, o pane sai do pool de adoção por
   * sessão de agente.
   */
  setCaptureLock(id: string, lock: BrowserPaneCaptureLock | null): void {
    const instance = this.instances.get(id)
    if (!instance) return
    instance.captureLock = lock
    mainLog.info(`[browser-pane] captureLock ${lock ? `set reason=${lock.reason}` : 'cleared'} id=${id}`)
    this.emitStateChange(instance)
    this.toolbarHost.pushState(instance)
  }

  getCaptureLock(id: string): BrowserPaneCaptureLock | null {
    return this.instances.get(id)?.captureLock ?? null
  }

  /**
   * Hook disparado antes de um pane sob captura ser destruído, para o dono da
   * gravação selar o arquivo. É fire-and-forget porque o teardown é síncrono: o
   * que já foi escrito está no disco e só o tail em voo se perde.
   */
  setCaptureReleaseHook(hook: (browserInstanceId: string) => void): void {
    this.captureReleaseHook = hook
  }

  destroyInstance(id: string): void {
    const instance = this.instances.get(id)
    if (!instance) {
      mainLog.info(`[browser-pane] destroy requested for missing instance id=${id}`)
      return
    }

    const destroyedBefore = instance.window.isDestroyed()
    mainLog.info(`[browser-pane] destroy requested id=${id} destroyedBefore=${destroyedBefore} keepAlive=${instance.keepAliveOnWindowClose}`)

    if (instance.captureLock) {
      this.captureReleaseHook?.(id)
    }

    // Clear pending timers before destroying the window
    if (instance.inPageThemeTimer) {
      clearTimeout(instance.inPageThemeTimer)
      instance.inPageThemeTimer = null
    }
    instance.themeObserverToken = null
    instance.pendingShowOnReady = false
    instance.pendingShowToken += 1

    // Clean up in-flight network tracking for this instance's webContents
    const wcId = instance.pageView.webContents.id
    this.inFlightRequestsByWebContentsId.delete(wcId)
    this.lastNetworkActivityByWebContentsId.delete(wcId)

    const runCleanup = (label: string, action: () => void): void => {
      try {
        action()
      } catch (error) {
        mainLog.warn(`[browser-pane] destroy cleanup failed id=${id} step=${label} error=${error instanceof Error ? error.message : String(error)}`)
      }
    }

    runCleanup('closePopupsForParent', () => this.closePopupsForParent(instance.id, 'parent_destroy'))
    runCleanup('applyAgentControlLock', () => this.applyAgentControlLock(instance, false))
    runCleanup('updateNativeOverlayState', () => this.updateNativeOverlayState(instance))

    try {
      if (!instance.window.isDestroyed()) {
        this.destroyingIds.add(id)
        instance.window.destroy()
      }
    } catch (error) {
      mainLog.warn(`[browser-pane] destroy failed id=${id} error=${error instanceof Error ? error.message : String(error)}`)
    } finally {
      // Finalize synchronously in case closed does not fire (or fires later).
      this.finalizeDestroyedInstance(instance, 'destroy')
      mainLog.info(`[browser-pane] destroy completed id=${id} removed=${!this.instances.has(id)}`)
    }
  }

  /** Sync accessor for the live `BrowserInstance` — in-process callers only, NOT the wire seam. */
  getLiveInstance(id: string): BrowserInstance | undefined {
    return this.instances.get(id)
  }

  // ============================================================
  // Browser profile management
  // ============================================================

  onProfilesChanged(callback: (settings: BrowserProfileSettings) => void): void {
    this.profilesChangeCallback = callback
  }

  onProfileManagementRequested(callback: (instanceId: string) => void): void {
    this.profileManagementRequestCallback = callback
  }

  /**
   * Dock/undock asked for from inside a browser window. Only the app renderer
   * can complete it — it owns the card that gives the integrated views their
   * rect — so the manager just relays the intent.
   */
  onDisplayModeRequested(callback: (instanceId: string, mode: BrowserDisplayMode) => void): void {
    this.displayModeRequestCallback = callback
  }

  listProfiles(): BrowserProfile[] {
    return getBrowserProfiles()
  }

  getProfileSettings(): BrowserProfileSettings {
    return getBrowserProfileSettings()
  }

  setProfileSettings(partial: { alwaysAsk?: boolean; lastUsedProfileId?: string }): BrowserProfileSettings {
    if (typeof partial.alwaysAsk === 'boolean') {
      setBrowserPickerAlwaysAsk(partial.alwaysAsk)
    }
    if (partial.lastUsedProfileId) {
      setLastUsedBrowserProfileId(partial.lastUsedProfileId)
    }
    const settings = getBrowserProfileSettings()
    this.profilesChangeCallback?.(settings)
    return settings
  }

  createProfile(input: BrowserProfileInput): BrowserProfile {
    const sanitized = sanitizeBrowserProfileInput(input)
    const profiles = getBrowserProfiles()
    const id = randomUUID().slice(0, 8)
    const profile: BrowserProfile = {
      id,
      ...sanitized,
      createdAt: Date.now(),
    }
    setBrowserProfiles([...profiles, profile])
    void applyProxyToProfilePartition(getProfilePartition(id)).catch(error => {
      mainLog.warn(`[browser-pane] proxy apply failed for new profile ${id}: ${error instanceof Error ? error.message : String(error)}`)
    })
    mainLog.info(`[browser-pane] Created profile id=${id} name="${profile.name}"`)
    this.profilesChangeCallback?.(getBrowserProfileSettings())
    return profile
  }

  renameProfile(id: string, name: string): BrowserProfile {
    const trimmed = name?.trim()
    if (!trimmed) {
      throw new Error('Profile name is required')
    }
    const profiles = getBrowserProfiles()
    const target = profiles.find(p => p.id === id)
    if (!target) {
      throw new Error(`Unknown profile id: ${id}`)
    }
    const updated: BrowserProfile = { ...target, name: trimmed }
    setBrowserProfiles(profiles.map(p => (p.id === id ? updated : p)))
    this.profilesChangeCallback?.(getBrowserProfileSettings())
    return updated
  }

  /**
   * Switch a browser instance to a different profile.
   *
   * Partition is bound at creation time, so switching requires a brand new
   * window. Current URL and binding (session ownership) are preserved.
   * Returns the new instance id.
   */
  switchProfile(instanceId: string, targetProfileId: string): string | null {
    const instance = this.instances.get(instanceId)
    if (!instance) {
      mainLog.warn(`[browser-pane] switchProfile noop — unknown instance ${instanceId}`)
      return null
    }

    const resolvedTarget = this.resolveProfileId(targetProfileId)
    if (resolvedTarget === instance.profileId) {
      mainLog.info(`[browser-pane] switchProfile noop — already on profile ${resolvedTarget}`)
      return instance.id
    }

    const url = instance.currentUrl
    const ownerType = instance.ownerType
    const ownerSessionId = instance.ownerSessionId

    this.destroyInstance(instance.id)

    const newId = this.createInstance(undefined, {
      show: true,
      profileId: resolvedTarget,
      workspaceId: instance.workspaceId,
      ownerType,
      ownerSessionId: ownerSessionId ?? undefined,
    })
    if (url && url !== 'about:blank') {
      void this.navigate(newId, url).catch(() => {})
    }
    return newId
  }

  async deleteProfile(id: string): Promise<void> {
    if (id === DEFAULT_BROWSER_PROFILE_ID) {
      throw new Error('Default profile cannot be deleted')
    }
    const profiles = getBrowserProfiles()
    if (!profiles.some(p => p.id === id)) {
      mainLog.info(`[browser-pane] deleteProfile noop — unknown id=${id}`)
      return
    }

    // Destroy any open instances bound to this profile so the partition can
    // be cleared without "session in use" errors.
    const boundInstanceIds: string[] = []
    for (const instance of this.instances.values()) {
      if (instance.profileId === id) boundInstanceIds.push(instance.id)
    }
    for (const instanceId of boundInstanceIds) {
      this.destroyInstance(instanceId)
    }

    setBrowserProfiles(profiles.filter(p => p.id !== id))

    const partition = getProfilePartition(id)
    try {
      const ses = session.fromPartition(partition)
      await ses.clearStorageData()
      await ses.clearCache()
      mainLog.info(`[browser-pane] Deleted profile id=${id} (cleared partition=${partition})`)
    } catch (error) {
      mainLog.warn(`[browser-pane] failed to clear storage for deleted profile ${id}: ${error instanceof Error ? error.message : String(error)}`)
    }

    this.profilesChangeCallback?.(getBrowserProfileSettings())
  }

  private cleanupDestroyedInstance(instance: BrowserInstance, reason: string): void {
    this.finalizeDestroyedInstance(instance, 'closed')
    mainLog.info(`[browser-pane] cleaned up stale instance ${instance.id}: ${reason}`)
  }

  /**
   * Get an instance that is confirmed alive (window not destroyed).
   * Throws a clear error if the instance is missing or its window was closed.
   * Automatically cleans up stale entries from the instance map.
   */
  private requireAliveInstance(id: string): BrowserInstance {
    const instance = this.instances.get(id)
    if (!instance) throw new Error(`Browser instance not found: ${id}`)
    if (instance.window.isDestroyed()) {
      this.cleanupDestroyedInstance(instance, `lookup by id ${id}`)
      throw new Error(`Browser window was closed (instance: ${id})`)
    }
    return instance
  }

  async handleEmptyStateLaunchFromRenderer(
    senderWebContentsId: number,
    payload: BrowserEmptyStateLaunchPayload,
  ): Promise<BrowserEmptyStateLaunchResult> {
    const instance = this.findInstanceByPageWebContentsId(senderWebContentsId)
    if (!instance) {
      mainLog.warn(`[browser-pane] empty-state launch ignored: sender not mapped senderWebContentsId=${senderWebContentsId}`)
      return { ok: false, handled: false, reason: 'instance_not_found' }
    }

    const route = payload.route?.trim()
    if (!route) {
      mainLog.warn(`[browser-pane] empty-state launch missing route id=${instance.id}`)
      return { ok: false, handled: false, reason: 'missing_route' }
    }

    const token = payload.token ?? null
    const handled = await this.triggerEmptyStateRouteLaunch(instance, route, token, 'ipc')
    return {
      ok: true,
      handled,
      reason: handled ? undefined : 'duplicate',
    }
  }

  private findInstanceByPageWebContentsId(senderWebContentsId: number): BrowserInstance | undefined {
    for (const instance of this.instances.values()) {
      if (instance.pageView.webContents.id === senderWebContentsId) {
        return instance
      }
    }
    return undefined
  }

  private resolveLaunchWorkspaceId(): string | null {
    if (!this.windowManager) return null

    const focusedWindow = this.windowManager.getFocusedWindow()
    if (focusedWindow) {
      const focusedWorkspaceId = this.windowManager.getWorkspaceForWindow(focusedWindow.webContents.id)
      if (focusedWorkspaceId) {
        return focusedWorkspaceId
      }
    }

    const managedWindows = this.windowManager.getAllWindows()
    return managedWindows[0]?.workspaceId ?? null
  }

  private buildDeepLinkFromRoute(route: string): string {
    const queryStart = route.indexOf('?')
    const routePath = queryStart >= 0 ? route.slice(0, queryStart) : route
    const routeQuery = queryStart >= 0 ? route.slice(queryStart + 1) : ''
    let normalizedPath = routePath.replace(/^\/+/, '')

    const workspaceId = this.resolveLaunchWorkspaceId()
    if (workspaceId && !normalizedPath.startsWith('workspace/')) {
      normalizedPath = `workspace/${encodeURIComponent(workspaceId)}/${normalizedPath}`
    }

    return `${CRAFT_DEEPLINK_SCHEME_PREFIX}${normalizedPath}${routeQuery ? `?${routeQuery}` : ''}`
  }

  private async triggerEmptyStateRouteLaunch(
    instance: BrowserInstance,
    route: string,
    token: string | null,
    source: 'hash' | 'ipc',
  ): Promise<boolean> {
    const dedupeToken = token ?? route
    if (dedupeToken && instance.lastLaunchToken === dedupeToken) {
      mainLog.info(`[browser-pane] ignoring duplicate empty-state launch id=${instance.id} source=${source} token=${dedupeToken}`)
      return false
    }

    instance.lastLaunchToken = dedupeToken
    const deepLink = this.buildDeepLinkFromRoute(route)
    mainLog.info(`[browser-pane] handling empty-state launch id=${instance.id} source=${source} route=${route} deepLink=${deepLink}`)

    await this.handleDeepLinkUrl(deepLink)
    return true
  }

  async listInstances(): Promise<BrowserInstanceInfo[]> {
    const infos: BrowserInstanceInfo[] = []
    for (const instance of this.instances.values()) {
      if (instance.window.isDestroyed()) {
        this.cleanupDestroyedInstance(instance, 'listInstances')
        continue
      }
      infos.push(this.toInfo(instance))
    }
    return infos
  }

  getWindowCount(): number {
    return this.instances.size
  }

  getBrowserWindows(): BrowserWindow[] {
    return Array.from(this.instances.values())
      .flatMap((instance) => instance.window.isDestroyed() ? [] : [instance.window])
  }

  async navigate(id: string, url: string): Promise<{ url: string; title: string }> {
    const instance = this.requireAliveInstance(id)

    let normalizedUrl = url.trim()
    const hasScheme = /^[a-z][a-z0-9+.-]*:\/\//i.test(normalizedUrl)
    const isAbout = normalizedUrl.startsWith('about:')
    if (!hasScheme && !isAbout) {
      const looksLikeHost = /^(localhost|\d{1,3}(?:\.\d{1,3}){3}|[\w-]+(?:\.[\w-]+)+)(?::\d+)?(?:\/|$)/i.test(normalizedUrl)
      if (looksLikeHost) {
        normalizedUrl = `https://${normalizedUrl}`
      } else {
        normalizedUrl = `https://duckduckgo.com/?q=${encodeURIComponent(normalizedUrl)}`
      }
    }

    if (!isAllowedTopLevelUrl(normalizedUrl)) {
      const scheme = normalizedUrl.split(':')[0]
      throw new Error(`Navigation blocked: scheme "${scheme}:" is not allowed (only http/https)`)
    }

    const timeoutMs = 30_000
    let timeoutHandle: ReturnType<typeof setTimeout> | null = null

    try {
      const loaded = instance.pageView.webContents.loadURL(normalizedUrl)
      const timeout = new Promise<never>((_, reject) => {
        timeoutHandle = setTimeout(() => reject(new Error(`Navigation to "${normalizedUrl}" timed out after ${timeoutMs / 1000}s`)), timeoutMs)
      })
      await Promise.race([loaded, timeout])
      this.toolbarHost.pushState(instance)

      return { url: instance.currentUrl, title: instance.title }
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error)
      if (message.includes('ERR_ABORTED')) {
        mainLog.info(`[browser-pane] navigation reported ERR_ABORTED but may continue id=${id} url=${normalizedUrl}`)
        this.toolbarHost.pushState(instance)
        return { url: instance.currentUrl || normalizedUrl, title: instance.title }
      }
      throw error
    } finally {
      if (timeoutHandle) {
        clearTimeout(timeoutHandle)
      }
    }
  }

  async goBack(id: string): Promise<void> {
    const instance = this.requireAliveInstance(id)
    if (instance.pageView.webContents.canGoBack()) {
      instance.pageView.webContents.goBack()
    }
  }

  async goForward(id: string): Promise<void> {
    const instance = this.requireAliveInstance(id)
    if (instance.pageView.webContents.canGoForward()) {
      instance.pageView.webContents.goForward()
    }
  }

  reload(id: string): void {
    const instance = this.instances.get(id)
    if (!instance || instance.window.isDestroyed()) return
    instance.pageView.webContents.reload()
  }

  stop(id: string): void {
    const instance = this.instances.get(id)
    if (!instance || instance.window.isDestroyed()) return
    instance.pageView.webContents.stop()
  }

  focus(id: string): void {
    const instance = this.instances.get(id)
    if (!instance) return

    const win = instance.window
    if (win.isDestroyed()) return

    // If toolbar hasn't painted yet, defer showing until markToolbarReady runs.
    // Token guard prevents stale deferred focus from showing after hide/destroy.
    if (!instance.toolbarReady) {
      if (instance.pendingShowOnReady) return
      instance.pendingShowOnReady = true
      const token = ++instance.pendingShowToken
      mainLog.info(`[browser-pane] focus deferred until ready id=${instance.id} token=${token}`)
      return
    }

    if (win.isMinimized()) win.restore()
    win.show()
    win.focus()

    instance.isVisible = true
    this.emitStateChange(instance)
  }

  hide(id: string): void {
    const instance = this.instances.get(id)
    if (!instance) return

    const win = instance.window
    if (win.isDestroyed()) return

    // Cancel any deferred show request queued before toolbar was ready.
    if (instance.pendingShowOnReady) {
      instance.pendingShowOnReady = false
      instance.pendingShowToken += 1
    }

    this.forceCloseToolbarMenu(instance, 'window-hide')

    win.hide()

    instance.isVisible = false
    this.emitStateChange(instance)
  }

  async getAccessibilitySnapshot(id: string): Promise<AccessibilitySnapshot> {
    const instance = this.requireAliveInstance(id)
    return instance.cdp.getAccessibilitySnapshot()
  }

  async clickAtCoordinates(id: string, x: number, y: number): Promise<void> {
    const instance = this.requireAliveInstance(id)

    try {
      await instance.cdp.clickAtCoordinates(x, y)
      instance.lastAction = {
        tool: 'browser_click_at',
        status: 'succeeded',
        timestamp: Date.now(),
      }
    } catch (error) {
      instance.lastAction = {
        tool: 'browser_click_at',
        status: 'failed',
        timestamp: Date.now(),
      }
      throw error
    }
  }

  async drag(id: string, x1: number, y1: number, x2: number, y2: number): Promise<void> {
    const instance = this.requireAliveInstance(id)

    try {
      await instance.cdp.drag(x1, y1, x2, y2)
      instance.lastAction = {
        tool: 'browser_drag',
        status: 'succeeded',
        timestamp: Date.now(),
      }
    } catch (error) {
      instance.lastAction = {
        tool: 'browser_drag',
        status: 'failed',
        timestamp: Date.now(),
      }
      throw error
    }
  }

  async typeText(id: string, text: string): Promise<void> {
    const instance = this.requireAliveInstance(id)

    try {
      await instance.cdp.typeText(text)
      instance.lastAction = {
        tool: 'browser_type',
        status: 'succeeded',
        timestamp: Date.now(),
      }
    } catch (error) {
      instance.lastAction = {
        tool: 'browser_type',
        status: 'failed',
        timestamp: Date.now(),
      }
      throw error
    }
  }

  async setClipboard(id: string, text: string): Promise<void> {
    const instance = this.requireAliveInstance(id)
    await instance.cdp.setClipboard(text)
  }

  async getClipboard(id: string): Promise<string> {
    const instance = this.requireAliveInstance(id)
    return instance.cdp.getClipboard()
  }

  async clickElement(
    id: string,
    ref: string,
    options?: { waitFor?: 'none' | 'navigation' | 'network-idle'; timeoutMs?: number }
  ): Promise<void> {
    const instance = this.requireAliveInstance(id)

    try {
      const geometry = await instance.cdp.clickElement(ref)
      instance.lastAction = {
        tool: 'browser_click',
        ref,
        status: 'succeeded',
        geometry,
        timestamp: Date.now(),
      }

      const waitFor = options?.waitFor ?? 'none'
      if (waitFor === 'navigation') {
        const timeoutMs = Math.max(100, options?.timeoutMs ?? DEFAULT_WAIT_TIMEOUT_MS)
        await new Promise<void>((resolve, reject) => {
          const timer = setTimeout(() => {
            cleanup()
            reject(new Error(
              `Click navigation wait timed out after ${timeoutMs}ms (no navigation event observed). `
              + `Tip: retry with "click ${ref}" (no navigation wait), then use "wait url <pattern>" or "wait network-idle".`
            ))
          }, timeoutMs)

          const onNav = () => {
            cleanup()
            resolve()
          }

          const cleanup = () => {
            clearTimeout(timer)
            instance.pageView.webContents.removeListener('did-navigate', onNav)
            instance.pageView.webContents.removeListener('did-navigate-in-page', onNav)
          }

          instance.pageView.webContents.once('did-navigate', onNav)
          instance.pageView.webContents.once('did-navigate-in-page', onNav)
        })
      } else if (waitFor === 'network-idle') {
        await this.waitFor(id, { kind: 'network-idle', timeoutMs: options?.timeoutMs })
      }
    } catch (error) {
      instance.lastAction = {
        tool: 'browser_click',
        ref,
        status: 'failed',
        timestamp: Date.now(),
      }
      throw error
    }
  }

  async fillElement(id: string, ref: string, value: string): Promise<void> {
    const instance = this.requireAliveInstance(id)

    try {
      const geometry = await instance.cdp.fillElement(ref, value)
      instance.lastAction = {
        tool: 'browser_fill',
        ref,
        status: 'succeeded',
        geometry,
        timestamp: Date.now(),
      }
    } catch (error) {
      instance.lastAction = {
        tool: 'browser_fill',
        ref,
        status: 'failed',
        timestamp: Date.now(),
      }
      throw error
    }
  }

  async selectOption(id: string, ref: string, value: string): Promise<void> {
    const instance = this.requireAliveInstance(id)

    try {
      const geometry = await instance.cdp.selectOption(ref, value)
      instance.lastAction = {
        tool: 'browser_select',
        ref,
        status: 'succeeded',
        geometry,
        timestamp: Date.now(),
      }
    } catch (error) {
      instance.lastAction = {
        tool: 'browser_select',
        ref,
        status: 'failed',
        timestamp: Date.now(),
      }
      throw error
    }
  }

  async screenshot(id: string, options?: BrowserScreenshotOptions): Promise<BrowserScreenshotResult> {
    return this.visualCapture.screenshot(id, options)
  }

  async screenshotRegion(id: string, target: BrowserScreenshotRegionTarget): Promise<BrowserScreenshotResult> {
    return this.visualCapture.screenshotRegion(id, target)
  }

  async getConsoleLogs(id: string, options?: BrowserConsoleOptions): Promise<BrowserConsoleEntry[]> {
    const instance = this.requireAliveInstance(id)

    const level = options?.level ?? 'all'
    const limit = Math.max(1, Math.min(500, Number(options?.limit ?? 50)))

    const filtered = level === 'all'
      ? instance.consoleLogs
      : instance.consoleLogs.filter((entry) => entry.level === level)

    return filtered.slice(-limit)
  }

  async getNetworkLogs(id: string, options?: BrowserNetworkOptions): Promise<BrowserNetworkEntry[]> {
    const instance = this.requireAliveInstance(id)

    const statusFilter = options?.status ?? 'all'
    const limit = Math.max(1, Math.min(500, Number(options?.limit ?? 50)))
    const method = options?.method?.toUpperCase()
    const resourceType = options?.resourceType?.toLowerCase()

    const filtered = instance.networkLogs.filter((entry) => {
      if (method && entry.method !== method) return false
      if (resourceType && entry.resourceType.toLowerCase() !== resourceType) return false

      if (statusFilter === 'all') return true
      if (statusFilter === 'failed') return !entry.ok
      if (statusFilter === '2xx') return entry.status >= 200 && entry.status < 300
      if (statusFilter === '3xx') return entry.status >= 300 && entry.status < 400
      if (statusFilter === '4xx') return entry.status >= 400 && entry.status < 500
      if (statusFilter === '5xx') return entry.status >= 500 && entry.status < 600
      return true
    })

    return filtered.slice(-limit)
  }

  async waitFor(id: string, args: BrowserWaitArgs): Promise<BrowserWaitResult> {
    const instance = this.requireAliveInstance(id)

    const timeoutMs = Math.max(100, args.timeoutMs ?? DEFAULT_WAIT_TIMEOUT_MS)
    const pollMs = Math.max(25, args.pollMs ?? DEFAULT_WAIT_POLL_MS)
    const idleMs = Math.max(100, args.idleMs ?? 700)
    const started = Date.now()

    const until = async (predicate: () => Promise<boolean>, detail: string): Promise<BrowserWaitResult> => {
      while (Date.now() - started <= timeoutMs) {
        if (await predicate()) {
          return {
            ok: true,
            kind: args.kind,
            elapsedMs: Date.now() - started,
            detail,
          }
        }
        await this.sleep(pollMs)
      }
      throw new Error(`Wait timed out after ${timeoutMs}ms (${args.kind})`)
    }

    if (args.kind === 'selector') {
      const selector = args.value?.trim()
      if (!selector) throw new Error('browser_wait selector requires value')
      return until(async () => {
        const exists = await instance.pageView.webContents.executeJavaScript(
          `Boolean(document.querySelector(${JSON.stringify(selector)}))`
        )
        return Boolean(exists)
      }, `selector matched: ${selector}`)
    }

    if (args.kind === 'text') {
      const text = args.value?.trim()
      if (!text) throw new Error('browser_wait text requires value')
      return until(async () => {
        const found = await instance.pageView.webContents.executeJavaScript(
          `document.body && document.body.innerText && document.body.innerText.includes(${JSON.stringify(text)})`
        )
        return Boolean(found)
      }, `text found: ${text}`)
    }

    if (args.kind === 'url') {
      const needle = args.value?.trim()
      if (!needle) throw new Error('browser_wait url requires value')
      return until(async () => {
        return instance.currentUrl.includes(needle)
      }, `url matched: ${needle}`)
    }

    if (args.kind === 'network-idle') {
      const wcId = instance.pageView.webContents.id
      return until(async () => {
        const inflight = this.inFlightRequestsByWebContentsId.get(wcId) ?? 0
        const last = this.lastNetworkActivityByWebContentsId.get(wcId) ?? started
        return inflight === 0 && (Date.now() - last) >= idleMs
      }, `network idle for ${idleMs}ms`)
    }

    throw new Error(`Unknown wait kind: ${args.kind}`)
  }

  async sendKey(id: string, args: BrowserKeyArgs): Promise<void> {
    const instance = this.requireAliveInstance(id)

    const key = args.key?.trim()
    if (!key) throw new Error('browser_key requires key')

    const modifiers = (args.modifiers ?? []) as Array<'shift' | 'control' | 'alt' | 'meta'>

    instance.pageView.webContents.sendInputEvent({
      type: 'keyDown',
      keyCode: key,
      modifiers,
    } as any)
    instance.pageView.webContents.sendInputEvent({
      type: 'keyUp',
      keyCode: key,
      modifiers,
    } as any)
  }

  async getDownloads(id: string, options?: BrowserDownloadOptions): Promise<BrowserDownloadEntry[]> {
    const instance = this.requireAliveInstance(id)

    const action = options?.action ?? 'list'
    const limit = Math.max(1, Math.min(200, Number(options?.limit ?? 20)))

    if (action === 'wait') {
      const timeoutMs = Math.max(100, Number(options?.timeoutMs ?? DEFAULT_WAIT_TIMEOUT_MS))
      const started = Date.now()
      while (Date.now() - started <= timeoutMs) {
        const hasTerminal = instance.downloads.some((d) => d.state === 'completed' || d.state === 'interrupted' || d.state === 'cancelled')
        if (hasTerminal) break
        await this.sleep(100)
      }
    }

    return instance.downloads.slice(-limit)
  }

  // validateUploadFilePath removed — uses shared validateFilePath from @craft-agent/server-core/handlers

  // Geometry is undefined when the input has no box model — the usual
  // `<input type="file" style="display:none">`. The assignment still happened.
  async uploadFile(id: string, ref: string, filePaths: string[]): Promise<ElementGeometry | undefined> {
    const instance = this.requireAliveInstance(id)

    const safePaths: string[] = []
    for (const p of filePaths) {
      const workspaceId = this.resolveLaunchWorkspaceId()
      const safePath = await validateFilePath(p, getWorkspaceAllowedDirs(workspaceId))
      if (!existsSync(safePath)) throw new Error(`File not found: ${p}`)
      safePaths.push(safePath)
    }

    return instance.cdp.setFileInputFiles(ref, safePaths)
  }

  async windowResize(id: string, width: number, height: number): Promise<{ width: number; height: number }> {
    const instance = this.requireAliveInstance(id)

    const requestedViewportWidth = Math.max(320, Math.floor(width))
    const requestedViewportHeight = Math.max(240, Math.floor(height))
    instance.window.setContentSize(requestedViewportWidth, requestedViewportHeight + TOOLBAR_HEIGHT)

    this.layoutAllViews(instance)

    // Return effective viewport dimensions after OS/window min-size constraints are applied.
    const [appliedContentWidth, appliedContentHeight] = instance.window.getContentSize()
    return {
      width: Math.max(0, Math.floor(appliedContentWidth)),
      height: Math.max(0, Math.floor(appliedContentHeight - TOOLBAR_HEIGHT)),
    }
  }

  /**
   * SECURITY: single policy source for browser_tool evaluate. The gate lives ONLY
   * here; `evaluate()` calls it, and SessionManager pre-checks with it before
   * resolving an instance so a denied call never spawns a hidden window. Local +
   * remote paths converge on the desktop's `evaluate()`, enforcing
   * allowRemoteEvaluate in exactly one place.
   */
  assertEvaluateAllowed(): void {
    if (!getAllowRemoteEvaluate()) {
      throw new CodedError('BROWSER_REMOTE_EVALUATE_BLOCKED',
        'JavaScript evaluation from agents is disabled in this client (allowRemoteEvaluate=false).')
    }
  }

  async evaluate(id: string, expression: string): Promise<unknown> {
    this.assertEvaluateAllowed()
    const instance = this.requireAliveInstance(id)
    return instance.pageView.webContents.executeJavaScript(expression)
  }

  async detectSecurityChallenge(id: string): Promise<{ detected: boolean; provider: string; signals: string[] }> {
    const instance = this.instances.get(id)
    if (!instance || instance.window.isDestroyed()) return { detected: false, provider: 'none', signals: [] }

    const signals: string[] = []
    const title = instance.title || ''
    const url = instance.currentUrl || ''

    // Title-based detection
    if (/^Just a moment/i.test(title)) {
      signals.push('title:just-a-moment')
    }

    // URL-based detection
    if (url.includes('/cdn-cgi/challenge-platform/')) {
      signals.push('url:cdn-cgi-challenge')
    }

    // DOM-based detection via JS evaluation
    try {
      const domSignals = await instance.pageView.webContents.executeJavaScript(`(() => {
        const signals = [];
        const bodyText = (document.body?.innerText || '').slice(0, 2000);
        if (/Verify you are human/i.test(bodyText)) signals.push('text:verify-human');
        if (/Checking (if the site connection is secure|your browser)/i.test(bodyText)) signals.push('text:checking-browser');
        if (/Performing security verification/i.test(bodyText)) signals.push('text:security-verification');
        if (document.querySelector('#challenge-form')) signals.push('dom:challenge-form');
        if (document.querySelector('#turnstile-wrapper')) signals.push('dom:turnstile-wrapper');
        if (document.querySelector('.cf-turnstile')) signals.push('dom:cf-turnstile');
        if (document.querySelector('iframe[src*="challenges.cloudflare.com"]')) signals.push('dom:cf-challenge-iframe');
        return signals;
      })()`) as string[]

      if (Array.isArray(domSignals)) {
        signals.push(...domSignals)
      }
    } catch {
      // JS evaluation can fail if page is in a weird state — don't block on it
    }

    try {
      const snapshot = await instance.cdp.getAccessibilitySnapshot()
      const actionableRoles = new Set([
        'button', 'link', 'textbox', 'searchbox', 'combobox', 'checkbox', 'radio', 'switch',
        'menuitem', 'menuitemcheckbox', 'menuitemradio', 'tab', 'option', 'slider', 'spinbutton', 'listbox',
      ])
      const actionableCount = snapshot.nodes.filter((node) => {
        const role = (node.role || '').toLowerCase()
        return actionableRoles.has(role) && !node.disabled
      }).length

      if (snapshot.nodes.length > 0 && actionableCount <= 2) {
        signals.push(`ax:near-empty(${actionableCount}/${snapshot.nodes.length})`)
      }
    } catch {
      // AX snapshot can fail transiently during navigation; ignore
    }

    // A sparse accessibility tree is useful supporting context, but it is not
    // enough by itself to call a page a security challenge. Legitimate pages
    // such as example.com can have only one link and otherwise static text.
    const decisiveSignals = signals.filter(s => !s.startsWith('ax:near-empty('))
    const detected = decisiveSignals.length > 0
    const isCloudflare = decisiveSignals.some(s =>
      s.includes('cf-') || s.includes('challenge') || s.includes('turnstile') || s === 'title:just-a-moment'
    )
    const provider = detected ? (isCloudflare ? 'cloudflare' : 'unknown') : 'none'

    if (detected) {
      mainLog.info(`[browser-pane] security challenge detected id=${id} provider=${provider} signals=[${signals.join(', ')}]`)
    }

    return { detected, provider, signals }
  }

  async scroll(id: string, direction: 'up' | 'down' | 'left' | 'right', amount = 500): Promise<void> {
    const instance = this.requireAliveInstance(id)

    const deltaX = direction === 'left' ? -amount : direction === 'right' ? amount : 0
    const deltaY = direction === 'up' ? -amount : direction === 'down' ? amount : 0

    await instance.pageView.webContents.executeJavaScript(`window.scrollBy(${deltaX}, ${deltaY})`)
  }

  bindSession(id: string, sessionId: string, options?: { workspaceId?: string | null }): void {
    const instance = this.instances.get(id)
    if (instance) {
      instance.boundSessionId = sessionId
      instance.ownerType = 'session'
      instance.ownerSessionId = sessionId
      // Adopt the binder's workspace. Manual windows being reused for a session
      // start carrying that session's workspace so the receiving workspace's UI
      // sees them and others filter them out.
      if (options?.workspaceId !== undefined) {
        instance.workspaceId = options.workspaceId
      }
      this.emitStateChange(instance)
    }
  }

  unbindSession(id: string): void {
    const instance = this.instances.get(id)
    if (instance) {
      instance.boundSessionId = null
      instance.ownerType = 'manual'
      // Preserve ownerSessionId as last-known owner for lifecycle targeting.
      this.emitStateChange(instance)
    }
  }

  /** Unbind all instances bound to the given session (non-destructive — window stays alive and reusable). */
  unbindAllForSession(sessionId: string): void {
    for (const instance of this.instances.values()) {
      if (instance.boundSessionId === sessionId) {
        instance.boundSessionId = null
        instance.ownerType = 'manual'
        // Keep ownerSessionId for post-turn lifecycle commands like `close` and `hide`.
        instance.ownerSessionId = instance.ownerSessionId ?? sessionId
        this.emitStateChange(instance)
        mainLog.info(`[browser-pane] Unbound instance ${instance.id} from session ${sessionId} (owner retained: ${instance.ownerSessionId ?? 'none'})`)
      }
    }
  }

  getBoundForSession(sessionId: string): string | null {
    for (const instance of this.instances.values()) {
      if (instance.ownerType === 'session' && instance.ownerSessionId === sessionId) {
        if (instance.window.isDestroyed()) {
          this.cleanupDestroyedInstance(instance, `getBoundForSession(${sessionId})`)
          continue
        }
        return instance.id
      }
    }
    return null
  }

  /**
   * Pick an unbound window the caller's workspace is allowed to adopt. A window
   * left behind when a session ended keeps its original `workspaceId`; allowing
   * adoption only when that workspace is `null` (never bound) or matches the
   * caller's workspace prevents a session in workspace B from grabbing (and
   * thereby moving) a window left behind by workspace A.
   */
  private findReusableUnboundInstance(workspaceId: string | null): BrowserInstance | null {
    const unbound = Array.from(this.instances.values()).filter(
      i => i.boundSessionId === null && i.ownerType === 'manual'
        && (i.workspaceId === null || i.workspaceId === workspaceId)
        // Um pane em captura nunca é adotado: navegar a página não encerra as
        // faixas capturadas, então a gravação seguiria com o conteúdo do agente.
        && !i.captureLock,
    )
    if (unbound.length === 0) return null

    // Prefer visible windows first, then fall back to first available.
    return unbound.find(i => i.isVisible) ?? unbound[0]
  }

  async createForSession(sessionId: string, options?: { show?: boolean; profileId?: string; allowReuseManual?: boolean; workspaceId?: string | null }): Promise<string> {
    const existing = this.getBoundForSession(sessionId)
    if (existing) {
      const boundInstance = this.instances.get(existing)
      if (boundInstance?.captureLock) {
        // A sessão já possuía este pane, mas ele está gravando: devolve a janela
        // ao usuário (mantendo ownerSessionId para rastreio) e segue para criar
        // outra — o filtro de adoção exclui a que acabou de ser liberada.
        mainLog.warn(`[browser-pane] session ${sessionId} was bound to capture-locked instance ${existing}; unbinding and creating a new window`)
        boundInstance.boundSessionId = null
        boundInstance.ownerType = 'manual'
        this.emitStateChange(boundInstance)
      } else {
        // Already bound — adopt the workspace if the caller provided one.
        if (options?.workspaceId !== undefined && boundInstance) {
          boundInstance.workspaceId = options.workspaceId
        }
        if (options?.show) {
          this.focus(existing)
        }
        return existing
      }
    }

    const workspaceId = options?.workspaceId ?? this.resolveLaunchWorkspaceId()

    // Reuse an unbound/manual window before creating a new one — local
    // sessions only (remote agents pass allowReuseManual=false so they can
    // never hijack a window the user opened manually). Reuse also requires
    // that no specific profile was requested or the reusable instance already
    // matches the requested profile (mismatched partitions can't be reused),
    // and that the caller's workspace is allowed to adopt it.
    const reusable = (options?.allowReuseManual ?? true) ? this.findReusableUnboundInstance(workspaceId) : null
    const requestedProfile = options?.profileId
    const reuseMatchesProfile =
      reusable && (!requestedProfile || reusable.profileId === this.resolveProfileId(requestedProfile))
    if (reusable && reuseMatchesProfile) {
      this.bindSession(reusable.id, sessionId, { workspaceId })
      if (options?.show) {
        this.focus(reusable.id)
      }
      mainLog.info(`[browser-pane] Reused unbound instance ${reusable.id} for session ${sessionId} (workspace=${workspaceId ?? 'none'})`)
      return reusable.id
    }

    return this.createInstance(undefined, {
      show: options?.show ?? false,
      ownerType: 'session',
      ownerSessionId: sessionId,
      profileId: options?.profileId,
      workspaceId,
    })
  }

  async focusBoundForSession(sessionId: string, options?: { workspaceId?: string | null }): Promise<string> {
    const id = await this.createForSession(sessionId, { show: true, workspaceId: options?.workspaceId })
    this.focus(id)
    return id
  }

  async getOrCreateForSession(sessionId: string, options?: { workspaceId?: string | null }): Promise<string> {
    return this.createForSession(sessionId, { show: false, workspaceId: options?.workspaceId })
  }

  /** Async snapshot for the transport seam — projects the live instance to a cloneable DTO. Wire name `getInstance` (protocol v1). */
  async getInstance(id: string): Promise<BrowserInstanceSnapshot | undefined> {
    const live = this.getLiveInstance(id)
    return live ? this.toSnapshot(live) : undefined
  }

  getBoundInstanceId(sessionId: string): string | null {
    for (const [id, instance] of this.instances) {
      if (instance.boundSessionId === sessionId) {
        if (instance.window.isDestroyed()) {
          this.cleanupDestroyedInstance(instance, `getBoundInstanceId(${sessionId})`)
          continue
        }
        return id
      }
    }
    return null
  }

  destroyForSession(sessionId: string): void {
    for (const [id, instance] of this.instances) {
      if (instance.boundSessionId === sessionId) {
        this.destroyInstance(id)
      }
    }
  }

  async clearVisualsForSession(sessionId: string): Promise<void> {
    for (const instance of this.instances.values()) {
      if (instance.boundSessionId === sessionId) {
        instance.agentControl = null
        this.applyAgentControlLock(instance, false)
        this.updateNativeOverlayState(instance)
        this.emitStateChange(instance)
      }
    }
  }

  private getAgentControlLabel(agentControl: Pick<AgentControlState, 'displayName' | 'intent'> | null | undefined): string {
    if (agentControl?.intent) {
      return `${agentControl.displayName ?? 'Agent'} — ${agentControl.intent}`
    }

    return agentControl?.displayName ?? 'Agent is working…'
  }

  private reapplyAgentControlVisual(instance: BrowserInstance): void {
    const active = !!instance.agentControl?.active
    this.applyAgentControlLock(instance, active)
    this.updateNativeOverlayState(instance)
  }

  /** Resolve the app's current accent color as a concrete CSS value (not a var reference). */
  private getResolvedAccentColor(): string {
    const isDark = nativeTheme.shouldUseDarkColors
    const userTheme = loadAppTheme()
    const accent = isDark
      ? (userTheme?.dark?.accent ?? userTheme?.accent ?? DEFAULT_THEME.dark!.accent!)
      : (userTheme?.accent ?? DEFAULT_THEME.accent!)
    return accent
  }

  private async loadNativeOverlayPage(instance: BrowserInstance): Promise<void> {
    const liveFxPlatform: Parameters<typeof getBrowserLiveFxCornerRadii>[0] =
      process.platform === 'darwin' || process.platform === 'win32' || process.platform === 'linux'
        ? process.platform
        : 'other'
    const cornerRadii = getBrowserLiveFxCornerRadii(liveFxPlatform)

    const html = `<!doctype html>
<html>
  <head>
    <meta charset="utf-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1" />
    <style>
      html, body {
        margin: 0;
        width: 100%;
        height: 100%;
        background: transparent;
        overflow: hidden;
        font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif;
      }
      #overlay {
        position: fixed;
        inset: 0;
        border: 2px solid transparent;
        border-top-left-radius: ${cornerRadii.topLeft};
        border-top-right-radius: ${cornerRadii.topRight};
        border-bottom-left-radius: ${cornerRadii.bottomLeft};
        border-bottom-right-radius: ${cornerRadii.bottomRight};
        box-sizing: border-box;
        pointer-events: none;
      }
      #chip {
        position: fixed;
        top: 8px;
        right: 8px;
        padding: 4px 8px;
        border-radius: 7px;
        background: rgba(2, 6, 23, 0.82);
        color: rgba(236, 254, 255, 0.95);
        font-size: 11px;
        line-height: 1.2;
        backdrop-filter: blur(4px);
        max-width: calc(100vw - 16px);
        overflow: hidden;
        text-overflow: ellipsis;
        white-space: nowrap;
      }
      #shield {
        position: fixed;
        inset: 0;
        pointer-events: none;
        cursor: default;
      }
    </style>
  </head>
  <body>
    <div id="overlay">
      <div id="shield"></div>
      <div id="chip">Agent is working…</div>
    </div>
  </body>
</html>`

    try {
      await instance.nativeOverlayView.webContents.loadURL(`data:text/html;charset=UTF-8,${encodeURIComponent(html)}`)
      instance.nativeOverlayReady = true
      mainLog.info(`[browser-pane] native overlay ready id=${instance.id} platform=${liveFxPlatform} corners=${cornerRadii.bottomLeft}/${cornerRadii.bottomRight}`)
      this.updateNativeOverlayState(instance)
    } catch (error) {
      instance.nativeOverlayReady = false
      mainLog.warn(`[browser-pane] native overlay load failed id=${instance.id}: ${error instanceof Error ? error.message : String(error)}`)
    }
  }

  private getToolbarEffectiveHeight(instance: BrowserInstance): number {
    if (!instance.toolbarMenuOpen) return TOOLBAR_HEIGHT

    // An open toolbar menu grows the toolbar view to cover its container so the
    // dropdown is not clipped — the card's height when integrated.
    if (instance.displayMode === 'integrated') {
      return Math.max(TOOLBAR_HEIGHT, instance.embeddedBounds?.height ?? TOOLBAR_HEIGHT)
    }

    const [, contentHeight] = instance.window.getContentSize()
    return Math.max(TOOLBAR_HEIGHT, contentHeight)
  }

  /** Window the views are currently parented to, or null if it is gone. */
  private getContainerWindow(instance: BrowserInstance): BrowserWindow | null {
    const container = instance.displayMode === 'integrated' ? instance.hostWindow : instance.window
    if (!container || container.isDestroyed()) return null
    return container
  }

  /**
   * Rect the whole browser chrome occupies inside its container, in DIPs.
   * Floating fills the instance window; integrated uses the card rect the
   * renderer measured. Returns null when the container is gone or the card
   * has not reported bounds yet.
   */
  private getLayoutFrame(instance: BrowserInstance): (EmbeddedBounds & { container: BrowserWindow }) | null {
    const container = this.getContainerWindow(instance)
    if (!container) return null

    if (instance.displayMode === 'integrated') {
      const bounds = instance.embeddedBounds
      if (!bounds) return null
      return { ...bounds, container }
    }

    const [width, height] = container.getContentSize()
    return { x: 0, y: 0, width, height, container }
  }

  /**
   * Re-adding an existing child reorders it to the top of the stack — the
   * WebContentsView equivalent of the removed `setTopBrowserView`.
   */
  private raiseToolbar(instance: BrowserInstance): void {
    const container = this.getContainerWindow(instance)
    if (!container) return
    container.contentView.addChildView(instance.toolbarView)
  }

  /**
   * Width the session panel takes out of the frame, 0 when closed.
   *
   * Every other view is laid out against the remainder, so this has to be one
   * number: toolbar, page and overlay disagreeing by a pixel is a visible tear.
   */
  private sessionPanelWidthFor(instance: BrowserInstance): number {
    return instance.sessionPanelWidth === null
      ? 0
      : this.clampSessionPanelWidth(instance, instance.sessionPanelWidth)
  }

  private layoutToolbarView(instance: BrowserInstance): void {
    const frame = this.getLayoutFrame(instance)
    if (!frame) return
    const toolbarHeight = this.getToolbarEffectiveHeight(instance)

    // The panel is a sibling column with its own header, not something parked
    // under the browser's chrome — so the URL bar stays centred on the page it
    // belongs to instead of drifting over the session.
    // No setAutoResize on WebContentsView: bounds are recomputed by the window
    // 'resize' listener, which already calls layoutAllViews.
    instance.toolbarView.setBounds({
      x: frame.x,
      y: frame.y,
      width: Math.max(0, frame.width - this.sessionPanelWidthFor(instance)),
      height: toolbarHeight,
    })
  }

  private updateNativeOverlayState(instance: BrowserInstance): void {
    const control = instance.agentControl
    const agentActive = !!control?.active
    const menuActive = !!instance.toolbarMenuOverlayActive
    const shouldShow = agentActive || menuActive

    const frame = this.getLayoutFrame(instance)
    if (!shouldShow || !instance.nativeOverlayReady || !frame) {
      instance.nativeOverlayView.setBounds({ x: 0, y: 0, width: 0, height: 0 })
      this.raiseToolbar(instance)
      return
    }

    // The overlay shields the page, not the session panel: an agent driving the
    // browser must not lock the chat the user is watching it from.
    const overlayHeight = Math.max(100, frame.height - TOOLBAR_HEIGHT)
    instance.nativeOverlayView.setBounds({
      x: frame.x,
      y: frame.y + TOOLBAR_HEIGHT,
      width: Math.max(0, frame.width - this.sessionPanelWidthFor(instance)),
      height: overlayHeight,
    })
    this.raiseToolbar(instance)

    if (agentActive) {
      const label = this.getAgentControlLabel(control)
      const accent = this.getResolvedAccentColor()

      void instance.nativeOverlayView.webContents.executeJavaScript(`(() => {
        const overlay = document.getElementById('overlay');
        const chip = document.getElementById('chip');
        const shield = document.getElementById('shield');
        if (!overlay || !chip || !shield) return;

        overlay.style.borderColor = ${JSON.stringify(accent)};
        overlay.style.boxShadow = 'inset 0 0 0 1px color-mix(in oklab, ' + ${JSON.stringify(accent)} + ' 45%, transparent), inset 0 0 24px color-mix(in oklab, ' + ${JSON.stringify(accent)} + ' 28%, transparent)';
        chip.textContent = ${JSON.stringify(label)};
        chip.style.display = 'inline-flex';
        shield.style.pointerEvents = 'auto';
        shield.style.cursor = 'not-allowed';
        shield.style.background = 'rgba(2, 6, 23, 0.03)';
      })()`).catch(() => {})
      return
    }

    // Menu mode: transparent full-page tap-catcher, no visuals
    void instance.nativeOverlayView.webContents.executeJavaScript(`(() => {
      const overlay = document.getElementById('overlay');
      const chip = document.getElementById('chip');
      const shield = document.getElementById('shield');
      if (!overlay || !chip || !shield) return;

      overlay.style.borderColor = 'transparent';
      overlay.style.boxShadow = 'none';
      chip.style.display = 'none';
      shield.style.pointerEvents = 'auto';
      shield.style.cursor = 'default';
      shield.style.background = 'rgba(0, 0, 0, 0.001)';
    })()`).catch(() => {})
  }

  private getWindowResizable(window: BrowserWindow): boolean {
    return typeof window.isResizable === 'function' ? window.isResizable() : true
  }

  private setWindowResizable(window: BrowserWindow, value: boolean): void {
    if (typeof window.setResizable === 'function') {
      window.setResizable(value)
    }
  }

  private applyAgentControlLock(instance: BrowserInstance, active: boolean): void {
    const wantsLock = active && !!instance.agentControl?.active

    if (wantsLock && !instance.lockState.active) {
      instance.lockState.previousResizable = this.getWindowResizable(instance.window)
      this.setWindowResizable(instance.window, false)
      instance.lockState.active = true
      mainLog.info(`[browser-pane] interaction lock enabled id=${instance.id}`)
      return
    }

    if (!wantsLock && instance.lockState.active) {
      this.setWindowResizable(instance.window, instance.lockState.previousResizable)
      instance.lockState.active = false
      mainLog.info(`[browser-pane] interaction lock released id=${instance.id}`)
    }
  }

  destroyAll(): void {
    for (const id of [...this.instances.keys()]) {
      this.destroyInstance(id)
    }
  }

  private finalizeDestroyedInstance(instance: BrowserInstance, source: 'destroy' | 'closed'): void {
    if (!this.instances.has(instance.id)) {
      return
    }

    this.destroyingIds.delete(instance.id)
    // Best-effort cleanup: a throwing step (overlay/webContents already gone)
    // must not abort finalization — otherwise the instance is never removed,
    // the removed-callback never fires, and the exception escapes destroyInstance.
    const safe = (label: string, action: () => void): void => {
      try {
        action()
      } catch (error) {
        mainLog.warn(`[browser-pane] finalize cleanup failed id=${instance.id} step=${label} error=${error instanceof Error ? error.message : String(error)}`)
      }
    }
    // While integrated the views live in the host window, so destroying the
    // instance's own window does not take them down — detach them explicitly
    // or they keep painting over the app.
    safe('detachFromHost', () => {
      const host = instance.hostWindow
      if (!host || host.isDestroyed()) return
      for (const view of this.orderedViews(instance)) {
        host.contentView.removeChildView(view)
      }
      instance.hostWindow = null
    })
    safe('closePopupsForParent', () => this.closePopupsForParent(instance.id, 'parent_destroy'))
    safe('applyAgentControlLock', () => this.applyAgentControlLock(instance, false))
    safe('updateNativeOverlayState', () => this.updateNativeOverlayState(instance))
    safe('cdp.detach', () => instance.cdp.detach())
    safe('cancelFaviconFetch', () => this.cancelFaviconFetch(instance))
    // Destroying the window used to take the attached BrowserViews' webContents
    // with it. WebContentsView does not work that way: the view is a child of
    // contentView and its webContents outlives the window unless closed here,
    // leaving an orphan composited on screen and three renderers leaked.
    safe('closeSessionPanel', () => {
      if (instance.sessionPanelWidth !== null || instance.sessionView) {
        this.closeSessionPanel(instance)
      }
    })
    safe('closeViewWebContents', () => {
      for (const view of this.orderedViews(instance)) {
        if (!view.webContents.isDestroyed()) {
          view.webContents.close()
        }
      }
    })
    this.instances.delete(instance.id)
    this.removedCallback?.(instance.id)
    mainLog.info(`[browser-pane] Destroyed instance: ${instance.id} (${source})`)
  }

  private layoutPageView(instance: BrowserInstance): void {
    const frame = this.getLayoutFrame(instance)
    if (!frame) return

    // The session panel eats into the page, not into the window.
    instance.pageView.setBounds({
      x: frame.x,
      y: frame.y + TOOLBAR_HEIGHT,
      width: Math.max(0, frame.width - this.sessionPanelWidthFor(instance)),
      height: Math.max(100, frame.height - TOOLBAR_HEIGHT),
    })
    this.updateNativeOverlayState(instance)
  }

  private layoutAllViews(instance: BrowserInstance): void {
    this.layoutToolbarView(instance)
    this.layoutPageView(instance)
    this.layoutSessionView(instance)
    this.raiseToolbar(instance)
  }

  /**
   * Ordered back-to-front; the toolbar must end up on top.
   *
   * The session panel belongs in here: it is a sibling view like the others, so
   * every caller that detaches, reparents or closes an instance's views has to
   * take it along. Leaving it out stranded the panel on the previous window
   * across a display-mode switch while the page stayed shrunk for it.
   */
  private orderedViews(instance: BrowserInstance): WebContentsView[] {
    const views: WebContentsView[] = [instance.pageView, instance.nativeOverlayView]
    if (instance.sessionView) views.push(instance.sessionView)
    views.push(instance.toolbarView)
    return views
  }

  /**
   * Move an instance's views from one window to another. A WebContentsView can
   * only be presented in one window at a time, so the removal must happen
   * first. The underlying WebContents is untouched — the page keeps its
   * session, history and scroll position across the move.
   */
  private reparentViews(instance: BrowserInstance, from: BrowserWindow | null, to: BrowserWindow): void {
    const views = this.orderedViews(instance)

    if (from && !from.isDestroyed()) {
      for (const view of views) {
        from.contentView.removeChildView(view)
      }
    }
    for (const view of views) {
      to.contentView.addChildView(view)
    }
  }

  /**
   * Switch an instance between its own window and a card inside `hostWindow`.
   * Returns false when the mode could not be applied (unknown instance, or a
   * host window was required but not supplied).
   */
  setDisplayMode(instanceId: string, mode: BrowserDisplayMode, hostWindow?: BrowserWindow | null): boolean {
    const instance = this.instances.get(instanceId)
    if (!instance) return false
    if (instance.displayMode === mode && (mode === 'floating' || instance.hostWindow === hostWindow)) {
      return true
    }

    if (mode === 'integrated') {
      if (!hostWindow || hostWindow.isDestroyed()) {
        mainLog.warn(`[browser-pane] integrated mode needs a live host window id=${instanceId}`)
        return false
      }

      // Docked, the app's own chat sits right beside the browser — the panel
      // would be the same session twice. Close it before the reparent, while
      // `getContainerWindow` still resolves to the window it is attached to.
      if (instance.sessionPanelWidth !== null || instance.sessionView) {
        this.closeSessionPanel(instance)
      }

      const previous = this.getContainerWindow(instance)
      instance.displayMode = 'integrated'
      instance.hostWindow = hostWindow
      this.reparentViews(instance, previous, hostWindow)
      // If the host goes away the views would be orphaned, so fall back to the
      // instance's own window instead of leaking them.
      hostWindow.once('closed', () => {
        if (this.instances.get(instanceId) === instance && instance.hostWindow === hostWindow) {
          instance.hostWindow = null
          this.setDisplayMode(instanceId, 'floating')
        }
      })
      // The instance's own window stays alive but hidden: destroying it would
      // take the WebContents with it.
      if (!instance.window.isDestroyed() && instance.window.isVisible()) {
        instance.window.hide()
        instance.hiddenByIntegration = true
      }
      // The panel it fills is rounded, so the views must be too — before any
      // bounds message, which may be deduped or arrive late.
      this.applyViewRadius(instance, PANEL_INTERIOR_RADIUS)
      this.setViewsVisible(instanceId, true)
      this.layoutAllViews(instance)
      this.toolbarHost.pushState(instance)
      mainLog.info(`[browser-pane] display mode=integrated id=${instanceId}`)
      return true
    }

    const previous = this.getContainerWindow(instance)
    if (instance.window.isDestroyed()) {
      mainLog.warn(`[browser-pane] cannot float: instance window is gone id=${instanceId}`)
      return false
    }

    instance.displayMode = 'floating'
    instance.hostWindow = null
    instance.embeddedBounds = null
    this.reparentViews(instance, previous, instance.window)
    // Concealment is a transient override the renderer applies while something
    // covers the views - an app overlay, or another preview tab holding the
    // pane. It must not survive the trip back to a window of its own, or the
    // browser reappears blank.
    this.setViewsVisible(instanceId, true)
    // Corner rounding is a card affordance; a full window must not keep it.
    this.applyViewRadius(instance, 0)
    this.layoutAllViews(instance)
    // Undo exactly what docking did. A browser that was already hidden before
    // it was docked (agent-driven, never shown) stays hidden.
    if (instance.hiddenByIntegration) {
      instance.hiddenByIntegration = false
      instance.window.show()
    }
    this.toolbarHost.pushState(instance)
    mainLog.info(`[browser-pane] display mode=floating id=${instanceId}`)
    return true
  }

  /**
   * Card geometry reported by the renderer.
   *
   * `rect` is in the host renderer's CSS pixels; view bounds are in window
   * DIPs. On displays with fractional scaling Electron applies a zoom factor to
   * the renderer, so the two spaces diverge and the views would bleed outside
   * the card. Multiply by the zoom to convert, and floor every axis so the view
   * edge can never exceed the card's.
   *
   * Radius is re-applied here only to track the zoom. Docking already set it —
   * it is a consequence of being docked, not of a particular bounds message,
   * and a message that never lands must not leave the views square inside a
   * rounded panel.
   */
  setEmbeddedBounds(instanceId: string, rect: EmbeddedBounds, zoomFactor = 1): boolean {
    const instance = this.instances.get(instanceId)
    if (!instance || instance.displayMode !== 'integrated') return false

    const zoom = Number.isFinite(zoomFactor) && zoomFactor > 0 ? zoomFactor : 1
    instance.embeddedBounds = {
      x: Math.max(0, Math.floor(rect.x * zoom)),
      y: Math.max(0, Math.floor(rect.y * zoom)),
      width: Math.max(1, Math.floor(rect.width * zoom)),
      height: Math.max(1, Math.floor(rect.height * zoom)),
    }

    this.applyViewRadius(instance, Math.round(PANEL_INTERIOR_RADIUS * zoom))

    this.layoutAllViews(instance)
    return true
  }

  /**
   * Take the native views off screen without unloading them.
   *
   * A WebContentsView always paints above the renderer, so an app dropdown
   * reaching over the docked browser is drawn behind it. There is no CSS answer
   * — the views are not part of the document. Hiding them for the life of the
   * overlay is the only lever, and it keeps the page's WebContents alive so
   * nothing reloads when it comes back.
   */
  setViewsVisible(instanceId: string, visible: boolean): boolean {
    const instance = this.instances.get(instanceId)
    if (!instance) return false
    for (const view of this.orderedViews(instance)) {
      view.setVisible(visible)
    }
    return true
  }

  /**
   * Corner radius for the native views.
   *
   * They are siblings composing one card, so they must agree: a rounded page
   * next to a square session panel reads as two unrelated surfaces. Where two
   * rounded neighbours curve away from each other the card's own background
   * shows through, which is why that hole is painted chrome-coloured rather
   * than left transparent.
   */
  private applyViewRadius(instance: BrowserInstance, radius: number): void {
    instance.viewRadius = radius
    instance.pageView.setBorderRadius(radius)
    instance.toolbarView.setBorderRadius(radius)
    instance.sessionView?.setBorderRadius(radius)
  }

  getDisplayMode(instanceId: string): BrowserDisplayMode | null {
    return this.instances.get(instanceId)?.displayMode ?? null
  }

  /**
   * Toggle the session panel embedded on the right of the page.
   *
   * The panel is a sibling WebContentsView running Craft's own renderer inside
   * the browser window — not a second OS window. One window that drags and
   * resizes as a unit, which is the whole point.
   *
   * Floating only. Docked into the app the session is already on screen next
   * to the browser, and a panel would render it a second time.
   */
  toggleSessionPanel(instanceId: string): boolean {
    const instance = this.instances.get(instanceId)
    if (!instance || instance.window.isDestroyed()) return false

    if (instance.sessionPanelWidth !== null) {
      this.closeSessionPanel(instance)
      return true
    }
    if (instance.displayMode === 'integrated') {
      mainLog.info(`[browser-pane] session panel skipped while docked id=${instanceId}`)
      return false
    }
    return this.openSessionPanel(instance)
  }

  private closeSessionPanel(instance: BrowserInstance): void {
    instance.sessionPanelWidth = null

    // Unload rather than hide: a parked Craft renderer keeps a websocket and a
    // full React tree alive for a panel nobody is looking at.
    const view = instance.sessionView
    if (view) {
      const wcId = view.webContents.isDestroyed() ? null : view.webContents.id
      const container = this.getContainerWindow(instance)
      if (container) container.contentView.removeChildView(view)
      if (wcId !== null) {
        this.windowManager?.unregisterViewClient(wcId)
        view.webContents.close()
      }
      instance.sessionView = null
    }

    this.layoutAllViews(instance)
    mainLog.info(`[browser-pane] session panel closed id=${instance.id}`)
  }

  private openSessionPanel(instance: BrowserInstance): boolean {
    const container = this.getContainerWindow(instance)
    if (!container) return false
    if (!this.windowManager) {
      mainLog.warn('[browser-pane] session panel needs a window manager')
      return false
    }

    const workspaceId = instance.workspaceId ?? ''
    const sessionId = instance.boundSessionId ?? instance.ownerSessionId

    const view = new WebContentsView({
      webPreferences: {
        preload: join(__dirname, 'bootstrap-preload.cjs'),
        contextIsolation: true,
        nodeIntegration: false,
        sandbox: false,
      },
    })
    view.setBackgroundColor('#00000000')
    // Born into whatever the siblings already carry, or a panel opened while
    // the browser is docked comes up square against two rounded neighbours.
    view.setBorderRadius(instance.viewRadius)

    // Register BEFORE loading: the bootstrap preload asks for the workspace
    // synchronously while it evaluates, so a late registration reads as "no
    // workspace" and the renderer comes up empty.
    this.windowManager.registerViewClient(view.webContents.id, workspaceId)

    // Param names must match App.tsx:174 — `sessionId`, not `session`. With the
    // wrong key focused mode has nothing to focus on and falls back to the full
    // shell (sidebar + session list), which is not a panel.
    const query: Record<string, string> = { workspaceId, focused: 'true' }
    if (sessionId) query.sessionId = sessionId
    const params = new URLSearchParams(query).toString()

    if (VITE_DEV_SERVER_URL) {
      void view.webContents.loadURL(`${VITE_DEV_SERVER_URL}?${params}`)
    } else {
      void view.webContents.loadFile(join(__dirname, 'renderer/index.html'), { query })
    }

    instance.sessionView = view
    instance.sessionPanelWidth = this.clampSessionPanelWidth(instance, DEFAULT_SESSION_PANEL_WIDTH)
    container.contentView.addChildView(view)

    this.layoutAllViews(instance)
    mainLog.info(`[browser-pane] session panel opened id=${instance.id} session=${sessionId ?? 'list'}`)
    return true
  }

  /**
   * Panel width for the current frame.
   *
   * Both floors together need MIN_PAGE_WIDTH + MIN_SESSION_PANEL_WIDTH. Below
   * that they contradict each other, and honouring both would push the page
   * out past the frame — reachable in integrated mode, where the frame is the
   * card rect rather than the window. Split the frame evenly instead: cramped
   * beats overflowing.
   */
  private clampSessionPanelWidth(instance: BrowserInstance, width: number): number {
    const frame = this.getLayoutFrame(instance)
    if (!frame) return width
    const room = frame.width - MIN_PAGE_WIDTH
    if (room < MIN_SESSION_PANEL_WIDTH) return Math.max(0, Math.floor(frame.width / 2))
    return Math.min(Math.max(width, MIN_SESSION_PANEL_WIDTH), room)
  }

  private layoutSessionView(instance: BrowserInstance): void {
    const view = instance.sessionView
    const frame = this.getLayoutFrame(instance)
    if (!view || !frame || instance.sessionPanelWidth === null) return

    const width = this.clampSessionPanelWidth(instance, instance.sessionPanelWidth)
    instance.sessionPanelWidth = width
    // Full height, not offset by the toolbar: the panel is the browser's peer,
    // and it brings its own header. Sitting under the URL bar made it look
    // like a drawer of the page instead of a column beside it.
    view.setBounds({
      x: frame.x + frame.width - width,
      y: frame.y,
      width,
      height: frame.height,
    })
  }

  private forceCloseToolbarMenu(instance: BrowserInstance, reason: string): void {
    if (!instance.toolbarMenuOpen && instance.toolbarMenuHeight === 0 && !instance.toolbarMenuOverlayActive) {
      return
    }

    instance.toolbarMenuOpen = false
    instance.toolbarMenuHeight = 0
    instance.toolbarMenuOverlayActive = false
    this.layoutAllViews(instance)

    if (!instance.window.isDestroyed() && !instance.toolbarView.webContents.isDestroyed()) {
      instance.toolbarView.webContents.send(TOOLBAR_CHANNELS.FORCE_CLOSE_MENU, { reason })
    }
  }

  private isBrowserEmptyStateUrl(url: string): boolean {
    if (!url) return false
    return url.includes(`/${BROWSER_EMPTY_STATE_PAGE}`) || url.includes(`\\${BROWSER_EMPTY_STATE_PAGE}`)
  }

  private normalizePageState(url: string, title: string): { url: string; title: string } {
    if (this.isBrowserEmptyStateUrl(url)) {
      return { url: 'about:blank', title: 'New Tab' }
    }
    return { url, title }
  }

  private async loadEmptyStatePage(instance: BrowserInstance): Promise<void> {
    if (VITE_DEV_SERVER_URL) {
      await instance.pageView.webContents.loadURL(`${VITE_DEV_SERVER_URL}/${BROWSER_EMPTY_STATE_PAGE}`)
      return
    }

    await instance.pageView.webContents.loadFile(join(__dirname, `renderer/${BROWSER_EMPTY_STATE_PAGE}`))
  }

  private async handleDeepLinkUrl(url: string): Promise<void> {
    if (!url.startsWith(CRAFT_DEEPLINK_SCHEME_PREFIX)) return

    try {
      if (!this.windowManager) {
        mainLog.warn('[browser-pane] window manager unavailable for deep-link handling, falling back to shell.openExternal')
        await shell.openExternal(url)
        return
      }

      const { handleDeepLink } = await import('./deep-link')
      const sink = this.windowManager.getRpcEventSink() ?? undefined
      const resolver = (wcId: number) => this.windowManager?.getClientIdForWindow(wcId)
      const result = await handleDeepLink(url, this.windowManager, sink, resolver)
      if (!result.success) {
        mainLog.warn(`[browser-pane] deep-link handling failed: ${result.error ?? 'unknown error'} url=${url}`)
      }
    } catch (error) {
      mainLog.warn(`[browser-pane] deep-link handling threw, falling back to shell.openExternal: ${error instanceof Error ? error.message : String(error)}`)
      await shell.openExternal(url)
    }
  }

  private async maybeHandleEmptyStateLaunch(instance: BrowserInstance, url: string): Promise<boolean> {
    if (!this.isBrowserEmptyStateUrl(url) || !url.includes('#launch=')) {
      return false
    }

    let parsed: URL
    try {
      parsed = new URL(url)
    } catch {
      return false
    }

    const hash = parsed.hash.startsWith('#') ? parsed.hash.slice(1) : parsed.hash
    const launchPayload = hash.startsWith('launch=') ? hash.slice('launch='.length) : hash
    if (!launchPayload) return false

    const params = new URLSearchParams(launchPayload)
    const route = params.get('route')
    const token = params.get('ts') ?? route ?? null

    if (!route) {
      mainLog.warn(`[browser-pane] empty-state launch missing route id=${instance.id}`)
      return false
    }

    const handled = await this.triggerEmptyStateRouteLaunch(instance, route, token, 'hash')

    try {
      await instance.pageView.webContents.executeJavaScript(
        "if (window.location.hash.includes('launch=')) history.replaceState(null, '', window.location.pathname + window.location.search);",
      )
    } catch {
      // Best effort cleanup only
    }

    return handled
  }

  private sleep(ms: number): Promise<void> {
    return new Promise(resolve => setTimeout(resolve, ms))
  }

  /** Register IPC handlers for toolbar actions. Call once at app startup. */
  registerToolbarIpc(): void {
    this.toolbarHost.registerIpc()
  }

  // ---------------------------------------------------------------------------
  // Capability IPC — dispatcher for the `client:browser:invoke` WS capability.
  //
  // Sits between the preload bridge (which receives the WS request from the
  // remote server) and the real BrowserPaneManager. It rewrites session IDs to
  // an owner-key namespace, refuses any instance ID not owned by the calling
  // (workspaceId, sessionId), and blocks unsafe methods like `uploadFile` or
  // (optionally) `evaluate`.
  // ---------------------------------------------------------------------------

  /** Register the `__browser:invoke` IPC handler. Call once at app startup. */
  registerCapabilityIpc(): void {
    ipcMain.handle('__browser:invoke', async (_event, req: BrowserCapabilityRequest) => {
      return await this.dispatchCapability(req)
    })
    mainLog.info('[browser-pane] Capability IPC handler registered')
  }

  /** Owner-key namespacing: remote sessions can't collide with local sessions. */
  private toOwnerKey(workspaceId: string, sessionId: string): string {
    return `remote:${workspaceId}:${sessionId}`
  }

  private isRemoteOwnerKey(value: string | null | undefined): value is string {
    return typeof value === 'string' && value.startsWith('remote:')
  }

  private parseOwnerKey(value: string): { workspaceId: string; sessionId: string } | null {
    if (!this.isRemoteOwnerKey(value)) return null
    const rest = value.slice('remote:'.length)
    const colon = rest.indexOf(':')
    if (colon === -1) return null
    return { workspaceId: rest.slice(0, colon), sessionId: rest.slice(colon + 1) }
  }

  /** Replace `remote:${ws}:${sid}` owner-keys with raw `sid` on outbound payloads. */
  private stripOwnerKeysInPlace<T extends Partial<BrowserInstanceInfo>>(info: T): T {
    if (this.isRemoteOwnerKey(info.boundSessionId)) {
      info.boundSessionId = this.parseOwnerKey(info.boundSessionId)!.sessionId
    }
    if (this.isRemoteOwnerKey(info.ownerSessionId)) {
      info.ownerSessionId = this.parseOwnerKey(info.ownerSessionId)!.sessionId
    }
    return info
  }

  /**
   * Throws `BROWSER_INSTANCE_NOT_OWNED` unless the instance belongs to `ownerKey`.
   * Called by every dispatcher branch that accepts an instanceId — including read-only ones.
   */
  private requireOwnedInstance(instanceId: string, ownerKey: string): void {
    const instance = this.instances.get(instanceId)
    if (!instance || instance.window.isDestroyed()) {
      throw new CodedError('BROWSER_INSTANCE_NOT_OWNED', `Browser instance "${instanceId}" not found.`)
    }
    const owned = instance.boundSessionId === ownerKey || instance.ownerSessionId === ownerKey
    if (!owned) {
      throw new CodedError('BROWSER_INSTANCE_NOT_OWNED',
        `Browser instance "${instanceId}" is not owned by this session.`)
    }
  }

  /**
   * Defesa em profundidade: mesmo que um pane em captura chegue às mãos de uma
   * sessão, o seam do agente não navega nem destrói. A navegação do usuário
   * sobre o próprio pane continua livre — este guard só cobre o seam.
   */
  private requireUnlockedInstance(instanceId: string, operation: string): void {
    const lock = this.instances.get(instanceId)?.captureLock
    if (!lock) return
    throw new CodedError('BROWSER_INSTANCE_CAPTURE_LOCKED',
      `Browser instance "${instanceId}" is capturing (${lock.reason}); "${operation}" is not allowed while recording.`)
  }

  /** Session-scoped listInstances — never returns workspace-wide windows to a remote agent. */
  private listInstancesForOwner(ownerKey: string): BrowserInstanceInfo[] {
    const infos: BrowserInstanceInfo[] = []
    for (const instance of this.instances.values()) {
      if (instance.window.isDestroyed()) {
        this.cleanupDestroyedInstance(instance, 'listInstancesForOwner')
        continue
      }
      const owned = instance.boundSessionId === ownerKey || instance.ownerSessionId === ownerKey
      if (!owned) continue
      infos.push(this.stripOwnerKeysInPlace(this.toInfo(instance)))
    }
    return infos
  }

  /**
   * Extract a plain {@link BrowserInstanceSnapshot} from a live `BrowserInstance`.
   *
   * `this.getLiveInstance(id)` returns the full instance, which has non-cloneable
   * Electron native references (`window: BrowserWindow`, `pageView: WebContentsView`,
   * `toolbarView`, ...). When we ship the result back over the `__browser:invoke`
   * IPC channel, Electron's structured-clone serializer throws
   * "An object could not be cloned". Always pass the live instance through this
   * helper before returning over IPC.
   */
  private toSnapshot(instance: BrowserInstance): BrowserInstanceSnapshot {
    return {
      ownerType: instance.ownerType,
      ownerSessionId: instance.ownerSessionId,
      isVisible: instance.isVisible,
      captureLock: instance.captureLock,
      title: instance.title,
      currentUrl: instance.currentUrl,
    }
  }

  private toScreenshotWire(result: BrowserScreenshotResult): ScreenshotResultWire {
    const buf = result.imageBuffer
    return {
      imageFormat: result.imageFormat,
      imageBytes: new Uint8Array(buf.buffer, buf.byteOffset, buf.byteLength),
      metadata: result.metadata,
    }
  }

  /**
   * Wire dispatch table — one entry per `BrowserCapabilityMethod`, keyed off the
   * derived union so the compiler forces a handler for every capability (a new
   * capability is a single entry here plus its real method above). Session-scoped
   * methods remap the caller's sessionId to an owner-key namespace; instance-scoped
   * methods first assert ownership so a remote agent can't touch another session's
   * window. The evaluate gate lives in `evaluate()` itself, not here.
   */
  private readonly capabilityDispatch: Record<BrowserCapabilityMethod, CapabilityHandler> = {
    // -- Session-scoped (sessionId → ownerKey) ------------------------------
    createForSession: (args, { ownerKey, workspaceId }) => {
      const [, options] = args as [string, { show?: boolean } | undefined]
      return this.createForSession(ownerKey, { show: options?.show ?? false, allowReuseManual: false, workspaceId })
    },
    // Remote agents must NEVER reuse a manual/unbound window (allowReuseManual:false):
    // each remote session-id namespace gets a fresh window unless it already owns one.
    getOrCreateForSession: (_args, { ownerKey, workspaceId }) =>
      this.createForSession(ownerKey, { show: false, allowReuseManual: false, workspaceId }),
    focusBoundForSession: async (_args, { ownerKey, workspaceId }) => {
      const id = await this.createForSession(ownerKey, { show: true, allowReuseManual: false, workspaceId })
      this.focus(id)
      return id
    },
    destroyForSession: (_args, { ownerKey }) => { this.destroyForSession(ownerKey) },
    clearVisualsForSession: (_args, { ownerKey }) => this.clearVisualsForSession(ownerKey),
    unbindAllForSession: (_args, { ownerKey }) => { this.unbindAllForSession(ownerKey) },
    setAgentControl: (args, { ownerKey, workspaceId }) => {
      const [, meta] = args as [string, { displayName?: string; intent?: string }]
      this.setAgentControl(ownerKey, meta, { workspaceId })
    },
    clearAgentControl: (_args, { ownerKey }) => { this.clearAgentControl(ownerKey) },

    // -- Mixed (instanceId + optional sessionId) ----------------------------
    clearAgentControlForInstance: (args, { ownerKey }) => {
      const [instanceId, sessionId] = args as [string, string | undefined]
      this.requireOwnedInstance(instanceId, ownerKey)
      return this.clearAgentControlForInstance(instanceId, sessionId !== undefined ? ownerKey : undefined)
    },

    // -- Instance snapshots --------------------------------------------------
    getInstance: (args, { ownerKey }) => {
      const [instanceId] = args as [string]
      this.requireOwnedInstance(instanceId, ownerKey)
      const live = this.getLiveInstance(instanceId)
      // Project the live instance (non-cloneable Electron natives) to a plain snapshot.
      return live ? this.stripOwnerKeysInPlace(this.toSnapshot(live)) : undefined
    },
    listInstances: (_args, { ownerKey }) => this.listInstancesForOwner(ownerKey),

    // -- Instance-id only ----------------------------------------------------
    bindSession: (args, { ownerKey, workspaceId }) => {
      const [instanceId] = args as [string, string]
      this.requireOwnedInstance(instanceId, ownerKey)
      this.bindSession(instanceId, ownerKey, { workspaceId })
    },
    focus: (args, { ownerKey }) => {
      const [instanceId] = args as [string]
      this.requireOwnedInstance(instanceId, ownerKey)
      this.focus(instanceId)
    },
    hide: (args, { ownerKey }) => {
      const [instanceId] = args as [string]
      this.requireOwnedInstance(instanceId, ownerKey)
      this.hide(instanceId)
    },
    destroyInstance: (args, { ownerKey }) => {
      const [instanceId] = args as [string]
      this.requireOwnedInstance(instanceId, ownerKey)
      this.requireUnlockedInstance(instanceId, 'destroyInstance')
      this.destroyInstance(instanceId)
    },

    // -- Navigation ----------------------------------------------------------
    navigate: (args, { ownerKey }) => {
      const [instanceId, url] = args as [string, string]
      this.requireOwnedInstance(instanceId, ownerKey)
      this.requireUnlockedInstance(instanceId, 'navigate')
      return this.navigate(instanceId, url)
    },
    goBack: (args, { ownerKey }) => {
      const [instanceId] = args as [string]
      this.requireOwnedInstance(instanceId, ownerKey)
      return this.goBack(instanceId)
    },
    goForward: (args, { ownerKey }) => {
      const [instanceId] = args as [string]
      this.requireOwnedInstance(instanceId, ownerKey)
      return this.goForward(instanceId)
    },

    // -- Interaction ---------------------------------------------------------
    getAccessibilitySnapshot: (args, { ownerKey }) => {
      const [instanceId] = args as [string]
      this.requireOwnedInstance(instanceId, ownerKey)
      return this.getAccessibilitySnapshot(instanceId)
    },
    clickElement: (args, { ownerKey }) => {
      const [instanceId, ref, options] = args as [
        string, string,
        { waitFor?: 'none' | 'navigation' | 'network-idle'; timeoutMs?: number } | undefined,
      ]
      this.requireOwnedInstance(instanceId, ownerKey)
      return this.clickElement(instanceId, ref, options)
    },
    clickAtCoordinates: (args, { ownerKey }) => {
      const [instanceId, x, y] = args as [string, number, number]
      this.requireOwnedInstance(instanceId, ownerKey)
      return this.clickAtCoordinates(instanceId, x, y)
    },
    drag: (args, { ownerKey }) => {
      const [instanceId, x1, y1, x2, y2] = args as [string, number, number, number, number]
      this.requireOwnedInstance(instanceId, ownerKey)
      return this.drag(instanceId, x1, y1, x2, y2)
    },
    fillElement: (args, { ownerKey }) => {
      const [instanceId, ref, value] = args as [string, string, string]
      this.requireOwnedInstance(instanceId, ownerKey)
      return this.fillElement(instanceId, ref, value)
    },
    typeText: (args, { ownerKey }) => {
      const [instanceId, text] = args as [string, string]
      this.requireOwnedInstance(instanceId, ownerKey)
      return this.typeText(instanceId, text)
    },
    selectOption: (args, { ownerKey }) => {
      const [instanceId, ref, value] = args as [string, string, string]
      this.requireOwnedInstance(instanceId, ownerKey)
      return this.selectOption(instanceId, ref, value)
    },
    sendKey: (args, { ownerKey }) => {
      const [instanceId, keyArgs] = args as [string, BrowserKeyArgs]
      this.requireOwnedInstance(instanceId, ownerKey)
      return this.sendKey(instanceId, keyArgs)
    },
    scroll: (args, { ownerKey }) => {
      const [instanceId, direction, amount] = args as [string, 'up' | 'down' | 'left' | 'right', number | undefined]
      this.requireOwnedInstance(instanceId, ownerKey)
      return this.scroll(instanceId, direction, amount)
    },
    waitFor: (args, { ownerKey }) => {
      const [instanceId, waitArgs] = args as [string, BrowserWaitArgs]
      this.requireOwnedInstance(instanceId, ownerKey)
      return this.waitFor(instanceId, waitArgs)
    },
    evaluate: (args, { ownerKey }) => {
      const [instanceId, expression] = args as [string, string]
      this.requireOwnedInstance(instanceId, ownerKey)
      return this.evaluate(instanceId, expression)
    },

    // -- Clipboard -----------------------------------------------------------
    setClipboard: (args, { ownerKey }) => {
      const [instanceId, text] = args as [string, string]
      this.requireOwnedInstance(instanceId, ownerKey)
      return this.setClipboard(instanceId, text)
    },
    getClipboard: (args, { ownerKey }) => {
      const [instanceId] = args as [string]
      this.requireOwnedInstance(instanceId, ownerKey)
      return this.getClipboard(instanceId)
    },

    // -- Capture / introspection --------------------------------------------
    screenshot: async (args, { ownerKey }) => {
      const [instanceId, options] = args as [string, BrowserScreenshotOptions | undefined]
      this.requireOwnedInstance(instanceId, ownerKey)
      return this.toScreenshotWire(await this.screenshot(instanceId, options))
    },
    screenshotRegion: async (args, { ownerKey }) => {
      const [instanceId, target] = args as [string, BrowserScreenshotRegionTarget]
      this.requireOwnedInstance(instanceId, ownerKey)
      return this.toScreenshotWire(await this.screenshotRegion(instanceId, target))
    },
    getConsoleLogs: (args, { ownerKey }) => {
      const [instanceId, options] = args as [string, BrowserConsoleOptions | undefined]
      this.requireOwnedInstance(instanceId, ownerKey)
      return this.getConsoleLogs(instanceId, options)
    },
    getNetworkLogs: (args, { ownerKey }) => {
      const [instanceId, options] = args as [string, BrowserNetworkOptions | undefined]
      this.requireOwnedInstance(instanceId, ownerKey)
      return this.getNetworkLogs(instanceId, options)
    },
    windowResize: (args, { ownerKey }) => {
      const [instanceId, width, height] = args as [string, number, number]
      this.requireOwnedInstance(instanceId, ownerKey)
      return this.windowResize(instanceId, width, height)
    },
    getDownloads: (args, { ownerKey }) => {
      const [instanceId, options] = args as [string, BrowserDownloadOptions | undefined]
      this.requireOwnedInstance(instanceId, ownerKey)
      return this.getDownloads(instanceId, options)
    },
    uploadFile: () => {
      throw new CodedError('BROWSER_REMOTE_UPLOAD_NOT_SUPPORTED',
        'File upload from a remote agent is not supported yet. Ask the user to attach the file to the session.')
    },
    detectSecurityChallenge: (args, { ownerKey }) => {
      const [instanceId] = args as [string]
      this.requireOwnedInstance(instanceId, ownerKey)
      return this.detectSecurityChallenge(instanceId)
    },
  }

  /** Main dispatcher — table lookup over the derived `BrowserCapabilityMethod` union. */
  private async dispatchCapability(req: BrowserCapabilityRequest): Promise<unknown> {
    if (!req || req.v !== 1) {
      const version = req && typeof req === 'object' && 'v' in req ? req.v : undefined
      throw new CodedError('HANDLER_ERROR',
        `Unsupported browser capability request shape (v=${String(version)}).`)
    }
    // Object.hasOwn guards against Object.prototype keys (constructor, toString,
    // hasOwnProperty, …) resolving to an inherited function via the prototype
    // chain — the switch `default:` arm this table replaced rejected them, so the
    // lookup must too.
    if (!Object.hasOwn(this.capabilityDispatch, req.method)) {
      throw new CodedError('HANDLER_ERROR', `Unknown browser capability method: ${String(req.method)}`)
    }
    const handler = this.capabilityDispatch[req.method]
    return await handler(req.args ?? [], {
      ownerKey: this.toOwnerKey(req.workspaceId, req.sessionId),
      workspaceId: req.workspaceId,
    })
  }

  // ---------------------------------------------------------------------------
  // Agent Control — persistent overlay while agent is using the browser
  // ---------------------------------------------------------------------------

  /**
   * Activate or update the agent control overlay on the browser instance
   * bound to the given session. Called from sessions.ts on browser_* tool_start events.
   */
  setAgentControl(
    sessionId: string,
    meta: { displayName?: string; intent?: string },
    options?: { workspaceId?: string | null },
  ): void {
    for (const instance of this.instances.values()) {
      if (instance.boundSessionId === sessionId) {
        if (options?.workspaceId !== undefined) {
          instance.workspaceId = options.workspaceId
        }
        instance.agentControl = {
          active: true,
          sessionId,
          displayName: meta.displayName,
          intent: meta.intent,
        }

        const label = this.getAgentControlLabel(instance.agentControl)

        this.reapplyAgentControlVisual(instance)
        this.emitStateChange(instance)

        mainLog.info(`[browser-pane] agent control activated session=${sessionId} label=${label}`)
        return
      }
    }
  }

  /**
   * Clear the agent control overlay for the given session.
   * Called on explicit browser_tool release and session/window teardown.
   */
  clearAgentControl(sessionId: string): void {
    for (const instance of this.instances.values()) {
      if (instance.boundSessionId === sessionId && instance.agentControl?.active) {
        instance.agentControl = null
        this.applyAgentControlLock(instance, false)
        this.updateNativeOverlayState(instance)
        this.emitStateChange(instance)
        mainLog.info(`[browser-pane] agent control released session=${sessionId}`)
      }
    }
  }

  async clearAgentControlForInstance(instanceId: string, sessionId?: string): Promise<{ released: boolean; reason?: string }> {
    const instance = this.instances.get(instanceId)
    if (!instance) {
      return { released: false, reason: `Browser window "${instanceId}" not found.` }
    }

    if (sessionId) {
      if (instance.boundSessionId && instance.boundSessionId !== sessionId) {
        return { released: false, reason: `Browser window "${instanceId}" is locked to session ${instance.boundSessionId}.` }
      }

      if (!instance.boundSessionId && instance.ownerSessionId && instance.ownerSessionId !== sessionId) {
        return { released: false, reason: `Browser window "${instanceId}" is currently owned by session ${instance.ownerSessionId}.` }
      }
    }

    if (!instance.agentControl?.active) {
      return { released: false, reason: 'No active agent overlay on the target window.' }
    }

    instance.agentControl = null
    this.applyAgentControlLock(instance, false)
    this.updateNativeOverlayState(instance)
    this.emitStateChange(instance)
    mainLog.info(`[browser-pane] agent control released instance=${instanceId}${sessionId ? ` session=${sessionId}` : ''}`)

    return { released: true }
  }

  private getInstanceByWebContentsId(webContentsId: number): BrowserInstance | undefined {
    for (const instance of this.instances.values()) {
      if (instance.pageView.webContents.id === webContentsId) return instance
    }
    return undefined
  }

  private registerPopupWindow(parentInstance: BrowserInstance, popupWindow: BrowserWindow, sourceUrl?: string): void {
    const popupWcId = popupWindow.webContents.id
    // Remember the id while the popup is alive so teardown (and the reparent
    // unregister below) never has to read `webContents` after destruction.
    this.popupWebContentsIdByWindow.set(popupWindow, popupWcId)
    const existingParent = this.popupParentByWebContentsId.get(popupWcId)
    if (existingParent && existingParent !== parentInstance.id) {
      this.unregisterPopupWindow(popupWindow, 'reparented')
    }

    let popups = this.popupWindowsByParentInstanceId.get(parentInstance.id)
    if (!popups) {
      popups = new Set<BrowserWindow>()
      this.popupWindowsByParentInstanceId.set(parentInstance.id, popups)
    }

    popups.add(popupWindow)
    this.popupParentByWebContentsId.set(popupWcId, parentInstance.id)
    this.popupWebContentsIdByWindow.set(popupWindow, popupWcId)

    const initialUrl = sourceUrl || popupWindow.webContents.getURL?.() || 'about:blank'
    mainLog.info(`[browser-pane] popup created parent=${parentInstance.id} popupWebContentsId=${popupWcId} url=${initialUrl}`)

    // SECURITY (F7/R1): allowlist de esquemas também na navegação client-side
    // do popup — a checagem do setWindowOpenHandler só cobre a URL de abertura.
    popupWindow.webContents.on('will-navigate', (event, url) => {
      if (!isAllowedTopLevelUrl(url)) {
        event.preventDefault()
        mainLog.warn(
          `[browser-pane] popup navigation blocked parent=${parentInstance.id} popupWebContentsId=${popupWcId} reason=unsupported_scheme url=${url}`,
        )
      }
    })

    popupWindow.webContents.on('did-navigate', (_event, urlFromEvent) => {
      const popupUrl = typeof popupWindow.webContents.getURL === 'function'
        ? popupWindow.webContents.getURL()
        : (urlFromEvent || initialUrl)
      mainLog.info(`[browser-pane] popup did-navigate parent=${parentInstance.id} popupWebContentsId=${popupWcId} url=${popupUrl}`)
    })

    popupWindow.webContents.on('did-redirect-navigation', (_event, popupUrl, isInPlace, isMainFrame) => {
      // SECURITY (F7/R1): popups carregam conteúdo web — mesmo tratamento
      // reativo do pageWc para redirects a esquemas proibidos.
      if (isMainFrame && !isAllowedTopLevelUrl(popupUrl)) {
        mainLog.warn(
          `[browser-pane] popup redirect blocked parent=${parentInstance.id} popupWebContentsId=${popupWcId} reason=unsupported_scheme url=${popupUrl}`,
        )
        popupWindow.webContents.stop()
        void popupWindow.webContents.loadURL('about:blank')
        return
      }
      mainLog.info(
        `[browser-pane] popup redirect parent=${parentInstance.id} popupWebContentsId=${popupWcId} url=${popupUrl} inPlace=${isInPlace} mainFrame=${isMainFrame}`,
      )
    })

    popupWindow.webContents.on('did-fail-load', (_event, errorCode, errorDescription, validatedURL, isMainFrame) => {
      if (!isMainFrame) return
      mainLog.warn(
        `[browser-pane] popup did-fail-load parent=${parentInstance.id} popupWebContentsId=${popupWcId} code=${errorCode} url=${validatedURL} error=${errorDescription}`,
      )
    })

    popupWindow.on('closed', () => {
      this.unregisterPopupWindow(popupWindow, 'closed')
    })
  }

  private unregisterPopupWindow(popupWindow: BrowserWindow, reason: 'closed' | 'parent_destroy' | 'reparented'): void {
    const popupWcId = this.popupWebContentsIdByWindow.get(popupWindow)
    if (popupWcId === undefined) return
    this.popupWebContentsIdByWindow.delete(popupWindow)
    const parentId = this.popupParentByWebContentsId.get(popupWcId)
    if (!parentId) return

    this.popupParentByWebContentsId.delete(popupWcId)

    const popups = this.popupWindowsByParentInstanceId.get(parentId)
    if (popups) {
      popups.delete(popupWindow)
      if (popups.size === 0) {
        this.popupWindowsByParentInstanceId.delete(parentId)
      }
    }

    mainLog.info(`[browser-pane] popup closed parent=${parentId} popupWebContentsId=${popupWcId} reason=${reason}`)
  }

  private closePopupsForParent(parentId: string, reason: 'parent_destroy'): void {
    const popups = this.popupWindowsByParentInstanceId.get(parentId)
    if (!popups || popups.size === 0) return

    for (const popupWindow of Array.from(popups)) {
      const popupWcId = this.popupWebContentsIdByWindow.get(popupWindow)
      this.unregisterPopupWindow(popupWindow, reason)
      try {
        if (!popupWindow.isDestroyed()) {
          popupWindow.destroy()
        }
      } catch (error) {
        mainLog.warn(
          `[browser-pane] popup destroy failed parent=${parentId} popupWebContentsId=${popupWcId} reason=${reason} error=${error instanceof Error ? error.message : String(error)}`,
        )
      }
    }
  }

  private pushNetworkLog(instance: BrowserInstance, entry: BrowserNetworkEntry): void {
    instance.networkLogs.push(entry)
    if (instance.networkLogs.length > MAX_NETWORK_LOG_ENTRIES) {
      instance.networkLogs.splice(0, instance.networkLogs.length - MAX_NETWORK_LOG_ENTRIES)
    }
  }

  private pushDownloadLog(instance: BrowserInstance, entry: BrowserDownloadEntry): void {
    instance.downloads.push(entry)
    if (instance.downloads.length > MAX_DOWNLOAD_LOG_ENTRIES) {
      instance.downloads.splice(0, instance.downloads.length - MAX_DOWNLOAD_LOG_ENTRIES)
    }
  }

  private resolveDownloadsDir(instance: BrowserInstance): string {
    const sessionId = instance.boundSessionId ?? instance.ownerSessionId
    if (sessionId && this.sessionPathResolver) {
      const sessionPath = this.sessionPathResolver(sessionId)
      if (sessionPath) {
        const dir = join(sessionPath, 'downloads')
        mkdirSync(dir, { recursive: true })
        return dir
      }
    }
    // Fallback: OS downloads folder for manual/unbound windows
    return app.getPath('downloads')
  }

  private uniqueFilename(dir: string, filename: string): string {
    if (!existsSync(join(dir, filename))) return filename
    const { name, ext } = parsePath(filename)
    let counter = 1
    while (existsSync(join(dir, `${name}_${counter}${ext}`))) {
      counter++
    }
    return `${name}_${counter}${ext}`
  }

  private setupSessionObservers(ses: ElectronSession): void {
    if (this.partitionObserversInitialized) return
    this.partitionObserversInitialized = true

    ses.webRequest.onBeforeRequest((details, callback) => {
      const wcId = details.webContentsId
      if (typeof wcId === 'number' && wcId > 0) {
        const current = this.inFlightRequestsByWebContentsId.get(wcId) ?? 0
        this.inFlightRequestsByWebContentsId.set(wcId, current + 1)
        this.lastNetworkActivityByWebContentsId.set(wcId, Date.now())
      }
      callback({})
    })

    ses.webRequest.onCompleted((details) => {
      const wcId = details.webContentsId
      if (typeof wcId !== 'number' || wcId <= 0) return

      const current = this.inFlightRequestsByWebContentsId.get(wcId) ?? 0
      this.inFlightRequestsByWebContentsId.set(wcId, Math.max(0, current - 1))
      this.lastNetworkActivityByWebContentsId.set(wcId, Date.now())

      const instance = this.getInstanceByWebContentsId(wcId)
      if (!instance) return

      this.pushNetworkLog(instance, {
        timestamp: Date.now(),
        method: details.method ?? 'GET',
        url: details.url ?? '',
        status: details.statusCode ?? 0,
        resourceType: String(details.resourceType ?? 'unknown'),
        ok: (details.statusCode ?? 0) >= 200 && (details.statusCode ?? 0) < 400,
      })
    })

    ses.webRequest.onErrorOccurred((details) => {
      const wcId = details.webContentsId
      if (typeof wcId !== 'number' || wcId <= 0) return

      const current = this.inFlightRequestsByWebContentsId.get(wcId) ?? 0
      this.inFlightRequestsByWebContentsId.set(wcId, Math.max(0, current - 1))
      this.lastNetworkActivityByWebContentsId.set(wcId, Date.now())

      const instance = this.getInstanceByWebContentsId(wcId)
      if (!instance) return

      this.pushNetworkLog(instance, {
        timestamp: Date.now(),
        method: details.method ?? 'GET',
        url: details.url ?? '',
        status: 0,
        resourceType: String(details.resourceType ?? 'unknown'),
        ok: false,
      })
    })

    ses.on('will-download', (_event, item, webContents) => {
      const wcId = webContents?.id
      if (typeof wcId !== 'number') return
      const instance = this.getInstanceByWebContentsId(wcId)
      if (!instance) return

      // Auto-save: set a deterministic path so Electron doesn't show a native dialog
      const downloadsDir = this.resolveDownloadsDir(instance)
      const filename = this.uniqueFilename(downloadsDir, item.getFilename())
      const savePath = join(downloadsDir, filename)
      item.setSavePath(savePath)

      const downloadId = `dl-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`
      const started: BrowserDownloadEntry = {
        id: downloadId,
        timestamp: Date.now(),
        url: item.getURL(),
        filename,
        state: 'started',
        bytesReceived: item.getReceivedBytes(),
        totalBytes: item.getTotalBytes(),
        mimeType: item.getMimeType() || 'application/octet-stream',
        savePath,
      }
      this.pushDownloadLog(instance, started)

      const onUpdated = (_e: Electron.Event, state: string) => {
        const latest = instance.downloads.find((d) => d.id === downloadId)
        if (!latest) return
        latest.bytesReceived = item.getReceivedBytes()
        latest.totalBytes = item.getTotalBytes()
        if (state === 'interrupted') latest.state = 'interrupted'
      }

      item.on('updated', onUpdated)

      item.once('done', (_e, state) => {
        item.removeListener('updated', onUpdated)
        const latest = instance.downloads.find((d) => d.id === downloadId)
        if (!latest) return
        latest.bytesReceived = item.getReceivedBytes()
        latest.totalBytes = item.getTotalBytes()
        latest.savePath = item.getSavePath()
        latest.state = state === 'completed' ? 'completed' : state === 'cancelled' ? 'cancelled' : 'interrupted'
      })
    })
  }

  // Permissions that are always denied for the browser pane by design and that
  // chatty sites (service workers, ad/analytics frames) probe repeatedly. Their
  // denial is routine, so log it at most once per origin and at debug level.
  private static readonly ROUTINE_DENIED_PERMISSIONS = new Set([
    'background-sync',
    'web-app-installation',
    'background-fetch',
    'periodic-background-sync',
  ])

  private logPermissionDecision(kind: 'check' | 'request', permission: string, origin: string): void {
    // Suppress repeats: SWs re-probe the same denied permission on a timer (even
    // after the pane is destroyed), which would otherwise flood the log.
    const dedupeKey = `${kind}:${permission}:${origin}`
    if (this.loggedPermissionDenials.has(dedupeKey)) return
    this.loggedPermissionDenials.add(dedupeKey)

    const isRoutine = BrowserPaneManager.ROUTINE_DENIED_PERMISSIONS.has(permission)
    const suffix = permission === 'background-sync' ? ' (non-blocking)' : ''
    const message = `[browser-pane] permission denied (${kind}): ${permission} origin=${origin}${suffix}`
    if (isRoutine) {
      mainLog.debug(message)
      return
    }
    mainLog.warn(message)
  }

  private setupSessionPermissions(ses: ElectronSession): void {
    if (this.configuredPermissionSessions.has(ses)) return
    this.configuredPermissionSessions.add(ses)

    // SECURITY (auditoria 2026-07-14 / F1.3): clipboard-read and display-capture
    // are denied by default. The allow-set decision and check/request handler
    // wiring live in the partition-hardening module so they are unit-testable
    // with a stub session; this class only owns the per-partition dedupe guard.
    hardenSessionPermissions(ses, {
      logDenied: (kind, permission, origin) => this.logPermissionDecision(kind, permission, origin),
    })

    if (typeof ses.setDisplayMediaRequestHandler === 'function') {
      ses.setDisplayMediaRequestHandler((request, callback) => {
        const requester = request.frame ? webContents.fromFrame(request.frame) : undefined
        const instance = requester
          ? Array.from(this.instances.values()).find((candidate) => candidate.toolbarView.webContents.id === requester.id)
          : undefined

        if (!instance || instance.pageView.webContents.isDestroyed()) {
          mainLog.warn(`[browser-pane] display capture denied: no matching browser instance for origin=${request.securityOrigin}`)
          callback({})
          return
        }

        const targetFrame = instance.pageView.webContents.mainFrame
        const streams: Streams = {}
        if (request.videoRequested) streams.video = targetFrame
        if (request.audioRequested) {
          streams.audio = targetFrame
          streams.enableLocalEcho = true
        }
        callback(streams)
      })
    }
  }

  private setupSessionClientHints(ses: ElectronSession): void {
    if (this.configuredClientHintSessions.has(ses)) return
    this.configuredClientHintSessions.add(ses)
    if (typeof ses.webRequest?.onBeforeSendHeaders !== 'function') return

    ses.webRequest.onBeforeSendHeaders((details, callback) => {
      callback({ requestHeaders: normalizeChromeClientHints(details.requestHeaders) })
    })
  }

  private isToolbarUiDocumentUrl(url: string): boolean {
    if (!url) return false
    if (url.startsWith('data:text/html')) return true

    try {
      const parsed = new URL(url)
      return parsed.pathname.toLowerCase().endsWith('/browser-toolbar.html')
    } catch {
      return /browser-toolbar\.html(?:$|[?#])/i.test(url)
    }
  }

  private setupWindowListeners(instance: BrowserInstance): void {
    const pageWc = instance.pageView.webContents
    const toolbarWc = instance.toolbarView.webContents
    const overlayWc = instance.nativeOverlayView.webContents

    instance.window.on('close', (event) => {
      const explicitDestroy = this.destroyingIds.has(instance.id)
      const interceptToHide = !explicitDestroy && instance.keepAliveOnWindowClose
      mainLog.info(`[browser-pane] window close requested id=${instance.id} explicitDestroy=${explicitDestroy} keepAlive=${instance.keepAliveOnWindowClose} interceptToHide=${interceptToHide}`)

      if (interceptToHide) {
        event.preventDefault()
        this.hide(instance.id)
      }
    })

    instance.window.on('resize', () => {
      this.layoutAllViews(instance)
    })

    toolbarWc.on('did-finish-load', () => {
      const loadedUrl = typeof toolbarWc.getURL === 'function' ? toolbarWc.getURL() : ''
      if (!this.isToolbarUiDocumentUrl(loadedUrl)) {
        mainLog.info(`[browser-pane] toolbar did-finish-load ignored id=${instance.id} url=${loadedUrl || 'unknown'}`)
        this.toolbarHost.pushState(instance)
        return
      }

      this.toolbarHost.markReady(instance, 'did-finish-load')
      this.toolbarHost.pushState(instance)
    })

    toolbarWc.on('did-fail-load', (_event, errorCode, errorDescription, validatedURL, isMainFrame) => {
      if (!isMainFrame) return
      mainLog.warn(`[browser-pane] toolbar did-fail-load id=${instance.id} code=${errorCode} url=${validatedURL} error=${errorDescription}`)
    })

    pageWc.on('did-start-loading', () => {
      instance.isLoading = true
      this.emitStateChange(instance)
      void this.toolbarHost.pushState(instance)
    })

    pageWc.on('did-stop-loading', () => {
      instance.isLoading = false
      instance.canGoBack = pageWc.canGoBack()
      instance.canGoForward = pageWc.canGoForward()
      // Drain in-flight count — all pending requests are settled once loading stops
      this.inFlightRequestsByWebContentsId.set(pageWc.id, 0)
      this.lastNetworkActivityByWebContentsId.set(pageWc.id, Date.now())
      this.emitStateChange(instance)
      void this.toolbarHost.pushState(instance)
      void this.themeExtractor.extract(instance)
      this.reapplyAgentControlVisual(instance)
    })

    pageWc.on('dom-ready', () => {
      this.themeExtractor.installObserver(instance)
      void this.themeExtractor.extract(instance)
    })

    pageWc.on('before-input-event', (event, input) => {
      // DevTools toggle. The browser pane is a chromeless WebContentsView with no
      // menu, so the usual DevTools shortcut never reaches it. Wire it directly:
      // Cmd+Opt+I (mac), Ctrl+Shift+I, or F12. Use input.code (physical key) so
      // Option-composed characters on mac don't break the match. The automation
      // CDP debugger and DevTools are mutually exclusive, so detach CDP before
      // opening; DevTools opens detached since the view has no host window.
      if (input.type === 'keyDown') {
        const code = input.code || ''
        const isInspectCombo =
          (code === 'KeyI' && input.alt && (input.meta || input.control)) ||
          (code === 'KeyI' && input.control && input.shift) ||
          code === 'F12'
        if (isInspectCombo) {
          event.preventDefault()
          if (pageWc.isDevToolsOpened()) {
            pageWc.closeDevTools()
          } else {
            instance.cdp.detach()
            pageWc.openDevTools({ mode: 'detach' })
          }
          return
        }
      }

      if (instance.lockState.active) {
        event.preventDefault()
      }
    })

    toolbarWc.on('before-input-event', (event) => {
      if (instance.lockState.active) {
        event.preventDefault()
      }
    })

    overlayWc.on('before-input-event', (event, input) => {
      if (!instance.toolbarMenuOverlayActive) return

      const inputType = input.type || ''
      if (inputType === 'mouseDown' || inputType === 'touchStart' || inputType === 'pointerDown') {
        event.preventDefault()
        this.forceCloseToolbarMenu(instance, 'overlay-tap')
      }
    })

    pageWc.on('did-navigate', (_event, urlFromEvent) => {
      const url = typeof pageWc.getURL === 'function' ? pageWc.getURL() : (urlFromEvent || instance.currentUrl)
      const previousUrl = instance.currentUrl
      if (instance.inPageThemeTimer) {
        clearTimeout(instance.inPageThemeTimer)
        instance.inPageThemeTimer = null
      }
      instance.themeObserverToken = null
      instance.themeColor = null // reset for new page (batched with state push below)
      // The previous page's icon does not describe this one, and its fetch is
      // now pointless — drop both before the state push below.
      this.cancelFaviconFetch(instance)
      instance.favicon = null
      instance.faviconCandidateKey = null
      const normalized = this.normalizePageState(url, pageWc.getTitle())
      instance.currentUrl = normalized.url
      instance.title = normalized.title
      mainLog.info(`[browser-pane] did-navigate id=${instance.id} from=${previousUrl} to=${instance.currentUrl}`)
      instance.canGoBack = pageWc.canGoBack()
      instance.canGoForward = pageWc.canGoForward()
      // Drain in-flight count — prior page's requests are cancelled on navigation
      this.inFlightRequestsByWebContentsId.set(pageWc.id, 0)
      this.lastNetworkActivityByWebContentsId.set(pageWc.id, Date.now())
      this.emitStateChange(instance)
      void this.toolbarHost.pushState(instance)
      this.themeExtractor.scheduleEarly(instance, url)
      this.reapplyAgentControlVisual(instance)
    })

    pageWc.on('did-redirect-navigation', (_event, url, isInPlace, isMainFrame) => {
      if (!isMainFrame) return
      // SECURITY (F7/R1): redirect de servidor para esquema proibido — o evento
      // não é cancelável, então a reação é parar o load e ir para about:blank.
      if (!isAllowedTopLevelUrl(url)) {
        mainLog.warn(`[browser-pane] redirect blocked id=${instance.id} reason=unsupported_scheme url=${url}`)
        pageWc.stop()
        void pageWc.loadURL('about:blank')
        return
      }
      mainLog.info(`[browser-pane] did-redirect-navigation id=${instance.id} url=${url} inPlace=${isInPlace}`)
    })

    pageWc.on('did-navigate-in-page', (_event, urlFromEvent) => {
      const url = typeof pageWc.getURL === 'function' ? pageWc.getURL() : (urlFromEvent || instance.currentUrl)
      const normalized = this.normalizePageState(url, instance.title)
      instance.currentUrl = normalized.url
      instance.title = normalized.title
      instance.canGoBack = pageWc.canGoBack()
      instance.canGoForward = pageWc.canGoForward()

      void this.maybeHandleEmptyStateLaunch(instance, url).then((handled) => {
        if (handled) {
          this.emitStateChange(instance)
          void this.toolbarHost.pushState(instance)
          return
        }

        // SPA route change — re-extract theme color (debounced)
        if (instance.inPageThemeTimer) clearTimeout(instance.inPageThemeTimer)
        instance.themeObserverToken = null
        instance.themeColor = null
        this.emitStateChange(instance)
        void this.toolbarHost.pushState(instance)
        this.themeExtractor.installObserver(instance)
        instance.inPageThemeTimer = setTimeout(() => { void this.themeExtractor.extract(instance) }, 300)
        this.reapplyAgentControlVisual(instance)
      }).catch((error) => {
        mainLog.warn(`[browser-pane] empty-state launch handling failed id=${instance.id}: ${error instanceof Error ? error.message : String(error)}`)
      })
    })

    pageWc.on('page-title-updated', (_event, title) => {
      const normalized = this.normalizePageState(pageWc.getURL(), title)
      instance.title = normalized.title
      this.emitStateChange(instance)
      void this.toolbarHost.pushState(instance)
    })

    pageWc.on('page-favicon-updated', (_event, favicons) => {
      this.updateFavicon(instance, favicons ?? [])
    })

    pageWc.on('render-process-gone', (_event, details) => {
      mainLog.warn(`[browser-pane] render-process-gone id=${instance.id} reason=${details?.reason ?? 'unknown'}`)
      // The instance survives a renderer crash, so an in-flight favicon would
      // otherwise still paint onto the crashed page up to the fetch timeout.
      this.cancelFaviconFetch(instance)
    })

    pageWc.on('did-change-theme-color', (_event, color) => {
      this.themeExtractor.apply(instance, color ?? null)
    })

    pageWc.on('did-fail-load', (_event, errorCode, errorDescription, validatedURL) => {
      mainLog.warn(`[browser-pane] did-fail-load id=${instance.id} code=${errorCode} url=${validatedURL} error=${errorDescription}`)
    })

    pageWc.on('console-message', (_event, level, message) => {
      if (this.themeExtractor.handleConsoleSignal(instance, message)) return

      const mappedLevel: BrowserConsoleEntry['level'] = level >= 3 ? 'error' : level === 2 ? 'warn' : level === 1 ? 'info' : 'log'
      instance.consoleLogs.push({
        timestamp: Date.now(),
        level: mappedLevel,
        message,
      })
      if (instance.consoleLogs.length > MAX_CONSOLE_LOG_ENTRIES) {
        instance.consoleLogs.splice(0, instance.consoleLogs.length - MAX_CONSOLE_LOG_ENTRIES)
      }

      if (level >= 2) {
        mainLog.warn(`[browser-pane] console id=${instance.id} level=${level}: ${message}`)
      }
    })

    pageWc.on('will-navigate', (event, url) => {
      const outcome = decideWillNavigate(url, instance.navigationPolicy)
      if (outcome.action === 'allow') return
      event.preventDefault()
      if (outcome.action === 'external') {
        void shell.openExternal(url)
        return
      }
      if (outcome.action === 'deep-link') {
        void this.handleDeepLinkUrl(url)
        return
      }
      mainLog.warn(`[browser-pane] navigation blocked id=${instance.id} reason=${outcome.reason} url=${url}`)
    })

    pageWc.on('did-create-window', (popupWindow, details) => {
      const popupUrl = details?.url || popupWindow.webContents.getURL?.() || 'about:blank'
      this.registerPopupWindow(instance, popupWindow, popupUrl)
    })

    pageWc.setWindowOpenHandler((details) => {
      mainLog.info(
        `[browser-pane] window-open requested id=${instance.id} url=${details.url} disposition=${details.disposition ?? 'unknown'} frameName=${details.frameName || 'none'}`,
      )

      const outcome = decideWindowOpen(details.url, instance.navigationPolicy)
      if (outcome.action === 'deep-link') {
        void this.handleDeepLinkUrl(details.url)
        return { action: 'deny' }
      }
      if (outcome.action === 'deny') {
        mainLog.warn(`[browser-pane] window-open denied id=${instance.id} reason=${outcome.reason} url=${details.url}`)
        return { action: 'deny' }
      }
      if (outcome.action === 'external') {
        void shell.openExternal(details.url)
        return { action: 'deny' }
      }

      return {
        action: 'allow',
        overrideBrowserWindowOptions: {
          width: 520,
          height: 720,
          minWidth: 420,
          minHeight: 520,
          show: true,
          autoHideMenuBar: true,
          parent: instance.window,
          modal: false,
          webPreferences: {
            partition: getProfilePartition(instance.profileId),
            session: pageWc.session,
            contextIsolation: true,
            nodeIntegration: false,
            sandbox: true,
          },
        },
      }
    })

    pageWc.on('focus', () => {
      this.interactedCallback?.(instance.id)
    })

    instance.window.on('focus', () => {
      this.interactedCallback?.(instance.id)
    })

    instance.window.on('show', () => {
      instance.isVisible = true
      this.emitStateChange(instance)
      this.reapplyAgentControlVisual(instance)
      this.toolbarHost.pushState(instance)
      this.updateNativeOverlayState(instance)
      if (!instance.themeColor) {
        void this.themeExtractor.extract(instance)
      }
    })

    instance.window.on('hide', () => {
      instance.isVisible = false
      this.emitStateChange(instance)
      this.updateNativeOverlayState(instance)
    })

    instance.window.on('closed', () => {
      this.finalizeDestroyedInstance(instance, 'closed')
    })
  }

  private toInfo(instance: BrowserInstance): BrowserInstanceInfo {
    return {
      id: instance.id,
      profileId: instance.profileId,
      url: instance.currentUrl,
      title: instance.title,
      favicon: instance.favicon,
      isLoading: instance.isLoading,
      canGoBack: instance.canGoBack,
      canGoForward: instance.canGoForward,
      boundSessionId: instance.boundSessionId,
      ownerType: instance.ownerType,
      ownerSessionId: instance.ownerSessionId,
      isVisible: instance.isVisible,
      captureLock: instance.captureLock,
      agentControlActive: !!instance.agentControl?.active,
      themeColor: instance.themeColor,
    }
  }

  /**
   * SECURITY: the favicon URL comes from the page, so it never leaves this
   * process. We fetch it here — in the pane's own session, so the proxy comes
   * from that partition — and hand the renderer a validated `data:` URL, which
   * the renderer CSP already allows. See `browser/favicon-transport.ts`.
   *
   * The state push does not wait for the bytes: the page would otherwise sit
   * without state for as long as the favicon host takes to answer.
   */
  private updateFavicon(instance: BrowserInstance, candidateUrls: readonly string[]): void {
    // Pages re-announce the same list on every SPA route change; refetching it
    // (and blanking the badge in between) would be pure churn.
    const key = candidateUrls.join('\n') || null
    if (key && key === instance.faviconCandidateKey) return

    this.cancelFaviconFetch(instance)
    instance.faviconCandidateKey = key
    instance.favicon = null
    this.emitStateChange(instance)

    const candidates = candidateUrls.filter(isFetchableFaviconUrl).slice(0, FAVICON_MAX_CANDIDATES)
    if (candidates.length === 0) return
    const pageWc = instance.pageView.webContents
    if (pageWc.isDestroyed()) return

    const controller = new AbortController()
    const token = instance.faviconToken
    instance.faviconAbort = controller

    // fetchFaviconDataUrl never throws, so this promise never rejects and needs
    // no catch. A favicon failure is not worth a log line per navigation.
    void this.resolveFavicon(instance, candidates, controller, token)
  }

  /**
   * Walk the page's candidates until one survives every guard.
   *
   * The list matters because the content-type allowlist rejects SVG: a site
   * that announces `favicon.svg` first still has its PNG/ICO honoured. Attempts
   * are sequential, so the single-in-flight invariant holds throughout.
   */
  private async resolveFavicon(
    instance: BrowserInstance,
    candidates: readonly string[],
    controller: AbortController,
    token: number,
  ): Promise<void> {
    const fetch = this.createFaviconFetcher(instance.pageView.webContents.session)
    for (const candidate of candidates) {
      const dataUrl = await fetchFaviconDataUrl(candidate, { fetch, signal: controller.signal })
      // Navigation or destroy already moved on — this icon belongs to a page
      // that is no longer on screen, and a newer fetch owns `faviconAbort`.
      if (instance.faviconToken !== token) return
      if (!dataUrl) continue
      instance.faviconAbort = null
      instance.favicon = dataUrl
      this.emitStateChange(instance)
      return
    }
    // Settled controller, no icon: clear it anyway so the field never claims a
    // fetch is in flight.
    instance.faviconAbort = null
  }

  /**
   * `session.fetch` cannot do this: `net.fetch` registers no `redirect`
   * listener, so `redirect: 'manual'` there just cancels the request, and
   * `redirect: 'follow'` would chase a server-chosen destination that no guard
   * ever saw (`Response.url` is documented as unreliable under `net.fetch`).
   * Driving `ClientRequest` directly is what makes "every destination requested
   * passed the scheme allowlist" an enforced invariant rather than a hope.
   *
   * `credentials: 'omit'` because decoration has no business carrying the
   * partition's cookies or auth to a page-chosen host.
   */
  private createFaviconFetcher(paneSession: ElectronSession): FaviconFetcher {
    return (url, init) => new Promise<FaviconHttpResponse>((resolve, reject) => {
      const request = net.request({
        url,
        session: paneSession,
        method: 'GET',
        credentials: 'omit',
        redirect: 'manual',
      })
      let hopsFollowed = 0
      let settled = false
      const onAbort = (): void => request.abort()
      init.signal.addEventListener('abort', onAbort, { once: true })
      const settle = (apply: () => void): void => {
        if (settled) return
        settled = true
        init.signal.removeEventListener('abort', onAbort)
        apply()
      }

      request.on('redirect', (_status, _method, redirectUrl) => {
        // The hop target is chosen by the server, so it faces the same scheme
        // allowlist as the URL the page announced. followRedirect() must be
        // called synchronously or Electron cancels the request for us.
        if (!shouldFollowFaviconRedirect(redirectUrl, hopsFollowed)) {
          request.abort()
          return
        }
        hopsFollowed += 1
        request.followRedirect()
      })
      request.on('response', (response) => {
        settle(() => resolve({
          ok: response.statusCode >= 200 && response.statusCode <= 299,
          status: response.statusCode,
          headers: { get: (name) => firstHeaderValue(response.headers, name) },
          body: Readable.toWeb(response as unknown as Readable) as unknown as ReadableStream<Uint8Array>,
        }))
      })
      request.on('error', (error) => settle(() => reject(error)))
      request.on('abort', () => settle(() => reject(new Error('favicon request aborted'))))
      request.end()
    })
  }

  private cancelFaviconFetch(instance: BrowserInstance): void {
    instance.faviconToken += 1
    instance.faviconAbort?.abort()
    instance.faviconAbort = null
  }

  private emitStateChange(instance: BrowserInstance): void {
    if (!this.instances.has(instance.id)) {
      return
    }
    this.stateChangeCallback?.(this.toInfo(instance))
  }
}
