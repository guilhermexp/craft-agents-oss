/**
 * RemoteBrowserPaneManager
 *
 * Generic transport adapter that satisfies `IBrowserPaneManager` for one remote
 * session. The seam underneath is a single `invoke(method, args)` WS round-trip,
 * so this is a thin Proxy: every interface method ships its positional args to
 * the user's desktop client via `server.invokeClient(...)`, and the local
 * `BrowserPaneManager` dispatcher (apps/electron) executes it. A new
 * data-returning capability needs ZERO edits here — adding it to
 * `IBrowserPaneManager` is enough. A new sync-`void` capability IS caught by the
 * compiler: `FIRE_AND_FORGET` is a `Record<FireAndForgetMethod, true>` derived
 * from the interface, so a void method missing from it fails to typecheck.
 *
 * Bespoke handling, kept as explicit overrides:
 *   - screenshot / screenshotRegion — Buffer<->Uint8Array wire conversion.
 *   - uploadFile — refused (no path to ship a local file from a remote agent).
 *   - setSessionPathResolver — local-only, no-op over the wire.
 *   - assertEvaluateAllowed — local-only gate; the desktop's `evaluate()` is
 *     authoritative, so the remote pre-check is a no-op (see IBrowserPaneManager).
 * Fire-and-forget lifecycle methods (the sync-`void` interface members) are
 * dispatched without awaiting: cleanup paths must not block on the WS.
 *
 * One instance per (sessionId, workspaceId). Stored on `SessionManager` in a
 * `Map<sessionId, IBrowserPaneManager>` and torn down on session destroy.
 *
 * See docs/adr-transport-locality.md for the locality boundary definition.
 */

import { CodedError } from '@craft-agent/shared/protocol'
import { createScopedLogger, CONSOLE_LOGGER } from '../runtime/platform'
import type {
  IBrowserPaneManager,
  BrowserScreenshotOptions,
  BrowserScreenshotRegionTarget,
  BrowserScreenshotResult,
} from '../handlers/browser-pane-manager-interface'
import { CLIENT_BROWSER_INVOKE, requestClientBrowserInvoke } from '../transport/capabilities'
import type { BrowserCapabilityMethod, ScreenshotResultWire } from '../transport/browser-capability'
import type { RpcServer } from '../transport/types'

const remoteBpmLog = createScopedLogger(CONSOLE_LOGGER, 'remote-bpm')

export interface RemoteBrowserPaneManagerDeps {
  readonly sessionId: string
  readonly workspaceId: string
  readonly rpcServer: RpcServer
  /**
   * Resolves the desktop client that should host this session's browser.
   * Returns null when no capable client is connected. SessionManager handles
   * pin + fallback selection so the bridge stays agnostic of routing policy.
   */
  readonly getHostClient: () => string | null
}

/**
 * Wire methods whose interface return type is sync `void`. DERIVED from
 * `IBrowserPaneManager` (not a hand-kept mirror): `Record<FireAndForgetMethod,
 * true>` is exhaustive, so a new void capability that forgets this table fails
 * to typecheck instead of silently becoming an un-awaited Promise.
 *
 * Dispatched over the wire but never awaited — a silent failure on a cleanup
 * path leaks a remote tab, so `invokeSync` logs it.
 */
type FireAndForgetMethod = {
  [K in BrowserCapabilityMethod]: IBrowserPaneManager[K] extends (...args: never[]) => infer R
    ? ([R] extends [void] ? ([void] extends [R] ? K : never) : never)
    : never
}[BrowserCapabilityMethod]

const FIRE_AND_FORGET: Record<FireAndForgetMethod, true> = {
  destroyForSession: true,
  unbindAllForSession: true,
  setAgentControl: true,
  bindSession: true,
  focus: true,
  destroyInstance: true,
  hide: true,
  clearAgentControl: true,
}

/**
 * Non-wire property keys — thenable protocol + JS serialization/coercion hooks.
 * Matched with `Object.hasOwn` (never a prototype-chain lookup) and resolved from
 * the plain target (`Reflect.get`) instead of a dispatcher, so `await bridge`,
 * `String(bridge)`, and `JSON.stringify(bridge)` use default Object behavior
 * rather than firing a WS round-trip (or throwing on a missing `toString`).
 */
const NON_METHOD_KEYS: Record<string, boolean> = {
  then: true, catch: true, finally: true,
  toJSON: true, toString: true, valueOf: true, toLocaleString: true, constructor: true,
}

/**
 * Owns the WS plumbing: client resolution, capability check, and the single
 * `invoke(method, args)` round-trip that every interface method funnels through.
 */
class RemoteBrowserPaneCore {
  private readonly sessionId: string
  private readonly workspaceId: string
  private readonly rpcServer: RpcServer
  private readonly getHostClient: () => string | null

  constructor(deps: RemoteBrowserPaneManagerDeps) {
    this.sessionId = deps.sessionId
    this.workspaceId = deps.workspaceId
    this.rpcServer = deps.rpcServer
    this.getHostClient = deps.getHostClient
  }

  async invoke<T>(method: BrowserCapabilityMethod, args: unknown[]): Promise<T> {
    const clientId = this.getHostClient()
    if (!clientId) {
      throw new CodedError(
        'BROWSER_NO_CAPABLE_CLIENT',
        'No connected desktop client supports browser tools for this session. ' +
        'Open this workspace from the Craft Agent desktop app and try again.',
      )
    }
    if (!this.rpcServer.hasClientCapability(clientId, CLIENT_BROWSER_INVOKE)) {
      throw new CodedError(
        'CAPABILITY_UNAVAILABLE',
        `Client ${clientId} does not advertise the ${CLIENT_BROWSER_INVOKE} capability.`,
      )
    }
    return await requestClientBrowserInvoke<T>(this.rpcServer, clientId, {
      v: 1,
      method,
      args,
      sessionId: this.sessionId,
      workspaceId: this.workspaceId,
    })
  }

  /** Dispatch a fire-and-forget call: cleanup paths must not block on the WS. */
  invokeSync(method: BrowserCapabilityMethod, args: unknown[]): void {
    this.invoke<unknown>(method, args).catch((err: unknown) => {
      remoteBpmLog.warn(
        `invokeSync(${method}) failed for session ${this.sessionId}: ${err instanceof Error ? err.message : String(err)}`,
      )
    })
  }

  fromScreenshotWire(wire: ScreenshotResultWire): BrowserScreenshotResult {
    const bytes: unknown = wire.imageBytes
    // Structured clone on the WS layer may deliver this as a Uint8Array or as
    // a serialized object with `data` field — accept both.
    let buffer: Buffer
    if (bytes instanceof Uint8Array) {
      buffer = Buffer.from(bytes.buffer, bytes.byteOffset, bytes.byteLength)
    } else if (bytes && typeof bytes === 'object' && 'data' in bytes) {
      const data = bytes.data as number[]
      buffer = Buffer.from(data)
    } else {
      const raw = bytes as ArrayBufferLike
      buffer = Buffer.from(raw)
    }
    return {
      imageBuffer: buffer,
      imageFormat: wire.imageFormat,
      metadata: wire.metadata,
    }
  }
}

/**
 * Build a remote `IBrowserPaneManager` for a single (sessionId, workspaceId).
 * Every method is generated on demand from the wire seam — see the class header.
 */
export function createRemoteBrowserPaneManager(deps: RemoteBrowserPaneManagerDeps): IBrowserPaneManager {
  const core = new RemoteBrowserPaneCore(deps)

  const overrides: Partial<IBrowserPaneManager> = {
    // Path resolution belongs to the server, not the client BPM.
    setSessionPathResolver: () => {},
    // Local-only gate: the desktop's evaluate() is authoritative for
    // allowRemoteEvaluate, so the remote pre-check is a no-op (see interface).
    assertEvaluateAllowed: () => {},
    uploadFile: async () => {
      throw new CodedError(
        'BROWSER_REMOTE_UPLOAD_NOT_SUPPORTED',
        'File upload from a remote agent is not supported. ' +
        'Ask the user to attach the file to the session instead.',
      )
    },
    screenshot: async (id: string, options?: BrowserScreenshotOptions) =>
      core.fromScreenshotWire(await core.invoke<ScreenshotResultWire>('screenshot', [id, options])),
    screenshotRegion: async (id: string, target: BrowserScreenshotRegionTarget) =>
      core.fromScreenshotWire(await core.invoke<ScreenshotResultWire>('screenshotRegion', [id, target])),
  }

  return new Proxy({} as IBrowserPaneManager, {
    get(target, prop): unknown {
      // Symbols + JS-internal keys: defer to the plain target so await / String /
      // JSON.stringify behave and never dispatch a WS call.
      if (typeof prop !== 'string' || Object.hasOwn(NON_METHOD_KEYS, prop)) return Reflect.get(target, prop)
      const override = overrides[prop as keyof IBrowserPaneManager]
      if (override) return override
      const method = prop as BrowserCapabilityMethod
      if (Object.hasOwn(FIRE_AND_FORGET, method)) {
        return (...args: unknown[]): void => core.invokeSync(method, args)
      }
      return (...args: unknown[]): Promise<unknown> => core.invoke(method, args)
    },
  })
}
