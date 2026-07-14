/**
 * Host runtime context for backends spawned outside SessionManager (meeting
 * summary / video analysis). Mirrors createElectronPlatform() so packaged
 * builds resolve the native runtime from the app bundle instead of falling
 * back to cwd=/ with isPackaged:false.
 */
// Namespace import on purpose: outside Electron (bun test) the electron
// module resolves to a path string with no `app`/`default` named export,
// which would make named or default imports a load-time SyntaxError.
import * as electron from 'electron'
import type { App } from 'electron'
import type { BackendHostRuntimeContext } from '@craft-agent/shared/agent/backend'

export function buildMeetingBackendHostRuntime(): BackendHostRuntimeContext {
  const app = (electron as { app?: App }).app
  if (!app) {
    // Outside Electron (bun test) — dev-style context.
    return { appRootPath: process.cwd(), isPackaged: false }
  }
  return {
    appRootPath: app.isPackaged ? app.getAppPath() : process.cwd(),
    resourcesPath: process.resourcesPath,
    isPackaged: app.isPackaged,
  }
}
