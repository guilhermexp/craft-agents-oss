/**
 * BrowserToolbarHost
 *
 * Owns the browser instance's toolbar surface: loading the toolbar renderer
 * (with retry + data-URL fallback), pushing the toolbar state DTO, marking the
 * toolbar ready (which unblocks a deferred window show), and registering the
 * toolbar action IPC handlers. Extracted from BrowserPaneManager — the parent
 * retains instance lifecycle, navigation, layout, and profile management.
 *
 * Coupling to the parent is expressed through the injected ToolbarHostDeps
 * object rather than direct field access, so toolbar logic stays unit-testable.
 */

import { join } from 'path'
import { ipcMain } from 'electron'
import { mainLog } from '../logger'
import { TOOLBAR_CHANNELS } from '../../shared/browser-toolbar-channels'
import type { BrowserProfile } from '@craft-agent/shared/config/types'
import type { BrowserInstance } from '../browser-pane-manager'

const VITE_DEV_SERVER_URL = process.env.VITE_DEV_SERVER_URL
const TOOLBAR_LOAD_MAX_RETRIES = 4
const TOOLBAR_LOAD_RETRY_DELAY_MS = 500

/** Parent-provided dependencies the toolbar host needs. */
export interface ToolbarHostDeps {
  /** Look up an instance by id (no alive guard). */
  getInstance(id: string): BrowserInstance | undefined
  /** All configured browser profiles (for the toolbar profile switcher DTO). */
  listProfiles(): BrowserProfile[]
  /** Navigate the page view to a URL. */
  navigate(id: string, url: string): Promise<{ url: string; title: string }>
  /** History back. */
  goBack(id: string): Promise<void>
  /** History forward. */
  goForward(id: string): Promise<void>
  /** Reload the page. */
  reload(id: string): void
  /** Stop loading. */
  stop(id: string): void
  /** Hide the browser window. */
  hide(id: string): void
  /** Destroy the browser instance. */
  destroyInstance(id: string): void
  /** Collapse the toolbar overflow menu overlay. */
  forceCloseToolbarMenu(instance: BrowserInstance, reason: string): void
  /** Re-layout toolbar + page + overlay views. */
  layoutAllViews(instance: BrowserInstance): void
  /** Switch the instance to another profile (spawns a replacement window). */
  switchProfile(instanceId: string, targetProfileId: string): string | null
  /** Notify the app that profile management was requested for an instance. */
  requestProfileManagement(instanceId: string): void
  /** Notify listeners that an instance's state changed. */
  emitStateChange(instance: BrowserInstance): void
  /** Bounded sleep (used between toolbar load retries). */
  sleep(ms: number): Promise<void>
}

export class BrowserToolbarHost {
  constructor(private readonly deps: ToolbarHostDeps) {}

  async loadPage(instance: BrowserInstance): Promise<void> {
    const queryParams = new URLSearchParams({ instanceId: instance.id })
    if (instance.workspaceId) queryParams.set('workspaceId', instance.workspaceId)
    const query = queryParams.toString()
    let lastError: unknown = null

    for (let attempt = 0; attempt <= TOOLBAR_LOAD_MAX_RETRIES; attempt++) {
      try {
        if (VITE_DEV_SERVER_URL) {
          await instance.toolbarView.webContents.loadURL(`${VITE_DEV_SERVER_URL}/browser-toolbar.html?${query}`)
        } else {
          await instance.toolbarView.webContents.loadFile(
            join(__dirname, 'renderer/browser-toolbar.html'),
            { query: { instanceId: instance.id } },
          )
        }

        if (attempt > 0) {
          mainLog.info(`[browser-pane] toolbar load recovered id=${instance.id} attempt=${attempt + 1}`)
        }
        return
      } catch (error) {
        lastError = error
        const retrying = attempt < TOOLBAR_LOAD_MAX_RETRIES
        mainLog.warn(
          `[browser-pane] toolbar load failed id=${instance.id} attempt=${attempt + 1}/${TOOLBAR_LOAD_MAX_RETRIES + 1}: ${error instanceof Error ? error.message : String(error)}${retrying ? ' (retrying)' : ''}`,
        )

        if (retrying) {
          await this.deps.sleep(TOOLBAR_LOAD_RETRY_DELAY_MS)
        }
      }
    }

    const errorText = lastError instanceof Error ? lastError.message : String(lastError ?? 'unknown error')
    await this.loadFallback(instance, errorText)
  }

  private async loadFallback(instance: BrowserInstance, reason: string): Promise<void> {
    const safeReason = reason.replace(/[<>&]/g, (ch) => ({ '<': '&lt;', '>': '&gt;', '&': '&amp;' }[ch] || ch))
    const html = `<!doctype html>
<html>
  <head>
    <meta charset="UTF-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1" />
    <title>Browser Toolbar Error</title>
    <style>
      html, body { margin: 0; padding: 0; height: 100%; font-family: Inter, -apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif; background: #fafafb; color: #1f2937; }
      @media (prefers-color-scheme: dark) { html, body { background: #2b292e; color: #e5e7eb; } }
      .wrap { height: 100%; display: flex; align-items: center; justify-content: center; }
      .card { max-width: 640px; margin: 0 20px; padding: 14px 16px; border-radius: 10px; background: rgba(127,127,127,0.12); font-size: 12px; line-height: 1.45; }
      .title { font-weight: 600; margin-bottom: 6px; }
      .muted { opacity: 0.8; }
    </style>
  </head>
  <body>
    <div class="wrap">
      <div class="card">
        <div class="title">Browser toolbar failed to load</div>
        <div class="muted">The page area still works, but toolbar UI is unavailable. Try reopening the browser window.</div>
        <div class="muted" style="margin-top: 8px; word-break: break-word;">Reason: ${safeReason}</div>
      </div>
    </div>
  </body>
</html>`

    try {
      await instance.toolbarView.webContents.loadURL(`data:text/html;charset=UTF-8,${encodeURIComponent(html)}`)
      mainLog.warn(`[browser-pane] Loaded toolbar fallback id=${instance.id}`)
    } catch (error) {
      mainLog.error(`[browser-pane] Failed to load toolbar fallback id=${instance.id}: ${error instanceof Error ? error.message : String(error)}`)
    }
  }

  pushState(instance: BrowserInstance): void {
    if (instance.window.isDestroyed() || instance.toolbarView.webContents.isDestroyed()) return
    const allProfiles = this.deps.listProfiles()
    const profile = allProfiles.find(p => p.id === instance.profileId) ?? null
    const state = {
      url: instance.currentUrl,
      title: instance.title,
      isLoading: instance.isLoading,
      canGoBack: instance.canGoBack,
      canGoForward: instance.canGoForward,
      themeColor: instance.themeColor,
      profile: profile ? {
        id: profile.id,
        name: profile.name,
        color: profile.color,
        kind: profile.kind,
        clientName: profile.clientName,
      } : null,
      availableProfiles: allProfiles.map(p => ({
        id: p.id,
        name: p.name,
        color: p.color,
        kind: p.kind,
        clientName: p.clientName,
      })),
    }
    try {
      instance.toolbarView.webContents.send(TOOLBAR_CHANNELS.STATE_UPDATE, state)
    } catch (error) {
      mainLog.warn(`[browser-pane] toolbar state send skipped id=${instance.id}: ${error instanceof Error ? error.message : String(error)}`)
    }
  }

  markReady(instance: BrowserInstance, reason: string): void {
    if (instance.toolbarReady || instance.window.isDestroyed()) return

    instance.toolbarReady = true
    mainLog.info(`[browser-pane] toolbar ready id=${instance.id} reason=${reason}`)

    const shouldShowNow = instance.showOnCreate || instance.pendingShowOnReady
    if (!shouldShowNow) return

    const tokenAtReady = instance.pendingShowToken
    instance.pendingShowOnReady = false

    if (instance.window.isDestroyed()) return
    if (instance.pendingShowToken !== tokenAtReady) return

    instance.window.show()
    instance.window.focus()
    instance.isVisible = true
    this.deps.emitStateChange(instance)
  }

  /** Register IPC handlers for toolbar actions. Call once at app startup. */
  registerIpc(): void {
    ipcMain.handle(TOOLBAR_CHANNELS.NAVIGATE, async (_event, instanceId: string, url: string) => {
      const inst = this.deps.getInstance(instanceId)
      if (inst) await this.deps.navigate(inst.id, url)
    })

    ipcMain.handle(TOOLBAR_CHANNELS.GO_BACK, async (_event, instanceId: string) => {
      const inst = this.deps.getInstance(instanceId)
      if (inst) await this.deps.goBack(inst.id)
    })

    ipcMain.handle(TOOLBAR_CHANNELS.GO_FORWARD, async (_event, instanceId: string) => {
      const inst = this.deps.getInstance(instanceId)
      if (inst) await this.deps.goForward(inst.id)
    })

    ipcMain.handle(TOOLBAR_CHANNELS.RELOAD, async (_event, instanceId: string) => {
      const inst = this.deps.getInstance(instanceId)
      if (inst) this.deps.reload(inst.id)
    })

    ipcMain.handle(TOOLBAR_CHANNELS.STOP, async (_event, instanceId: string) => {
      const inst = this.deps.getInstance(instanceId)
      if (inst) this.deps.stop(inst.id)
    })

    ipcMain.handle(TOOLBAR_CHANNELS.MENU_GEOMETRY, async (_event, instanceId: string, open: boolean, height?: number) => {
      const inst = this.deps.getInstance(instanceId)
      if (!inst) return

      const normalizedOpen = !!open
      const normalizedHeight = Math.max(0, Math.ceil(Number(height ?? 0)))

      if (!normalizedOpen) {
        this.deps.forceCloseToolbarMenu(inst, 'renderer-close')
        return
      }

      const changed = !inst.toolbarMenuOpen
        || inst.toolbarMenuHeight !== normalizedHeight
        || !inst.toolbarMenuOverlayActive

      if (!changed) return

      inst.toolbarMenuOpen = true
      inst.toolbarMenuHeight = normalizedHeight
      inst.toolbarMenuOverlayActive = true
      this.deps.layoutAllViews(inst)
    })

    ipcMain.handle(TOOLBAR_CHANNELS.HIDE, async (_event, instanceId: string) => {
      const inst = this.deps.getInstance(instanceId)
      mainLog.info(`[browser-pane] toolbar ipc hide requested instanceId=${instanceId} resolved=${inst?.id ?? 'none'}`)
      if (inst) this.deps.hide(inst.id)
    })

    ipcMain.handle(TOOLBAR_CHANNELS.DESTROY, async (_event, instanceId: string) => {
      const inst = this.deps.getInstance(instanceId)
      mainLog.info(`[browser-pane] toolbar ipc destroy requested instanceId=${instanceId} resolved=${inst?.id ?? 'none'}`)
      if (inst) this.deps.destroyInstance(inst.id)
    })

    ipcMain.handle(TOOLBAR_CHANNELS.REQUEST_PROFILE_MANAGEMENT, async (_event, instanceId: string) => {
      const inst = this.deps.getInstance(instanceId)
      mainLog.info(`[browser-pane] toolbar ipc requestProfileManagement instanceId=${instanceId} resolved=${inst?.id ?? 'none'}`)
      this.deps.requestProfileManagement(inst?.id ?? instanceId)
    })

    ipcMain.handle(TOOLBAR_CHANNELS.SWITCH_PROFILE, async (_event, instanceId: string, profileId: string) => {
      const inst = this.deps.getInstance(instanceId)
      if (!inst) return null
      return this.deps.switchProfile(inst.id, profileId)
    })

    mainLog.info('[browser-pane] Toolbar IPC handlers registered')
  }
}
