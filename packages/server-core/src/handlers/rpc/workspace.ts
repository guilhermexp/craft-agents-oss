import { existsSync } from 'node:fs'
import { join } from 'path'
import { homedir } from 'os'
import { RPC_NAMESPACES } from '@craft-agent/shared/protocol'
import { getWorkspaces, getWorkspaceByNameOrId, addWorkspace, setActiveWorkspace, updateWorkspaceRemoteServer, getDefaultWorkspaceId, setDefaultWorkspace } from '@craft-agent/shared/config'
import { perf } from '@craft-agent/shared/utils'
import { pushTyped, type RpcServer } from '@craft-agent/server-core/transport'
import type { HandlerDeps } from '../handler-deps'
import { isValidWorkspaceRootPath } from '../../utils/path-validation'

export function registerWorkspaceCoreHandlers(server: RpcServer, deps: HandlerDeps): void {
  const { sessionManager } = deps
  const windowManager = deps.windowManager

  // Get workspaces (LOCAL_ONLY — includes rootPath for local Electron renderer)
  server.handle(RPC_NAMESPACES.workspaces.GET, async () => {
    return sessionManager.getWorkspaces()
  })

  // Create a new workspace at a folder path (Obsidian-style: folder IS the workspace)
  server.handle(RPC_NAMESPACES.workspaces.CREATE, async (_ctx, folderPath: string, name: string, remoteServer?: { url: string; token: string; remoteWorkspaceId: string }) => {
    const rootPath = folderPath.trim()
    const validation = isValidWorkspaceRootPath(rootPath)
    if (!validation.valid) {
      throw new Error(validation.reason!)
    }

    const existingWorkspace = getWorkspaces().find(w => w.rootPath === rootPath)
    const workspace = addWorkspace({ name, rootPath, ...(remoteServer && { remoteServer }) })
    // Make it active
    setActiveWorkspace(workspace.id)
    if (existingWorkspace) {
      deps.platform.logger.info(`Opened existing workspace "${workspace.name}" at ${rootPath}${remoteServer ? ` (remote: ${remoteServer.url})` : ''}`)
    } else {
      deps.platform.logger.info(`Created workspace "${name}" at ${rootPath}${remoteServer ? ` (remote: ${remoteServer.url})` : ''}`)
    }
    return workspace
  })

  // Check if a workspace slug already exists (for validation before creation)
  server.handle(RPC_NAMESPACES.workspaces.CHECK_SLUG, async (_ctx, slug: string) => {
    const defaultWorkspacesDir = join(homedir(), '.craft-agent', 'workspaces')
    const workspacePath = join(defaultWorkspacesDir, slug)
    const exists = existsSync(workspacePath)
    return { exists, path: workspacePath }
  })

  // Update remote server config for an existing workspace (reconnect flow)
  server.handle(RPC_NAMESPACES.workspaces.UPDATE_REMOTE, async (_ctx, workspaceId: string, remoteServer: { url: string; token: string; remoteWorkspaceId: string }) => {
    updateWorkspaceRemoteServer(workspaceId, remoteServer)
    deps.platform.logger.info(`Updated remote server for workspace ${workspaceId}: ${remoteServer.url}`)
    return { success: true }
  })

  // Return the workspace pinned as default-on-launch, or null when none.
  server.handle(RPC_NAMESPACES.workspaces.GET_DEFAULT, async () => {
    return getDefaultWorkspaceId()
  })

  // Pin/unpin a workspace as default-on-launch.
  server.handle(RPC_NAMESPACES.workspaces.SET_DEFAULT, async (_ctx, workspaceId: string | null) => {
    setDefaultWorkspace(workspaceId)
    deps.platform.logger.info(`Default workspace ${workspaceId ? `set to ${workspaceId}` : 'cleared'}`)
    return { success: true }
  })

  // Get workspace ID for the calling window
  server.handle(RPC_NAMESPACES.window.GET_WORKSPACE, (ctx) => {
    const workspaceId = ctx.workspaceId ?? windowManager?.getWorkspaceForWindow(ctx.webContentsId!)
    // Set up ConfigWatcher for live updates (labels, statuses, sources, themes)
    if (workspaceId) {
      const workspace = getWorkspaceByNameOrId(workspaceId)
      if (workspace) {
        sessionManager.setupConfigWatcher(workspace.rootPath, workspaceId)
      }
    }
    return workspaceId
  })

  // Get mode for the calling window (always 'main' now)
  server.handle(RPC_NAMESPACES.window.GET_MODE, () => {
    return 'main'
  })

  // Switch workspace in current window (in-window switching)
  server.handle(RPC_NAMESPACES.window.SWITCH_WORKSPACE, async (ctx, workspaceId: string) => {
    const end = perf.start('ipc.switchWorkspace', { workspaceId })

    // Keep WS push routing in sync (works for both GUI and headless)
    server.updateClientWorkspace?.(ctx.clientId, workspaceId)

    if (windowManager) {
      const wcId = ctx.webContentsId!

      // Get the old workspace ID before updating
      const oldWorkspaceId = windowManager.getWorkspaceForWindow(wcId)

      // Update the window's workspace mapping
      const updated = windowManager.updateWindowWorkspace(wcId, workspaceId)

      // If update failed, the window may have been re-created (e.g., after refresh)
      // Try to register it
      if (!updated) {
        const win = windowManager.getWindowByWebContentsId(wcId)
        if (win) {
          windowManager.registerWindow(win, workspaceId)
          deps.platform.logger.info(`Re-registered window ${wcId} for workspace ${workspaceId}`)
        }
      }

      // Clear activeViewingSession for old workspace if no other windows are viewing it
      // This ensures read/unread state is correct after workspace switch
      if (oldWorkspaceId && oldWorkspaceId !== workspaceId) {
        const otherWindows = windowManager.getAllWindowsForWorkspace(oldWorkspaceId)
        if (otherWindows.length === 0) {
          sessionManager.clearActiveViewingSession(oldWorkspaceId)
        }
      }
    }

    // Set up ConfigWatcher for the new workspace
    const workspace = getWorkspaceByNameOrId(workspaceId)
    if (workspace) {
      sessionManager.setupConfigWatcher(workspace.rootPath, workspaceId)
    }
    end()

    // Return connection details so the preload RoutedClient can decide
    // whether to connect directly to a remote server for this workspace.
    return {
      workspaceId,
      remoteServer: workspace?.remoteServer ?? null,
    }
  })

  // ============================================================
  // Workspace Image Read/Write
  // ============================================================

  // Generic workspace image loading (for source icons, status icons, etc.)
  server.handle(RPC_NAMESPACES.workspace.READ_IMAGE, async (_ctx, workspaceId: string, relativePath: string) => {
    const workspace = getWorkspaceByNameOrId(workspaceId)
    if (!workspace) throw new Error('Workspace not found')

    const [{ readFileSync, existsSync }, { join, normalize }] = await Promise.all([
      import('fs'),
      import('path'),
    ])

    // Security: validate path
    // - Must not contain .. (path traversal)
    // - Must be a valid image extension
    const ALLOWED_EXTENSIONS = ['.svg', '.png', '.jpg', '.jpeg', '.webp', '.ico', '.gif']

    if (relativePath.includes('..')) {
      throw new Error('Invalid path: directory traversal not allowed')
    }

    const ext = relativePath.toLowerCase().slice(relativePath.lastIndexOf('.'))
    if (!ALLOWED_EXTENSIONS.includes(ext)) {
      throw new Error(`Invalid file type: ${ext}. Allowed: ${ALLOWED_EXTENSIONS.join(', ')}`)
    }

    // Resolve path relative to workspace root
    const absolutePath = normalize(join(workspace.rootPath, relativePath))

    // Double-check the resolved path is still within workspace
    if (!absolutePath.startsWith(workspace.rootPath)) {
      throw new Error('Invalid path: outside workspace directory')
    }

    if (!existsSync(absolutePath)) {
      return null  // Missing optional files - silent fallback to default icons
    }

    // Read file as buffer
    const buffer = readFileSync(absolutePath)

    // If SVG, return as UTF-8 string (caller will use as innerHTML)
    if (ext === '.svg') {
      return buffer.toString('utf-8')
    }

    // For binary images, return as data URL
    const mimeTypes: Record<string, string> = {
      '.png': 'image/png',
      '.jpg': 'image/jpeg',
      '.jpeg': 'image/jpeg',
      '.webp': 'image/webp',
      '.ico': 'image/x-icon',
      '.gif': 'image/gif',
    }
    const mimeType = mimeTypes[ext] || 'image/png'
    return `data:${mimeType};base64,${buffer.toString('base64')}`
  })

  // Generic workspace image writing (for workspace icon, etc.)
  // Resizes images to max 256x256 to keep file sizes small
  server.handle(RPC_NAMESPACES.workspace.WRITE_IMAGE, async (_ctx, workspaceId: string, relativePath: string, base64: string, mimeType: string) => {
    const workspace = getWorkspaceByNameOrId(workspaceId)
    if (!workspace) throw new Error('Workspace not found')

    const [{ writeFileSync, existsSync, unlinkSync, readdirSync }, { join, normalize, basename }] = await Promise.all([
      import('fs'),
      import('path'),
    ])

    // Security: validate path
    const ALLOWED_EXTENSIONS = ['.svg', '.png', '.jpg', '.jpeg', '.webp', '.gif']

    if (relativePath.includes('..')) {
      throw new Error('Invalid path: directory traversal not allowed')
    }

    const ext = relativePath.toLowerCase().slice(relativePath.lastIndexOf('.'))
    if (!ALLOWED_EXTENSIONS.includes(ext)) {
      throw new Error(`Invalid file type: ${ext}. Allowed: ${ALLOWED_EXTENSIONS.join(', ')}`)
    }

    // Resolve path relative to workspace root
    const absolutePath = normalize(join(workspace.rootPath, relativePath))

    // Double-check the resolved path is still within workspace
    if (!absolutePath.startsWith(workspace.rootPath)) {
      throw new Error('Invalid path: outside workspace directory')
    }

    // If this is an icon file (icon.*), delete any existing icon files with different extensions
    const fileName = basename(relativePath)
    if (fileName.startsWith('icon.')) {
      const files = readdirSync(workspace.rootPath)
      for (const file of files) {
        if (file.startsWith('icon.') && file !== fileName) {
          const oldPath = join(workspace.rootPath, file)
          try {
            unlinkSync(oldPath)
          } catch {
            // Ignore errors deleting old icon
          }
        }
      }
    }

    // Decode base64 to buffer
    const buffer = Buffer.from(base64, 'base64')

    // For SVGs, just write directly (no resizing needed)
    if (mimeType === 'image/svg+xml' || ext === '.svg') {
      writeFileSync(absolutePath, buffer)
      return
    }

    // For raster images, resize to max 256x256
    const metadata = await deps.platform.imageProcessor.getMetadata(buffer)
    const width = metadata?.width ?? 0
    const height = metadata?.height ?? 0

    // Only resize if larger than 256px
    if (width > 256 || height > 256) {
      const resized = await deps.platform.imageProcessor.process(buffer, {
        resize: { width: 256, height: 256 },
        format: 'png',
      })
      writeFileSync(absolutePath, resized)
    } else {
      // Small enough, write as-is
      writeFileSync(absolutePath, buffer)
    }
  })

  // ============================================================
  // Theme (app-level only)
  // ============================================================

  server.handle(RPC_NAMESPACES.theme.GET_APP, async () => {
    const { loadAppTheme } = await import('@craft-agent/shared/config/storage')
    return loadAppTheme()
  })

  server.handle(RPC_NAMESPACES.theme.SET_APP, async (_ctx, theme: import('@craft-agent/shared/config').ThemeOverrides | null) => {
    const { saveAppTheme } = await import('@craft-agent/shared/config/storage')
    saveAppTheme(theme)
  })

  // Preset themes (app-level)
  server.handle(RPC_NAMESPACES.theme.GET_PRESETS, async () => {
    const { loadPresetThemes } = await import('@craft-agent/shared/config/storage')
    return loadPresetThemes()
  })

  server.handle(RPC_NAMESPACES.theme.LOAD_PRESET, async (_ctx, themeId: string) => {
    const { loadPresetTheme } = await import('@craft-agent/shared/config/storage')
    return loadPresetTheme(themeId)
  })

  server.handle(RPC_NAMESPACES.theme.GET_COLOR_THEME, async () => {
    const { getColorTheme } = await import('@craft-agent/shared/config/storage')
    return getColorTheme()
  })

  server.handle(RPC_NAMESPACES.theme.SET_COLOR_THEME, async (_ctx, themeId: string) => {
    const { setColorTheme } = await import('@craft-agent/shared/config/storage')
    setColorTheme(themeId)
  })

  // Broadcast theme preferences to all other windows (for cross-window sync)
  server.handle(RPC_NAMESPACES.theme.BROADCAST_PREFERENCES, async (ctx, preferences: { mode: string; colorTheme: string; font: string }) => {
    pushTyped(server, RPC_NAMESPACES.theme.PREFERENCES_CHANGED, { to: 'all' }, preferences)
  })

  // Workspace-level theme overrides
  server.handle(RPC_NAMESPACES.theme.GET_WORKSPACE_COLOR_THEME, async (_ctx, workspaceId: string) => {
    const [{ getWorkspaces }, { getWorkspaceColorTheme }] = await Promise.all([
      import('@craft-agent/shared/config/storage'),
      import('@craft-agent/shared/workspaces/storage'),
    ])
    const workspaces = getWorkspaces()
    const workspace = workspaces.find(w => w.id === workspaceId)
    if (!workspace) return null
    return getWorkspaceColorTheme(workspace.rootPath) ?? null
  })

  server.handle(RPC_NAMESPACES.theme.SET_WORKSPACE_COLOR_THEME, async (_ctx, workspaceId: string, themeId: string | null) => {
    const [{ getWorkspaces }, { setWorkspaceColorTheme }] = await Promise.all([
      import('@craft-agent/shared/config/storage'),
      import('@craft-agent/shared/workspaces/storage'),
    ])
    const workspaces = getWorkspaces()
    const workspace = workspaces.find(w => w.id === workspaceId)
    if (!workspace) return
    setWorkspaceColorTheme(workspace.rootPath, themeId ?? undefined)
  })

  server.handle(RPC_NAMESPACES.theme.GET_ALL_WORKSPACE_THEMES, async () => {
    const [{ getWorkspaces }, { getWorkspaceColorTheme }] = await Promise.all([
      import('@craft-agent/shared/config/storage'),
      import('@craft-agent/shared/workspaces/storage'),
    ])
    const workspaces = getWorkspaces()
    const themes: Record<string, string | undefined> = {}
    for (const ws of workspaces) {
      themes[ws.id] = getWorkspaceColorTheme(ws.rootPath)
    }
    return themes
  })

  // Broadcast workspace theme change to all other windows (for cross-window sync)
  server.handle(RPC_NAMESPACES.theme.BROADCAST_WORKSPACE_THEME, async (ctx, workspaceId: string, themeId: string | null) => {
    pushTyped(server, RPC_NAMESPACES.theme.WORKSPACE_THEME_CHANGED, { to: 'all' }, { workspaceId, themeId })
  })

  // ============================================================
  // Views
  // ============================================================

  // List views for a workspace (dynamic expression-based filters stored in views.json)
  server.handle(RPC_NAMESPACES.views.LIST, async (_ctx, workspaceId: string) => {
    const workspace = getWorkspaceByNameOrId(workspaceId)
    if (!workspace) throw new Error('Workspace not found')

    const { listViews } = await import('@craft-agent/shared/views/storage')
    return listViews(workspace.rootPath)
  })

  // Save views (replaces full array)
  server.handle(RPC_NAMESPACES.views.SAVE, async (_ctx, workspaceId: string, views: import('@craft-agent/shared/views').ViewConfig[]) => {
    const workspace = getWorkspaceByNameOrId(workspaceId)
    if (!workspace) throw new Error('Workspace not found')

    const { saveViews } = await import('@craft-agent/shared/views/storage')
    saveViews(workspace.rootPath, views)
    // Broadcast labels changed since views are used alongside labels in sidebar
    pushTyped(server, RPC_NAMESPACES.labels.CHANGED, { to: 'workspace', workspaceId }, workspaceId)
  })

  // ============================================================
  // Tool Icons and Logo
  // ============================================================

  // Tool icon mappings — loads tool-icons.json and resolves each entry's icon to a data URL
  // for display in the Appearance settings page
  server.handle(RPC_NAMESPACES.toolIcons.GET_MAPPINGS, async () => {
    const [{ getToolIconsDir }, { loadToolIconConfig }, { encodeIconToDataUrl }, { join }] = await Promise.all([
      import('@craft-agent/shared/config/storage'),
      import('@craft-agent/shared/utils/cli-icon-resolver'),
      import('@craft-agent/shared/utils/icon-encoder'),
      import('path'),
    ])

    const toolIconsDir = getToolIconsDir()
    const config = loadToolIconConfig(toolIconsDir)
    if (!config) return []

    return config.tools
      .flatMap(tool => {
        const iconPath = join(toolIconsDir, tool.icon)
        const iconDataUrl = encodeIconToDataUrl(iconPath)
        if (!iconDataUrl) return []
        return [{
          id: tool.id,
          displayName: tool.displayName,
          iconDataUrl,
          commands: tool.commands,
        }]
      })
  })

  // Logo URL resolution (uses Node.js filesystem cache for provider domains)
  server.handle(RPC_NAMESPACES.logo.GET_URL, async (_ctx, serviceUrl: string, provider?: string) => {
    const { getLogoUrl } = await import('@craft-agent/shared/utils/logo')
    const result = getLogoUrl(serviceUrl, provider)
    return result
  })
}
