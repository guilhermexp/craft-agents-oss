import { createHash } from 'node:crypto'
import { mkdir, readFile, readdir, unlink, writeFile } from 'fs/promises'
import { basename, join } from 'path'
import { RPC_CHANNELS, type FileAttachment, type SendMessageOptions, type SessionEvent } from '@craft-agent/shared/protocol'
import type { StoredAttachment } from '@craft-agent/core/types'
import { getWorkspaceByNameOrId } from '@craft-agent/shared/config'
import { perf } from '@craft-agent/shared/utils'
import { isValidThinkingLevel, THINKING_LEVEL_IDS } from '@craft-agent/shared/agent/thinking-levels'

const VALID_THINKING_LEVELS_LIST = THINKING_LEVEL_IDS.map(id => `'${id}'`).join(', ')
import { pushTyped, type RpcServer } from '@craft-agent/server-core/transport'
import type { HandlerDeps } from '../handler-deps'
import { setTransferableHandler } from './transfer'

interface ClientSessionWatchState {
  watcher: import('fs').FSWatcher
  sessionId: string
  debounceTimer: ReturnType<typeof setTimeout> | null
}

// Per-client session file watcher state (supports concurrent windows/clients safely)
const clientSessionWatches = new Map<string, ClientSessionWatchState>()
const MERMAID_FENCE_RE = /```[ \t]*mermaid[^\n]*\n([\s\S]*?)```/gi
const MAX_MERMAID_ARTIFACTS_PER_SESSION = 50
const MERMAID_SVG_COLORS = {
  bg: '#0f1117',
  fg: '#f4f4f5',
  accent: '#22c55e',
  line: '#9ca3af',
  muted: '#a1a1aa',
  surface: '#18181b',
  border: '#3f3f46',
  faint: '#71717a',
} as const

/**
 * Clean up session file watcher for a client.
 * Called from main process disconnect hooks to prevent watcher leaks.
 */
export function cleanupSessionFileWatchForClient(clientId: string): void {
  const state = clientSessionWatches.get(clientId)
  if (!state) return

  if (state.debounceTimer) {
    clearTimeout(state.debounceTimer)
    state.debounceTimer = null
  }

  state.watcher.close()
  clientSessionWatches.delete(clientId)
}

function extractMermaidBlocksFromMarkdown(content: string): string[] {
  const blocks: string[] = []
  for (const match of content.matchAll(MERMAID_FENCE_RE)) {
    const code = match[1]?.trim()
    if (code) blocks.push(code)
  }
  return blocks
}

function stableDiagramName(sequence: number, messageId: string, code: string): string {
  const messagePart = messageId.replace(/[^a-zA-Z0-9_-]/g, '').slice(0, 18) || 'message'
  const hash = createHash('sha256').update(code).digest('hex').slice(0, 10)
  return `mermaid-${String(sequence).padStart(2, '0')}-${messagePart}-${hash}`
}

async function writeFileIfChanged(filePath: string, content: string): Promise<void> {
  try {
    const existing = await readFile(filePath, 'utf-8')
    if (existing === content) return
  } catch {
    // Missing or unreadable generated artifact: rewrite it below.
  }
  await writeFile(filePath, content, 'utf-8')
}

async function removeVisibleMermaidSources(diagramsDir: string): Promise<void> {
  let entries: string[]
  try {
    entries = await readdir(diagramsDir)
  } catch {
    return
  }

  await Promise.all(
    entries
      .filter((name) => name.endsWith('.mmd'))
      .map((name) => unlink(join(diagramsDir, name)).catch(() => {}))
  )
}

function makeMermaidSvgStandalone(svg: string): string {
  const replacements = new Map<string, string>([
    ['var(--bg)', MERMAID_SVG_COLORS.bg],
    ['var(--fg)', MERMAID_SVG_COLORS.fg],
    ['var(--line)', MERMAID_SVG_COLORS.line],
    ['var(--accent)', MERMAID_SVG_COLORS.accent],
    ['var(--muted)', MERMAID_SVG_COLORS.muted],
    ['var(--surface)', MERMAID_SVG_COLORS.surface],
    ['var(--border)', MERMAID_SVG_COLORS.border],
    ['var(--_text)', MERMAID_SVG_COLORS.fg],
    ['var(--_text-sec)', MERMAID_SVG_COLORS.muted],
    ['var(--_text-muted)', MERMAID_SVG_COLORS.muted],
    ['var(--_text-faint)', MERMAID_SVG_COLORS.faint],
    ['var(--_line)', MERMAID_SVG_COLORS.line],
    ['var(--_arrow)', MERMAID_SVG_COLORS.accent],
    ['var(--_node-fill)', MERMAID_SVG_COLORS.surface],
    ['var(--_node-stroke)', MERMAID_SVG_COLORS.border],
    ['var(--_group-fill)', MERMAID_SVG_COLORS.bg],
    ['var(--_group-hdr)', MERMAID_SVG_COLORS.surface],
    ['var(--_inner-stroke)', MERMAID_SVG_COLORS.border],
    ['var(--_key-badge)', MERMAID_SVG_COLORS.surface],
  ])

  let standalone = svg
    .replace(/style="[^"]*background:var\(--bg\)[^"]*"/, `style="background:${MERMAID_SVG_COLORS.bg}"`)
    .replace(/<style>[\s\S]*?<\/style>\n?/, '<style>text { font-family: Inter, system-ui, sans-serif; }</style>\n')

  for (const [token, color] of replacements) {
    standalone = standalone.split(token).join(color)
  }

  return standalone
}

async function renderMermaidSvg(code: string): Promise<string | null> {
  try {
    const { renderMermaidSVG } = await import('beautiful-mermaid')
    const svg = renderMermaidSVG(code, {
      bg: MERMAID_SVG_COLORS.bg,
      fg: MERMAID_SVG_COLORS.fg,
      accent: MERMAID_SVG_COLORS.accent,
      line: MERMAID_SVG_COLORS.line,
      muted: MERMAID_SVG_COLORS.muted,
      surface: MERMAID_SVG_COLORS.surface,
      border: MERMAID_SVG_COLORS.border,
      transparent: false,
      interactive: true,
    })
    return makeMermaidSvgStandalone(svg)
  } catch {
    return null
  }
}

export async function syncMermaidDiagramArtifacts(sessionPath: string): Promise<void> {
  const sessionFile = join(sessionPath, 'session.jsonl')
  let content: string
  try {
    content = await readFile(sessionFile, 'utf-8')
  } catch {
    return
  }

  const diagrams: Array<{ messageId: string; code: string }> = []
  const lines = content.split('\n').filter(Boolean).slice(1)
  for (const line of lines) {
    if (diagrams.length >= MAX_MERMAID_ARTIFACTS_PER_SESSION) break
    let parsed: { id?: unknown; content?: unknown }
    try {
      parsed = JSON.parse(line) as { id?: unknown; content?: unknown }
    } catch {
      continue
    }
    if (typeof parsed.content !== 'string') continue
    const blocks = extractMermaidBlocksFromMarkdown(parsed.content)
    for (const code of blocks) {
      if (diagrams.length >= MAX_MERMAID_ARTIFACTS_PER_SESSION) break
      diagrams.push({
        messageId: typeof parsed.id === 'string' ? parsed.id : `message-${diagrams.length + 1}`,
        code,
      })
    }
  }

  if (diagrams.length === 0) return

  const diagramsDir = join(sessionPath, 'diagrams')
  const sourceDir = join(sessionPath, '.diagram-sources')
  await Promise.all([
    mkdir(diagramsDir, { recursive: true }),
    mkdir(sourceDir, { recursive: true }),
  ])
  await removeVisibleMermaidSources(diagramsDir)

  await Promise.all(diagrams.map(async ({ messageId, code }, index) => {
    const baseName = stableDiagramName(index + 1, messageId, code)
    const sourcePath = join(sourceDir, `${baseName}.mmd`)
    const svgPath = join(diagramsDir, `${baseName}.svg`)

    const source = `%% Generated from session Mermaid block. Edit the chat message to change the source.\n${code}\n`
    const svg = await renderMermaidSvg(code)
    await Promise.all([
      writeFileIfChanged(sourcePath, source),
      svg ? writeFileIfChanged(svgPath, svg) : Promise.resolve(),
    ])
  }))
}

// Recursive directory scanner for session files
// Filters out internal files (session.jsonl) and hidden files (. prefix)
// Returns only non-empty directories
async function scanSessionDirectory(dirPath: string): Promise<import('@craft-agent/shared/protocol').SessionFile[]> {
  const { readdir, stat } = await import('fs/promises')
  const entries = await readdir(dirPath, { withFileTypes: true })
  const files: import('@craft-agent/shared/protocol').SessionFile[] = []

  for (const entry of entries) {
    // Skip internal and hidden files
    if (entry.name === 'session.jsonl' || entry.name.startsWith('.')) continue
    if (basename(dirPath) === 'diagrams' && entry.name.endsWith('.mmd')) continue

    const fullPath = join(dirPath, entry.name)

    if (entry.isDirectory()) {
      // Recursively scan subdirectory
      const children = await scanSessionDirectory(fullPath)
      // Only include non-empty directories
      if (children.length > 0) {
        files.push({
          name: entry.name,
          path: fullPath,
          type: 'directory',
          children,
        })
      }
    } else {
      const stats = await stat(fullPath)
      files.push({
        name: entry.name,
        path: fullPath,
        type: 'file',
        size: stats.size,
      })
    }
  }

  // Sort: directories first, then alphabetically
  return files.sort((a, b) => {
    if (a.type !== b.type) return a.type === 'directory' ? -1 : 1
    return a.name.localeCompare(b.name)
  })
}

export const HANDLED_CHANNELS = [
  RPC_CHANNELS.sessions.GET,
  RPC_CHANNELS.sessions.GET_UNREAD_SUMMARY,
  RPC_CHANNELS.sessions.MARK_ALL_READ,
  RPC_CHANNELS.sessions.CREATE,
  RPC_CHANNELS.sessions.DELETE,
  RPC_CHANNELS.sessions.GET_MESSAGES,
  RPC_CHANNELS.sessions.SEND_MESSAGE,
  RPC_CHANNELS.sessions.CANCEL,
  RPC_CHANNELS.sessions.KILL_SHELL,
  RPC_CHANNELS.tasks.GET_OUTPUT,
  RPC_CHANNELS.sessions.RESPOND_TO_PERMISSION,
  RPC_CHANNELS.sessions.RESPOND_TO_CREDENTIAL,
  RPC_CHANNELS.sessions.COMMAND,
  RPC_CHANNELS.sessions.GET_PENDING_PLAN_EXECUTION,
  RPC_CHANNELS.sessions.GET_PERMISSION_MODE_STATE,
  RPC_CHANNELS.sessions.SEARCH_CONTENT,
  RPC_CHANNELS.sessions.GET_FILES,
  RPC_CHANNELS.sessions.GET_NOTES,
  RPC_CHANNELS.sessions.SET_NOTES,
  RPC_CHANNELS.sessions.WATCH_FILES,
  RPC_CHANNELS.sessions.UNWATCH_FILES,
  RPC_CHANNELS.sessions.EXPORT,
  RPC_CHANNELS.sessions.IMPORT,
  RPC_CHANNELS.sessions.EXPORT_REMOTE_TRANSFER,
  RPC_CHANNELS.sessions.IMPORT_REMOTE_TRANSFER,
] as const

export function registerSessionsHandlers(server: RpcServer, deps: HandlerDeps): void {
  const { sessionManager, platform } = deps
  const log = platform.logger

  // Get all sessions for the calling window's workspace
  // Waits for initialization to complete so sessions are never returned empty during startup
  server.handle(RPC_CHANNELS.sessions.GET, async (ctx) => {
    try {
      await sessionManager.waitForInit()
    } catch (error) {
      log.error('GET_SESSIONS continuing after initialization failure:', error)
    }
    const end = perf.start('rpc.getSessions')
    const workspaceId = ctx.workspaceId ?? deps.windowManager?.getWorkspaceForWindow(ctx.webContentsId!)
    const sessions = sessionManager.getSessions(workspaceId ?? undefined)
    end()
    return sessions
  })

  // Get unread summary across all workspaces
  server.handle(RPC_CHANNELS.sessions.GET_UNREAD_SUMMARY, async () => {
    try {
      await sessionManager.waitForInit()
    } catch (error) {
      log.error('GET_UNREAD_SUMMARY continuing after initialization failure:', error)
    }
    return sessionManager.getUnreadSummary()
  })

  server.handle(RPC_CHANNELS.sessions.MARK_ALL_READ, async (_ctx, workspaceId: string) => {
    return sessionManager.markAllSessionsRead(workspaceId)
  })

  // Get a single session with messages (for lazy loading)
  server.handle(RPC_CHANNELS.sessions.GET_MESSAGES, async (_ctx, sessionId: string) => {
    const end = perf.start('rpc.getSessionMessages')
    const session = await sessionManager.getSession(sessionId)
    end()
    return session
  })

  // Create a new session
  server.handle(RPC_CHANNELS.sessions.CREATE, async (_ctx, workspaceId: string, options?: import('@craft-agent/shared/protocol').CreateSessionOptions) => {
    const end = perf.start('rpc.createSession', { workspaceId })
    const session = await sessionManager.createSession(workspaceId, options)
    end()
    return session
  })

  // Delete a session
  server.handle(RPC_CHANNELS.sessions.DELETE, async (_ctx, sessionId: string) => {
    return sessionManager.deleteSession(sessionId)
  })

  // Send a message to a session (with optional file attachments)
  // Note: We intentionally don't await here - the response is streamed via events.
  // The IPC handler returns immediately, and results come through SESSION_EVENT channel.
  // attachments: FileAttachment[] for Claude (has content), storedAttachments: StoredAttachment[] for persistence (has thumbnailBase64)
  server.handle(RPC_CHANNELS.sessions.SEND_MESSAGE, async (ctx, sessionId: string, message: string, attachments?: FileAttachment[], storedAttachments?: StoredAttachment[], options?: SendMessageOptions) => {
    // Capture the caller's clientId for error routing
    const callerClientId = ctx.clientId

    // Start processing in background, errors are sent via event stream
    sessionManager.sendMessage(sessionId, message, attachments, storedAttachments, options).catch(err => {
      log.error('Error in sendMessage:', err)
      // Send error to the calling client
      pushTyped(server, RPC_CHANNELS.sessions.EVENT, { to: 'client', clientId: callerClientId }, {
        type: 'error',
        sessionId,
        error: err instanceof Error ? err.message : 'Unknown error'
      } as SessionEvent)
      // Also send complete event to clear processing state
      pushTyped(server, RPC_CHANNELS.sessions.EVENT, { to: 'client', clientId: callerClientId }, {
        type: 'complete',
        sessionId
      } as SessionEvent)
    })
    // Return immediately - streaming results come via SESSION_EVENT
    return { started: true }
  })

  // Cancel processing
  server.handle(RPC_CHANNELS.sessions.CANCEL, async (_ctx, sessionId: string, silent?: boolean) => {
    return sessionManager.cancelProcessing(sessionId, silent)
  })

  // Kill background shell
  server.handle(RPC_CHANNELS.sessions.KILL_SHELL, async (_ctx, sessionId: string, shellId: string) => {
    return sessionManager.killShell(sessionId, shellId)
  })

  // Get background task output
  server.handle(RPC_CHANNELS.tasks.GET_OUTPUT, async (_ctx, taskId: string) => {
    try {
      const output = await sessionManager.getTaskOutput(taskId)
      return output
    } catch (err) {
      log.error('Failed to get task output:', err)
      throw err
    }
  })

  // Respond to a permission request (bash command approval)
  // Returns true if the response was delivered, false if agent/session is gone
  server.handle(RPC_CHANNELS.sessions.RESPOND_TO_PERMISSION, async (_ctx, sessionId: string, requestId: string, allowed: boolean, alwaysAllow: boolean) => {
    return sessionManager.respondToPermission(sessionId, requestId, allowed, alwaysAllow)
  })

  // Respond to a credential request (secure auth input)
  // Returns true if the response was delivered, false if agent/session is gone
  server.handle(RPC_CHANNELS.sessions.RESPOND_TO_CREDENTIAL, async (_ctx, sessionId: string, requestId: string, response: import('@craft-agent/shared/protocol').CredentialResponse) => {
    return sessionManager.respondToCredential(sessionId, requestId, response)
  })

  // ==========================================================================
  // Consolidated Command Handlers
  // ==========================================================================

  // Session commands - consolidated handler for session operations
  server.handle(RPC_CHANNELS.sessions.COMMAND, async (
    _ctx,
    sessionId: string,
    command: import('@craft-agent/shared/protocol').SessionCommand
  ) => {
    switch (command.type) {
      case 'flag':
        return sessionManager.flagSession(sessionId)
      case 'unflag':
        return sessionManager.unflagSession(sessionId)
      case 'archive':
        return sessionManager.archiveSession(sessionId)
      case 'unarchive':
        return sessionManager.unarchiveSession(sessionId)
      case 'rename':
        return sessionManager.renameSession(sessionId, command.name)
      case 'setSessionStatus':
        return sessionManager.setSessionStatus(sessionId, command.state)
      case 'markRead':
        return sessionManager.markSessionRead(sessionId)
      case 'markUnread':
        return sessionManager.markSessionUnread(sessionId)
      case 'setActiveViewing':
        // Track which session user is actively viewing (for unread state machine)
        return sessionManager.setActiveViewingSession(sessionId, command.workspaceId)
      case 'setPermissionMode':
        return sessionManager.setSessionPermissionMode(sessionId, command.mode)
      case 'setThinkingLevel':
        // Validate thinking level before passing to session manager
        if (!isValidThinkingLevel(command.level)) {
          throw new Error(`Invalid thinking level: ${command.level}. Valid values: ${VALID_THINKING_LEVELS_LIST}`)
        }
        return sessionManager.setSessionThinkingLevel(sessionId, command.level)
      case 'updateWorkingDirectory':
        return sessionManager.updateWorkingDirectory(sessionId, command.dir)
      case 'setSources':
        return sessionManager.setSessionSources(sessionId, command.sourceSlugs)
      case 'setLabels':
        return sessionManager.setSessionLabels(sessionId, command.labels)
      case 'showInFinder': {
        const sessionPath = sessionManager.getSessionPath(sessionId)
        if (sessionPath) {
          deps.platform.showItemInFolder?.(sessionPath)
        }
        return
      }
      case 'copyPath': {
        // Return the session folder path for copying to clipboard
        const sessionPath = sessionManager.getSessionPath(sessionId)
        return sessionPath ? { success: true, path: sessionPath } : { success: false }
      }
      case 'shareToViewer':
        return sessionManager.shareToViewer(sessionId)
      case 'updateShare':
        return sessionManager.updateShare(sessionId)
      case 'revokeShare':
        return sessionManager.revokeShare(sessionId)
      case 'refreshTitle':
        log.info(`IPC: refreshTitle received for session ${sessionId}`)
        return sessionManager.refreshTitle(sessionId)
      // Connection selection (locked after first message)
      case 'setConnection':
        log.info(`IPC: setConnection received for session ${sessionId}, connection: ${command.connectionSlug}`)
        return sessionManager.setSessionConnection(sessionId, command.connectionSlug)
      case 'setHermesProfile':
        log.info(`IPC: setHermesProfile received for session ${sessionId}, profile: ${command.profileName}`)
        return sessionManager.setSessionHermesProfile(sessionId, command.profileName)
      // Pending plan execution (Accept & Compact flow)
      case 'setPendingPlanExecution':
        return sessionManager.setPendingPlanExecution(sessionId, command.planPath, command.draftInputSnapshot)
      case 'markCompactionComplete':
        return sessionManager.markCompactionComplete(sessionId)
      case 'markPendingPlanExecutionDispatched':
        return sessionManager.markPendingPlanExecutionDispatched(sessionId)
      case 'clearPendingPlanExecution':
        return sessionManager.clearPendingPlanExecution(sessionId)
      case 'addAnnotation':
        return sessionManager.addMessageAnnotation(sessionId, command.messageId, command.annotation)
      case 'removeAnnotation':
        return sessionManager.removeMessageAnnotation(sessionId, command.messageId, command.annotationId)
      case 'updateAnnotation':
        return sessionManager.updateMessageAnnotation(sessionId, command.messageId, command.annotationId, command.patch)
      default: {
        const _exhaustive: never = command
        throw new Error(`Unknown session command: ${JSON.stringify(command)}`)
      }
    }
  })

  // Get pending plan execution state (for reload recovery)
  server.handle(RPC_CHANNELS.sessions.GET_PENDING_PLAN_EXECUTION, async (
    _ctx,
    sessionId: string
  ) => {
    return sessionManager.getPendingPlanExecution(sessionId)
  })

  // Get authoritative permission mode diagnostics for renderer reconciliation
  server.handle(RPC_CHANNELS.sessions.GET_PERMISSION_MODE_STATE, async (
    _ctx,
    sessionId: string
  ) => {
    return sessionManager.getSessionPermissionModeState(sessionId)
  })

  // ============================================================
  // Session Content Search
  // ============================================================

  // Search session content using ripgrep
  server.handle(RPC_CHANNELS.sessions.SEARCH_CONTENT, async (_ctx, workspaceId: string, query: string, searchId?: string) => {
    const id = searchId || Date.now().toString(36)
    log.info('[search]','ipc:request', { searchId: id, query })

    const workspace = getWorkspaceByNameOrId(workspaceId)
    if (!workspace) {
      log.warn('SEARCH_SESSIONS: Workspace not found:', workspaceId)
      return []
    }

    const { searchSessions } = await import('@craft-agent/server-core/services')
    const { getWorkspaceSessionsPath } = await import('@craft-agent/shared/workspaces')

    const sessionsDir = getWorkspaceSessionsPath(workspace.rootPath)
    log.debug(`SEARCH_SESSIONS: Searching "${query}" in ${sessionsDir}`)

    const results = await searchSessions(query, sessionsDir, {
      timeout: 5000,
      maxMatchesPerSession: 3,
      maxSessions: 50,
      searchId: id,
    })

    // Filter out hidden sessions (e.g., mini edit sessions)
    const allSessions = await sessionManager.getSessions()
    const hiddenSessionIds = new Set(
      allSessions.filter(s => s.hidden).map(s => s.id)
    )
    const filteredResults = results.filter(r => !hiddenSessionIds.has(r.sessionId))

    log.info('[search]','ipc:response', { searchId: id, resultCount: filteredResults.length, totalFound: results.length })
    return filteredResults
  })

  // ============================================================
  // Session Info Panel (files, notes, file watching)
  // ============================================================

  // Get files in session directory (recursive tree structure)
  server.handle(RPC_CHANNELS.sessions.GET_FILES, async (_ctx, sessionId: string) => {
    const sessionPath = sessionManager.getSessionPath(sessionId)
    if (!sessionPath) return []

    try {
      await syncMermaidDiagramArtifacts(sessionPath)
      return await scanSessionDirectory(sessionPath)
    } catch (error) {
      log.error('Failed to get session files:', error)
      return []
    }
  })

  // Start watching a session directory for file changes (per client)
  server.handle(RPC_CHANNELS.sessions.WATCH_FILES, async (ctx, sessionId: string) => {
    const clientId = ctx.clientId
    cleanupSessionFileWatchForClient(clientId)

    const sessionPath = sessionManager.getSessionPath(sessionId)
    if (!sessionPath) return

    try {
      const { watch } = await import('fs')

      const state: ClientSessionWatchState = {
        watcher: null as unknown as import('fs').FSWatcher,
        sessionId,
        debounceTimer: null,
      }

      state.watcher = watch(sessionPath, { recursive: true }, (_eventType, filename) => {
        // Ignore internal files and hidden files
        if (filename && (filename.includes('session.jsonl') || filename.startsWith('.'))) {
          return
        }

        // Debounce: wait 100ms before notifying to batch rapid changes
        if (state.debounceTimer) {
          clearTimeout(state.debounceTimer)
        }

        state.debounceTimer = setTimeout(() => {
          pushTyped(server, RPC_CHANNELS.sessions.FILES_CHANGED, { to: 'client', clientId }, state.sessionId)
        }, 100)
      })

      clientSessionWatches.set(clientId, state)
    } catch (error) {
      log.error('Failed to start session file watcher:', error)
    }
  })

  // Stop watching session files for the calling client
  server.handle(RPC_CHANNELS.sessions.UNWATCH_FILES, async (ctx) => {
    cleanupSessionFileWatchForClient(ctx.clientId)
  })

  // Get session notes (reads notes.md from session directory)
  server.handle(RPC_CHANNELS.sessions.GET_NOTES, async (_ctx, sessionId: string) => {
    const sessionPath = sessionManager.getSessionPath(sessionId)
    if (!sessionPath) return ''

    try {
      const notesPath = join(sessionPath, 'notes.md')
      const content = await readFile(notesPath, 'utf-8')
      return content
    } catch {
      // File doesn't exist yet - return empty string
      return ''
    }
  })

  // Set session notes (writes to notes.md in session directory)
  server.handle(RPC_CHANNELS.sessions.SET_NOTES, async (_ctx, sessionId: string, content: string) => {
    const sessionPath = sessionManager.getSessionPath(sessionId)
    if (!sessionPath) {
      throw new Error(`Session not found: ${sessionId}`)
    }

    try {
      const notesPath = join(sessionPath, 'notes.md')
      await writeFile(notesPath, content, 'utf-8')
    } catch (error) {
      log.error('Failed to save session notes:', error)
      throw error
    }
  })

  // ============================================
  // Export / Import / Dispatch
  // ============================================

  // Export a session as a portable bundle
  server.handle(RPC_CHANNELS.sessions.EXPORT, async (ctx, sessionId: string) => {
    await sessionManager.waitForInit()
    const workspaceId = ctx.workspaceId ?? deps.windowManager?.getWorkspaceForWindow(ctx.webContentsId!)
    if (!workspaceId) throw new Error('No workspace context')

    const bundle = await sessionManager.exportSession(sessionId, workspaceId)
    if (!bundle) throw new Error(`Failed to export session ${sessionId}`)
    return bundle
  })

  // Import a session bundle into a target workspace
  // targetWorkspaceId is passed explicitly (not from context) so the renderer
  // can import into any workspace the server manages, not just the active one.
  const importHandler = async (_ctx: any, targetWorkspaceId: string, bundle: unknown, mode: string) => {
    await sessionManager.waitForInit()
    if (!targetWorkspaceId || typeof targetWorkspaceId !== 'string') throw new Error('targetWorkspaceId is required')
    if (mode !== 'move' && mode !== 'fork') throw new Error(`Invalid dispatch mode: ${mode}`)

    return sessionManager.importSession(targetWorkspaceId, bundle as import('@craft-agent/shared/sessions').SessionBundle, mode)
  }
  server.handle(RPC_CHANNELS.sessions.IMPORT, importHandler)
  // Also register as transferable so chunked transfer can invoke it on commit
  setTransferableHandler(RPC_CHANNELS.sessions.IMPORT, importHandler)

  // Export a session as a summarized remote-transfer payload.
  server.handle(RPC_CHANNELS.sessions.EXPORT_REMOTE_TRANSFER, async (ctx, sessionId: string) => {
    await sessionManager.waitForInit()
    const workspaceId = ctx.workspaceId ?? deps.windowManager?.getWorkspaceForWindow(ctx.webContentsId!)
    if (!workspaceId) throw new Error('No workspace context')

    const payload = await sessionManager.exportRemoteSessionTransfer(sessionId, workspaceId)
    if (!payload) throw new Error(`Failed to export remote transfer for session ${sessionId}`)
    return payload
  })

  // Import a summarized remote-transfer payload into a target workspace.
  server.handle(RPC_CHANNELS.sessions.IMPORT_REMOTE_TRANSFER, async (_ctx, targetWorkspaceId: string, payload: import('@craft-agent/shared/protocol').RemoteSessionTransferPayload) => {
    await sessionManager.waitForInit()
    if (!targetWorkspaceId || typeof targetWorkspaceId !== 'string') throw new Error('targetWorkspaceId is required')
    return sessionManager.importRemoteSessionTransfer(targetWorkspaceId, payload)
  })
}
