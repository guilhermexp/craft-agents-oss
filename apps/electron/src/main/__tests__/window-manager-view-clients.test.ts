/**
 * Embedded view clients in WindowManager.
 *
 * A renderer running as a WebContentsView inside another window (the session
 * panel embedded in a browser window) needs workspace resolution like any
 * renderer, but must never be mistaken for a window. These tests pin that
 * separation — the whole reason view clients live in their own map.
 */

import { describe, it, expect, mock } from 'bun:test'

mock.module('electron', () => ({
  app: { isReady: () => true, whenReady: async () => {}, on: mock(() => {}) },
  BrowserWindow: class {},
  ipcMain: { on: mock(() => {}), handle: mock(() => {}) },
  Menu: { buildFromTemplate: mock(() => ({ popup: mock(() => {}) })) },
  nativeTheme: { shouldUseDarkColors: false },
  screen: { getDisplayMatching: mock(() => ({ workArea: { x: 0, y: 0, width: 1440, height: 900 } })) },
  shell: { openExternal: mock(async () => {}) },
}))

mock.module('../logger', () => {
  const stub = { info: () => {}, error: () => {}, warn: () => {}, debug: () => {} }
  return { default: stub, mainLog: stub, windowLog: stub, sessionLog: stub, handlerLog: stub, agentLog: stub }
})

const { WindowManager } = await import('../window-manager')

describe('WindowManager embedded view clients', () => {
  it('resolves the workspace for a renderer that has no window of its own', () => {
    const wm = new WindowManager()
    wm.registerViewClient(1234, 'ws-abc')

    expect(wm.getWorkspaceForWindow(1234)).toBe('ws-abc')
  })

  it('keeps view clients out of the window lists and state persistence', () => {
    const wm = new WindowManager()
    wm.registerViewClient(1234, 'ws-abc')

    // The point of the separate map: no phantom windows.
    expect(wm.getAllWindows()).toHaveLength(0)
    expect(wm.getWindowStates()).toHaveLength(0)
    expect(wm.getWindowByWorkspace('ws-abc')).toBeNull()
    expect(wm.hasWindows()).toBe(false)
  })

  it('forgets a view client once unregistered', () => {
    const wm = new WindowManager()
    wm.registerViewClient(1234, 'ws-abc')
    wm.unregisterViewClient(1234)

    expect(wm.getWorkspaceForWindow(1234)).toBeNull()
  })
})
