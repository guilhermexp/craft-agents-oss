/**
 * IBrowserPaneManager — the transport seam for browser pane operations.
 *
 * This is the async boundary SessionManager talks to: the local Electron
 * `BrowserPaneManager` implements it in-process, and `RemoteBrowserPaneManager`
 * ships each call to the user's desktop client over `client:browser:invoke`.
 * Because the remote adapter is a WS round-trip, EVERY data-returning method is
 * async — there are no sync/async twins and no fabricated placeholder values.
 *
 * The agent-facing command surface lives in `BrowserPaneFns` (packages/shared);
 * this interface is only the instance-scoped transport it delegates to. The
 * wire method names in `BrowserCapabilityMethod` are derived from these keys.
 *
 * Structurally compatible with BrowserOwnershipReleaser (domain layer)
 * so releaseBrowserOwnershipOnForcedStop() accepts IBrowserPaneManager.
 */

import type { BrowserInstanceInfo } from '@craft-agent/shared/protocol'

// ---------------------------------------------------------------------------
// Supporting types — minimal subsets of BPM's internal types
// ---------------------------------------------------------------------------

/** Subset of BrowserInstance fields accessed by SessionManager */
export interface BrowserInstanceSnapshot {
  ownerType: 'session' | 'manual'
  ownerSessionId: string | null
  isVisible: boolean
  /** Non-null enquanto a tela do pane está sob captura (gravação de reunião). */
  captureLock?: { reason: 'meeting-recording'; since: number } | null
  title: string
  currentUrl: string
}

export interface BrowserScreenshotOptions {
  mode?: 'raw' | 'agent'
  refs?: string[]
  includeLastAction?: boolean
  includeMetadata?: boolean
  annotate?: boolean
  format?: 'png' | 'jpeg'
  jpegQuality?: number
}

export interface BrowserScreenshotResult {
  imageBuffer: Buffer
  imageFormat: 'png' | 'jpeg'
  metadata?: Record<string, unknown>
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

export interface BrowserConsoleOptions {
  level?: 'all' | 'log' | 'info' | 'warn' | 'error'
  limit?: number
}

export interface BrowserConsoleEntry {
  timestamp: number
  level: 'log' | 'info' | 'warn' | 'error'
  message: string
}

export interface BrowserNetworkOptions {
  limit?: number
  status?: 'all' | 'failed' | '2xx' | '3xx' | '4xx' | '5xx'
  method?: string
  resourceType?: string
}

export interface BrowserNetworkEntry {
  timestamp: number
  method: string
  url: string
  status: number
  resourceType: string
  ok: boolean
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
  kind: string
  elapsedMs: number
  detail: string
}

export interface BrowserKeyArgs {
  key: string
  modifiers?: Array<'shift' | 'control' | 'alt' | 'meta'>
}

export interface BrowserDownloadOptions {
  action?: 'list' | 'wait'
  limit?: number
  timeoutMs?: number
}

export interface BrowserDownloadEntry {
  id: string
  timestamp: number
  url: string
  filename: string
  state: string
  bytesReceived: number
  totalBytes: number
  mimeType: string
  savePath?: string
}

export interface AccessibilityNode {
  ref: string
  role: string
  name: string
  value?: string
  description?: string
  focused?: boolean
  checked?: boolean
  disabled?: boolean
}

export interface AccessibilitySnapshot {
  url: string
  title: string
  nodes: AccessibilityNode[]
}

// ---------------------------------------------------------------------------
// Interface
// ---------------------------------------------------------------------------

export interface IBrowserPaneManager {
  // -- Session lifecycle ---------------------------------------------------

  /** Register a callback that resolves session IDs to file paths (local-only, not a wire capability) */
  setSessionPathResolver(fn: (sessionId: string) => string | null): void

  /**
   * Assert that agent-driven JS evaluation is permitted by this client's local
   * `allowRemoteEvaluate` config. Throws `CodedError('BROWSER_REMOTE_EVALUATE_BLOCKED')`
   * when disabled. Local-only (never crosses the wire, like setSessionPathResolver):
   * the desktop's `evaluate()` enforces this same gate authoritatively, so the
   * remote adapter is a no-op and SessionManager can pre-check before creating an
   * instance. Single policy source — `evaluate()` calls this too.
   */
  assertEvaluateAllowed(): void

  /** Destroy all browser instances bound to a session (fire-and-forget) */
  destroyForSession(sessionId: string): void

  /** Clear agent control overlay and native overlay state for a session */
  clearVisualsForSession(sessionId: string): Promise<void>

  /** Unbind all browser instances from a session (non-destructive, fire-and-forget) */
  unbindAllForSession(sessionId: string): void

  /** Get or create a browser instance for a session, returning the instance ID */
  getOrCreateForSession(sessionId: string, options?: { workspaceId?: string | null }): Promise<string>

  /** Activate or update the agent control overlay for a session (fire-and-forget) */
  setAgentControl(
    sessionId: string,
    meta: { displayName?: string; intent?: string },
    options?: { workspaceId?: string | null },
  ): void

  // -- Instance management -------------------------------------------------

  /** Create a browser instance for a session (optionally shown), returning the instance ID */
  createForSession(sessionId: string, options?: { show?: boolean; workspaceId?: string | null }): Promise<string>

  /** Get a cloneable snapshot of an instance by ID (undefined when unknown). Wire name kept as `getInstance` for protocol v1 compat. */
  getInstance(id: string): Promise<BrowserInstanceSnapshot | undefined>

  /** List all browser instances with their public info */
  listInstances(): Promise<BrowserInstanceInfo[]>

  /** Focus the bound browser instance for a session, creating if needed */
  focusBoundForSession(sessionId: string, options?: { workspaceId?: string | null }): Promise<string>

  /** Bind a browser instance to a session (fire-and-forget) */
  bindSession(id: string, sessionId: string, options?: { workspaceId?: string | null }): void

  /** Focus a browser instance window (fire-and-forget) */
  focus(id: string): void

  /** Destroy a browser instance (fire-and-forget) */
  destroyInstance(id: string): void

  /** Hide a browser instance window (fire-and-forget) */
  hide(id: string): void

  /** Clear agent control overlay for all instances in a session (fire-and-forget) */
  clearAgentControl(sessionId: string): void

  /** Clear agent control overlay for a specific instance */
  clearAgentControlForInstance(instanceId: string, sessionId?: string): Promise<{ released: boolean; reason?: string }>

  // -- Navigation ----------------------------------------------------------

  navigate(id: string, url: string): Promise<{ url: string; title: string }>
  goBack(id: string): Promise<void>
  goForward(id: string): Promise<void>

  // -- Interaction ---------------------------------------------------------

  getAccessibilitySnapshot(id: string): Promise<AccessibilitySnapshot>
  clickElement(id: string, ref: string, options?: { waitFor?: 'none' | 'navigation' | 'network-idle'; timeoutMs?: number }): Promise<void>
  clickAtCoordinates(id: string, x: number, y: number): Promise<void>
  drag(id: string, x1: number, y1: number, x2: number, y2: number): Promise<void>
  fillElement(id: string, ref: string, value: string): Promise<void>
  typeText(id: string, text: string): Promise<void>
  selectOption(id: string, ref: string, value: string): Promise<void>
  setClipboard(id: string, text: string): Promise<void>
  getClipboard(id: string): Promise<string>
  scroll(id: string, direction: 'up' | 'down' | 'left' | 'right', amount?: number): Promise<void>
  sendKey(id: string, args: BrowserKeyArgs): Promise<void>
  uploadFile(id: string, ref: string, filePaths: string[]): Promise<unknown>
  evaluate(id: string, expression: string): Promise<unknown>

  // -- Screenshot ----------------------------------------------------------

  screenshot(id: string, options?: BrowserScreenshotOptions): Promise<BrowserScreenshotResult>
  screenshotRegion(id: string, target: BrowserScreenshotRegionTarget): Promise<BrowserScreenshotResult>

  // -- Monitoring ----------------------------------------------------------

  getConsoleLogs(id: string, options?: BrowserConsoleOptions): Promise<BrowserConsoleEntry[]>
  windowResize(id: string, width: number, height: number): Promise<{ width: number; height: number }>
  getNetworkLogs(id: string, options?: BrowserNetworkOptions): Promise<BrowserNetworkEntry[]>
  waitFor(id: string, args: BrowserWaitArgs): Promise<BrowserWaitResult>
  getDownloads(id: string, options?: BrowserDownloadOptions): Promise<BrowserDownloadEntry[]>
  detectSecurityChallenge(id: string): Promise<{ detected: boolean; provider: string; signals: string[] }>
}
