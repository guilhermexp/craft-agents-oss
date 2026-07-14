/**
 * Client capabilities — named actions a client can perform on behalf of the server.
 *
 * See docs/adr-transport-locality.md for the locality boundary definition.
 */

import type { BrowserCapabilityRequest } from './browser-capability'
import type { RpcServer } from './types'

/** Capability: open a URL in the client's default browser. */
export const CLIENT_OPEN_EXTERNAL = 'client:openExternal'

/** Capability: open a file with the OS default application. */
export const CLIENT_OPEN_PATH = 'client:openPath'

/** Capability: reveal a file in Finder / Explorer. */
export const CLIENT_SHOW_IN_FOLDER = 'client:showItemInFolder'

/** Capability: show a confirmation dialog (message box) on the client. */
export const CLIENT_CONFIRM_DIALOG = 'client:confirmDialog'

/** Capability: show a native file/folder picker on the client. */
export const CLIENT_OPEN_FILE_DIALOG = 'client:openFileDialog'

/** Capability: drive a local `BrowserPaneManager` instance for a remote agent. */
export const CLIENT_BROWSER_INVOKE = 'client:browser:invoke'

/** All capabilities a local Electron client advertises on handshake. */
export const LOCAL_CLIENT_CAPABILITIES: readonly string[] = [
  CLIENT_OPEN_EXTERNAL,
  CLIENT_OPEN_PATH,
  CLIENT_SHOW_IN_FOLDER,
  CLIENT_CONFIRM_DIALOG,
  CLIENT_OPEN_FILE_DIALOG,
  CLIENT_BROWSER_INVOKE,
]

// ---------------------------------------------------------------------------
// Helper wrappers — thin error-handling around server.invokeClient()
// ---------------------------------------------------------------------------

/**
 * Ask a specific client to open a URL in its default browser.
 *
 * Returns `{ opened: true }` on success.
 * Returns `{ opened: false, error, authUrl }` on failure — caller can
 * show authUrl to user for manual "copy link / open" action.
 */
export async function requestClientOpenExternal(
  server: RpcServer,
  clientId: string,
  url: string,
): Promise<{ opened: boolean; error?: string; authUrl?: string }> {
  try {
    await server.invokeClient(clientId, CLIENT_OPEN_EXTERNAL, url)
    return { opened: true }
  } catch (err) {
    const code = (err as any)?.code
    const message = err instanceof Error ? err.message : String(err)
    return { opened: false, error: `${code ?? 'UNKNOWN'}: ${message}`, authUrl: url }
  }
}

/**
 * Ask the client to open a file with the OS default application.
 * Equivalent to Electron's `shell.openPath()`.
 */
export async function requestClientOpenPath(
  server: RpcServer,
  clientId: string,
  path: string,
): Promise<{ error?: string }> {
  try {
    const result = await server.invokeClient(clientId, CLIENT_OPEN_PATH, path)
    return result ?? {}
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err)
    return { error: message }
  }
}

/**
 * Ask the client to reveal a file in Finder / Explorer.
 * Equivalent to Electron's `shell.showItemInFolder()`.
 */
export async function requestClientShowInFolder(
  server: RpcServer,
  clientId: string,
  path: string,
): Promise<void> {
  await server.invokeClient(clientId, CLIENT_SHOW_IN_FOLDER, path)
}

/** Spec for a confirmation dialog (maps to Electron's MessageBoxOptions). */
export interface ConfirmDialogSpec {
  type?: 'none' | 'info' | 'warning' | 'error' | 'question'
  title: string
  message: string
  detail?: string
  buttons: string[]
  defaultId?: number
  cancelId?: number
}

/**
 * Ask the client to show a confirmation dialog.
 * Returns the index of the clicked button.
 */
export async function requestClientConfirmDialog(
  server: RpcServer,
  clientId: string,
  spec: ConfirmDialogSpec,
): Promise<{ response: number }> {
  return await server.invokeClient(clientId, CLIENT_CONFIRM_DIALOG, spec)
}

/** Spec for a file/folder picker dialog (maps to Electron's OpenDialogOptions). */
export interface FileDialogSpec {
  title?: string
  defaultPath?: string
  properties?: string[]
  filters?: Array<{ name: string; extensions: string[] }>
}

/**
 * Ask the client to show a native file/folder picker.
 * Returns the selection result (canceled + filePaths).
 */
export async function requestClientOpenFileDialog(
  server: RpcServer,
  clientId: string,
  spec: FileDialogSpec,
): Promise<{ canceled: boolean; filePaths: string[] }> {
  return await server.invokeClient(clientId, CLIENT_OPEN_FILE_DIALOG, spec)
}

/** Default transport budget for browser invokes without an explicit action timeout. */
const BROWSER_INVOKE_BASE_TIMEOUT_MS = 30_000
/** Headroom over the action's own timeout so the client-side result wins the race. */
const BROWSER_INVOKE_TIMEOUT_MARGIN_MS = 5_000
/** Hard ceiling for the transport budget (runtime clamps action timeouts below this). */
const BROWSER_INVOKE_MAX_TIMEOUT_MS = 150_000

/**
 * Derive the transport budget from the action's own `timeoutMs` (carried inside
 * an options arg, e.g. clickElement/waitFor). The budget must exceed the action
 * timeout: if the transport gives up first, the action (already executed on the
 * desktop) gets replayed by the agent — double-submit.
 */
export function browserInvokeBudgetMs(req: BrowserCapabilityRequest): number {
  let requested = 0
  for (const arg of req.args) {
    if (arg && typeof arg === 'object' && typeof (arg as { timeoutMs?: unknown }).timeoutMs === 'number') {
      requested = Math.max(requested, (arg as { timeoutMs: number }).timeoutMs)
    }
  }
  if (requested <= 0) return BROWSER_INVOKE_BASE_TIMEOUT_MS
  return Math.min(
    Math.max(requested + BROWSER_INVOKE_TIMEOUT_MARGIN_MS, BROWSER_INVOKE_BASE_TIMEOUT_MS),
    BROWSER_INVOKE_MAX_TIMEOUT_MS,
  )
}

/**
 * Ask the client to invoke a `BrowserPaneManager` method.
 *
 * Errors propagate with `.code` preserved (see transport error-code preservation
 * in `client.ts` / `server.ts`). Callers can branch on `(err as any).code`.
 */
export async function requestClientBrowserInvoke<T>(
  server: RpcServer,
  clientId: string,
  req: BrowserCapabilityRequest,
): Promise<T> {
  const budgetMs = browserInvokeBudgetMs(req)
  try {
    const result = server.invokeClientWithTimeout
      ? server.invokeClientWithTimeout(clientId, CLIENT_BROWSER_INVOKE, budgetMs, req)
      : server.invokeClient(clientId, CLIENT_BROWSER_INVOKE, req)
    return await (result as Promise<T>)
  } catch (err) {
    if ((err as { code?: string })?.code === 'CLIENT_REQUEST_TIMEOUT' && err instanceof Error) {
      err.message += ' — the browser action may still have executed on the desktop; run browser_snapshot to check the page state before retrying.'
    }
    throw err
  }
}
