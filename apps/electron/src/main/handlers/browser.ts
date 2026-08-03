import { RPC_NAMESPACES, type BrowserPaneCreateOptions, type BrowserEmptyStateLaunchPayload } from '../../shared/types'
import type { BrowserProfileInput } from '@craft-agent/shared/config/browser-profiles'
import type { BrowserScreenshotOptions } from '../browser-pane-manager'
import { pushTyped, type RpcServer } from '@craft-agent/server-core/transport'
import type { HandlerDeps } from './handler-deps'

export function registerBrowserHandlers(server: RpcServer, deps: HandlerDeps): void {
  const { browserPaneManager, windowManager, platform } = deps
  if (!browserPaneManager) return

  const resolveContextWorkspaceId = (ctx: { workspaceId?: string | null; webContentsId?: number | null }): string | null | undefined => {
    return ctx.workspaceId
      ?? (typeof ctx.webContentsId === 'number' ? windowManager?.getWorkspaceForWindow(ctx.webContentsId) : undefined)
  }

  server.handle(RPC_NAMESPACES.browserPane.CREATE, (ctx, input?: string | BrowserPaneCreateOptions) => {
    const workspaceId = resolveContextWorkspaceId(ctx)
    if (typeof input === 'string') {
      return browserPaneManager.createInstance(input, { workspaceId })
    }

    if (input?.bindToSessionId) {
      return browserPaneManager.createForSession(input.bindToSessionId, {
        show: input.show ?? false,
        profileId: input.profileId,
      })
    }

    return browserPaneManager.createInstance(input?.id, {
      show: input?.show,
      url: input?.url,
      profileId: input?.profileId,
      workspaceId,
    })
  })

  server.handle(RPC_NAMESPACES.browserPane.DESTROY, (_ctx, id: string) => {
    browserPaneManager.destroyInstance(id)
  })

  // Display mode moves native views between windows, so it only exists on the
  // desktop manager. The host is whichever window asked — correct for
  // multi-window Craft, and avoids coupling the pane manager to WindowManager.
  server.handle(RPC_NAMESPACES.browserPane.SET_DISPLAY_MODE, (ctx, id: string, mode: 'floating' | 'integrated') => {
    const manager = browserPaneManager as Partial<{
      setDisplayMode(id: string, mode: 'floating' | 'integrated', host?: unknown): boolean
    }>
    if (typeof manager.setDisplayMode !== 'function') return false

    const host = mode === 'integrated'
      ? windowManager?.getWindowByWebContentsId(ctx.webContentsId!) ?? null
      : null
    return manager.setDisplayMode(id, mode, host)
  })

  server.handle(
    RPC_NAMESPACES.browserPane.SET_EMBEDDED_BOUNDS,
    (
      ctx,
      id: string,
      rect: { x: number; y: number; width: number; height: number },
    ) => {
      // The renderer measures in its own CSS px. Resolve the zoom factor here
      // from the requesting window rather than trusting the renderer to report
      // it — the main process is the only side that knows the real value.
      const hostWindow = windowManager?.getWindowByWebContentsId(ctx.webContentsId!)
      const zoomFactor = hostWindow && !hostWindow.isDestroyed()
        ? hostWindow.webContents.getZoomFactor()
        : 1

      const manager = browserPaneManager as Partial<{
        setEmbeddedBounds(
          id: string,
          rect: { x: number; y: number; width: number; height: number },
          zoomFactor?: number,
        ): boolean
      }>
      if (typeof manager.setEmbeddedBounds !== 'function') return false
      return manager.setEmbeddedBounds(id, rect, zoomFactor)
    },
  )

  server.handle(
    RPC_NAMESPACES.browserPane.SET_VIEWS_VISIBLE,
    (_ctx, id: string, visible: boolean) => {
      const manager = browserPaneManager as Partial<{
        setViewsVisible(id: string, visible: boolean): boolean
      }>
      if (typeof manager.setViewsVisible !== 'function') return false
      return manager.setViewsVisible(id, visible)
    },
  )

  server.handle(RPC_NAMESPACES.browserPane.LIST, () => {
    return browserPaneManager.listInstances()
  })

  server.handle(RPC_NAMESPACES.browserPane.NAVIGATE, async (_ctx, id: string, url: string) => {
    try {
      return await browserPaneManager.navigate(id, url)
    } catch (err) {
      platform.logger.error(`[browser-pane] navigate failed for ${id}:`, err)
      throw err
    }
  })

  server.handle(RPC_NAMESPACES.browserPane.GO_BACK, async (_ctx, id: string) => {
    try {
      return await browserPaneManager.goBack(id)
    } catch (err) {
      platform.logger.error(`[browser-pane] goBack failed for ${id}:`, err)
      throw err
    }
  })

  server.handle(RPC_NAMESPACES.browserPane.GO_FORWARD, async (_ctx, id: string) => {
    try {
      return await browserPaneManager.goForward(id)
    } catch (err) {
      platform.logger.error(`[browser-pane] goForward failed for ${id}:`, err)
      throw err
    }
  })

  server.handle(RPC_NAMESPACES.browserPane.RELOAD, (_ctx, id: string) => {
    browserPaneManager.reload(id)
  })

  server.handle(RPC_NAMESPACES.browserPane.STOP, (_ctx, id: string) => {
    browserPaneManager.stop(id)
  })

  server.handle(RPC_NAMESPACES.browserPane.FOCUS, (_ctx, id: string) => {
    browserPaneManager.focus(id)
  })

  server.handle(RPC_NAMESPACES.browserPane.LAUNCH, async (ctx, payload: BrowserEmptyStateLaunchPayload) => {
    try {
      return await browserPaneManager.handleEmptyStateLaunchFromRenderer(ctx.webContentsId!, payload)
    } catch (err) {
      platform.logger.error('[browser-pane] empty-state launch IPC failed:', err)
      throw err
    }
  })

  server.handle(RPC_NAMESPACES.browserPane.SNAPSHOT, async (_ctx, id: string) => {
    try {
      return await browserPaneManager.getAccessibilitySnapshot(id)
    } catch (err) {
      platform.logger.error(`[browser-pane] snapshot failed for ${id}:`, err)
      throw err
    }
  })

  server.handle(RPC_NAMESPACES.browserPane.CLICK, async (_ctx, id: string, ref: string) => {
    try {
      return await browserPaneManager.clickElement(id, ref)
    } catch (err) {
      platform.logger.error(`[browser-pane] click failed for ${id} ref=${ref}:`, err)
      throw err
    }
  })

  server.handle(RPC_NAMESPACES.browserPane.FILL, async (_ctx, id: string, ref: string, value: string) => {
    try {
      return await browserPaneManager.fillElement(id, ref, value)
    } catch (err) {
      platform.logger.error(`[browser-pane] fill failed for ${id} ref=${ref}:`, err)
      throw err
    }
  })

  server.handle(RPC_NAMESPACES.browserPane.SELECT, async (_ctx, id: string, ref: string, value: string) => {
    try {
      return await browserPaneManager.selectOption(id, ref, value)
    } catch (err) {
      platform.logger.error(`[browser-pane] select failed for ${id} ref=${ref}:`, err)
      throw err
    }
  })

  server.handle(RPC_NAMESPACES.browserPane.SCREENSHOT, async (_ctx, id: string, options?: BrowserScreenshotOptions) => {
    try {
      const result = await browserPaneManager.screenshot(id, options)
      return {
        base64: result.imageBuffer.toString('base64'),
        imageFormat: result.imageFormat,
        metadata: result.metadata,
      }
    } catch (err) {
      platform.logger.error(`[browser-pane] screenshot failed for ${id}:`, err)
      throw err
    }
  })

  server.handle(RPC_NAMESPACES.browserPane.EVALUATE, async (_ctx, id: string, expression: string) => {
    try {
      return await browserPaneManager.evaluate(id, expression)
    } catch (err) {
      platform.logger.error(`[browser-pane] evaluate failed for ${id}:`, err)
      throw err
    }
  })

  server.handle(RPC_NAMESPACES.browserPane.SCROLL, async (_ctx, id: string, direction: string, amount?: number) => {
    const validDirections = ['up', 'down', 'left', 'right']
    if (!validDirections.includes(direction)) {
      throw new Error(`Invalid scroll direction: ${direction}`)
    }
    try {
      return await browserPaneManager.scroll(id, direction as 'up' | 'down' | 'left' | 'right', amount)
    } catch (err) {
      platform.logger.error(`[browser-pane] scroll failed for ${id}:`, err)
      throw err
    }
  })

  // -- Profiles ------------------------------------------------------------

  server.handle(RPC_NAMESPACES.browserPane.LIST_PROFILES, () => {
    return browserPaneManager.listProfiles()
  })

  server.handle(RPC_NAMESPACES.browserPane.GET_PROFILE_SETTINGS, () => {
    return browserPaneManager.getProfileSettings()
  })

  server.handle(
    RPC_NAMESPACES.browserPane.SET_PROFILE_SETTINGS,
    (_ctx, partial: { alwaysAsk?: boolean; lastUsedProfileId?: string }) => {
      return browserPaneManager.setProfileSettings(partial ?? {})
    },
  )

  server.handle(
    RPC_NAMESPACES.browserPane.CREATE_PROFILE,
    (_ctx, input: BrowserProfileInput) => {
      try {
        return browserPaneManager.createProfile(input)
      } catch (err) {
        platform.logger.error('[browser-pane] createProfile failed:', err)
        throw err
      }
    },
  )

  server.handle(
    RPC_NAMESPACES.browserPane.RENAME_PROFILE,
    (_ctx, payload: { id: string; name: string }) => {
      try {
        return browserPaneManager.renameProfile(payload.id, payload.name)
      } catch (err) {
        platform.logger.error('[browser-pane] renameProfile failed:', err)
        throw err
      }
    },
  )

  server.handle(
    RPC_NAMESPACES.browserPane.SWITCH_PROFILE,
    (_ctx, payload: { instanceId: string; profileId: string }) => {
      try {
        return browserPaneManager.switchProfile(payload.instanceId, payload.profileId)
      } catch (err) {
        platform.logger.error('[browser-pane] switchProfile failed:', err)
        throw err
      }
    },
  )

  server.handle(RPC_NAMESPACES.browserPane.DELETE_PROFILE, async (_ctx, id: string) => {
    try {
      await browserPaneManager.deleteProfile(id)
    } catch (err) {
      platform.logger.error(`[browser-pane] deleteProfile failed for ${id}:`, err)
      throw err
    }
  })

  // Forward browser state changes to all windows
  browserPaneManager.onStateChange((info) => {
    pushTyped(server, RPC_NAMESPACES.browserPane.STATE_CHANGED, { to: 'all' }, info)
  })

  // Forward browser removals so renderer can immediately drop stale tabs
  browserPaneManager.onRemoved((id) => {
    pushTyped(server, RPC_NAMESPACES.browserPane.REMOVED, { to: 'all' }, id)
  })

  // Forward browser interaction/focus events so renderer can align panel focus.
  browserPaneManager.onInteracted((id) => {
    pushTyped(server, RPC_NAMESPACES.browserPane.INTERACTED, { to: 'all' }, id)
  })

  // Forward browser profile list/settings changes
  browserPaneManager.onProfilesChanged((settings) => {
    pushTyped(server, RPC_NAMESPACES.browserPane.PROFILES_CHANGED, { to: 'all' }, settings)
  })

  // Forward "manage profiles" requests from inside a browser window so the
  // main app can open the picker UI. Also focus the main app window so the
  // modal lands on top of any open BrowserWindow previews.
  browserPaneManager.onProfileManagementRequested((instanceId) => {
    try {
      const managedWindows = windowManager?.getAllWindows() ?? []
      const main = managedWindows[0]?.window
      if (main && !main.isDestroyed()) {
        if (main.isMinimized()) main.restore()
        main.show()
        main.focus()
      }
    } catch (err) {
      platform.logger.warn('[browser-pane] failed to focus main window for picker:', err)
    }
    pushTyped(server, RPC_NAMESPACES.browserPane.PICKER_REQUESTED, { to: 'all' }, { instanceId })
  })

  // Forward dock/undock requests from inside a browser window. The app renderer
  // owns the card that gives integrated views their rect, so only it can finish
  // the switch. Docking also needs the app window in front — otherwise the card
  // mounts behind whatever the user is looking at and the browser looks gone.
  browserPaneManager.onDisplayModeRequested((instanceId, mode) => {
    if (mode === 'integrated') {
      try {
        const main = (windowManager?.getAllWindows() ?? [])[0]?.window
        if (main && !main.isDestroyed()) {
          if (main.isMinimized()) main.restore()
          main.show()
          main.focus()
        }
      } catch (err) {
        platform.logger.warn('[browser-pane] failed to focus main window for dock:', err)
      }
    }
    pushTyped(server, RPC_NAMESPACES.browserPane.DISPLAY_MODE_REQUESTED, { to: 'all' }, { instanceId, mode })
  })
}
