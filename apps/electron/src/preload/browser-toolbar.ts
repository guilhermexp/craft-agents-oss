/**
 * Preload script for browser toolbar windows.
 *
 * Exposes a minimal API for the React BrowserControls component
 * to send navigation actions and receive state updates from the
 * main process BrowserPaneManager.
 */

import { contextBridge, ipcRenderer } from 'electron'

const CHANNELS = {
  NAVIGATE: 'browser-toolbar:navigate',
  GO_BACK: 'browser-toolbar:go-back',
  GO_FORWARD: 'browser-toolbar:go-forward',
  RELOAD: 'browser-toolbar:reload',
  STOP: 'browser-toolbar:stop',
  MENU_GEOMETRY: 'browser-toolbar:menu-geometry',
  FORCE_CLOSE_MENU: 'browser-toolbar:force-close-menu',
  HIDE: 'browser-toolbar:hide',
  DESTROY: 'browser-toolbar:destroy',
  STATE_UPDATE: 'browser-toolbar:state-update',
  THEME_COLOR: 'browser-toolbar:theme-color',
  REQUEST_PROFILE_MANAGEMENT: 'browser-toolbar:request-profile-management',
  SWITCH_PROFILE: 'browser-toolbar:switch-profile',
  MEETINGS_RESOLVE_WORKSPACE: 'meetings:resolve-workspace',
  MEETINGS_START: 'meetings:start',
  RECORDING_PREPARE: 'meetings:recording:prepare',
  RECORDING_APPEND: 'meetings:recording:append',
  RECORDING_FINALIZE: 'meetings:recording:finalize',
  RECORDING_ABORT: 'meetings:recording:abort',
} as const

// Instance/workspace IDs are passed via query parameters by BrowserPaneManager.
// Older toolbar windows may not have workspaceId in the URL, so keep a
// best-effort sync IPC fallback before invoking workspace-scoped handlers.
const toolbarParams = new URLSearchParams(location.search)
const instanceId = toolbarParams.get('instanceId') || ''
const workspaceId = toolbarParams.get('workspaceId') || safeSendSyncString('__get-workspace-id')

function safeSendSyncString(channel: string): string {
  try {
    const value = ipcRenderer.sendSync(channel)
    return typeof value === 'string' ? value : ''
  } catch {
    return ''
  }
}

contextBridge.exposeInMainWorld('browserToolbar', {
  instanceId,
  navigate: (url: string) => ipcRenderer.invoke(CHANNELS.NAVIGATE, instanceId, url),
  goBack: () => ipcRenderer.invoke(CHANNELS.GO_BACK, instanceId),
  goForward: () => ipcRenderer.invoke(CHANNELS.GO_FORWARD, instanceId),
  reload: () => ipcRenderer.invoke(CHANNELS.RELOAD, instanceId),
  stop: () => ipcRenderer.invoke(CHANNELS.STOP, instanceId),
  setMenuGeometry: (open: boolean, height = 0) => ipcRenderer.invoke(CHANNELS.MENU_GEOMETRY, instanceId, open, height),
  hideWindow: () => ipcRenderer.invoke(CHANNELS.HIDE, instanceId),
  closeWindowEntirely: () => ipcRenderer.invoke(CHANNELS.DESTROY, instanceId),
  requestProfileManagement: () => ipcRenderer.invoke(CHANNELS.REQUEST_PROFILE_MANAGEMENT, instanceId),
  switchProfile: (profileId: string) => ipcRenderer.invoke(CHANNELS.SWITCH_PROFILE, instanceId, profileId),
  inviteHermesToMeet: async (payload: { urlOrCode: string; profileId?: string; workspaceId?: string }) => {
    const resolvedWorkspaceId = (payload.workspaceId || workspaceId).trim()
      || await ipcRenderer.invoke(CHANNELS.MEETINGS_RESOLVE_WORKSPACE, instanceId)
    const startPayload = {
      urlOrCode: payload.urlOrCode,
      profileId: payload.profileId,
      browserInstanceId: instanceId,
      title: 'Google Meet',
      transcribe: true,
      summarizeOnEnd: true,
      followUpOnEnd: false,
    }
    return ipcRenderer.invoke(CHANNELS.MEETINGS_START, resolvedWorkspaceId, startPayload)
  },
  onStateUpdate: (callback: (state: unknown) => void) => {
    const handler = (_event: Electron.IpcRendererEvent, state: unknown) => callback(state)
    ipcRenderer.on(CHANNELS.STATE_UPDATE, handler)
    return () => { ipcRenderer.removeListener(CHANNELS.STATE_UPDATE, handler) }
  },
  onThemeColor: (callback: (color: string | null) => void) => {
    const handler = (_event: Electron.IpcRendererEvent, color: string | null) => callback(color)
    ipcRenderer.on(CHANNELS.THEME_COLOR, handler)
    return () => { ipcRenderer.removeListener(CHANNELS.THEME_COLOR, handler) }
  },
  onForceCloseMenu: (callback: (payload: { reason?: string }) => void) => {
    const handler = (_event: Electron.IpcRendererEvent, payload: { reason?: string }) => callback(payload)
    ipcRenderer.on(CHANNELS.FORCE_CLOSE_MENU, handler)
    return () => { ipcRenderer.removeListener(CHANNELS.FORCE_CLOSE_MENU, handler) }
  },
  /**
   * Audio recording lifecycle for the browser pane.
   * The toolbar renderer records via getDisplayMedia; the main process display
   * media handler grants the active Meet BrowserView frame.
   */
  prepareRecording: async (payload: { urlOrCode: string; workspaceId?: string }) => {
    const resolvedWorkspaceId = (payload.workspaceId || workspaceId).trim()
      || await ipcRenderer.invoke(CHANNELS.MEETINGS_RESOLVE_WORKSPACE, instanceId)
    return ipcRenderer.invoke(CHANNELS.RECORDING_PREPARE, {
      workspaceId: resolvedWorkspaceId,
      browserInstanceId: instanceId,
      urlOrCode: payload.urlOrCode,
    }) as Promise<{ recordingId: string; meetingId?: string; outputPath: string }>
  },
  appendRecordingChunk: (recordingId: string, chunk: ArrayBuffer) =>
    ipcRenderer.invoke(CHANNELS.RECORDING_APPEND, recordingId, chunk),
  finalizeRecording: (recordingId: string, mimeType: string) =>
    ipcRenderer.invoke(CHANNELS.RECORDING_FINALIZE, recordingId, mimeType) as Promise<{ outputPath: string }>,
  abortRecording: (recordingId: string) =>
    ipcRenderer.invoke(CHANNELS.RECORDING_ABORT, recordingId),
})
