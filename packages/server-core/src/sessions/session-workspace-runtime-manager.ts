/**
 * SessionWorkspaceRuntimeManager — extracted from SessionManager.
 *
 * Owns workspace-level runtime concerns:
 *   - ConfigWatcher lifecycle (file-system watchers for sources, statuses, labels, etc.)
 *   - AutomationSystem lifecycle (scheduler, event handlers, event logging)
 *   - Broadcast helpers that push workspace config changes to renderer via EventSink
 *   - Workspace / active-session query helpers
 *   - Prompt automation execution (creates session + sends message)
 *
 * ADDITIVE extraction — SessionManager still holds the canonical instances.
 * This class can be wired in as a delegate once the God Object is decomposed.
 */

import type { EventSink } from '@craft-agent/server-core/transport'
import { createScopedLogger, CONSOLE_LOGGER, type Logger } from '@craft-agent/server-core/runtime'
import {
  type Session,
  type SessionEvent,
  type CreateSessionOptions,
  RPC_NAMESPACES,
} from '@craft-agent/shared/protocol'
import type { ActiveSessionInfo, SessionProcessingStatus } from '@craft-agent/core/types'
import type { PermissionMode } from '@craft-agent/shared/agent'
import type { ThinkingLevel } from '@craft-agent/shared/agent/thinking-levels'
import {
  ConfigWatcher,
  type ConfigWatcherCallbacks,
} from '@craft-agent/shared/config'
import {
  getWorkspaces,
  getWorkspaceByNameOrId,
  type Workspace,
  type WorkspaceInfo,
} from '@craft-agent/shared/config'
import type { ThemeOverrides } from '@craft-agent/shared/config'
import { loadWorkspaceSources, type LoadedSource } from '@craft-agent/shared/sources'
import { toPublicSourceDtos } from '@craft-agent/shared/sources/public-source-dto'
import { loadAllSkills, type LoadedSkill } from '@craft-agent/shared/skills'
import {
  AutomationSystem,
  createPromptHistoryEntry,
  appendAutomationHistoryEntry,
} from '@craft-agent/shared/automations'
import { resolveSessionConnection } from '@craft-agent/shared/agent/backend'
import { ensureLabelsExist } from '@craft-agent/shared/labels/crud'
import { getHeaderMetadataSignature, type SessionHeader } from '@craft-agent/shared/sessions'

// ---------------------------------------------------------------------------
// Logger — mirrors the pattern used in SessionManager
// ---------------------------------------------------------------------------

let log: Logger = createScopedLogger(CONSOLE_LOGGER, 'workspace-runtime')

export function setWorkspaceRuntimeLogger(logger: Logger): void {
  log = createScopedLogger(logger, 'workspace-runtime')
}

// ---------------------------------------------------------------------------
// Minimal managed-session shape needed by this module
// ---------------------------------------------------------------------------

/** The subset of ManagedSession that this module reads / writes. */
export interface ManagedSessionSlice {
  id: string
  workspace: Workspace
  isProcessing: boolean
  stopRequested?: boolean
  name?: string
  lastMessageAt: number
  triggeredBy?: { automationName?: string; event?: string; timestamp?: number }
  pendingExternalMetadata?: SessionHeader
  _metadataWriteGuardUntil?: number
}

// ---------------------------------------------------------------------------
// Dependency interface — thin contract satisfied by SessionManager
// ---------------------------------------------------------------------------

export interface SessionWorkspaceRuntimeManagerDeps {
  getEventSink(): EventSink | null
  getSession(sessionId: string): ManagedSessionSlice | undefined
  getAllSessions(): IterableIterator<ManagedSessionSlice>
  createSession(workspaceId: string, options?: CreateSessionOptions): Promise<Session>
  sendMessage(sessionId: string, message: string): Promise<void>
  sendEvent(event: SessionEvent, workspaceId?: string): void
  /**
   * Persist the managed session to disk after metadata mutation.
   * SessionManager owns the full ManagedSession and its JSONL store.
   */
  persistSession(managed: ManagedSessionSlice): void
  /**
   * Handle external session metadata changes detected by the ConfigWatcher.
   * Called for non-self-write metadata changes when the session is idle.
   */
  applyExternalSessionMetadata?(managed: ManagedSessionSlice, header: SessionHeader): void
  /** Signature of the last programmatic write, used to detect self-writes. */
  getLastWrittenSignature?(sessionId: string): string | undefined
  sourceOrchestrator?: {
    reloadSourcesForWorkspace(path: string): Promise<void>
  }
}

// ---------------------------------------------------------------------------
// SessionWorkspaceRuntimeManager
// ---------------------------------------------------------------------------

export class SessionWorkspaceRuntimeManager {
  private configWatchers: Map<string, ConfigWatcher> = new Map()
  private automationSystems: Map<string, AutomationSystem> = new Map()

  constructor(private readonly deps: SessionWorkspaceRuntimeManagerDeps) {}

  // ========================================================================
  // ConfigWatcher lifecycle
  // ========================================================================

  /**
   * Start watching workspace config files for live changes.
   * Idempotent — skips if a watcher already exists for the given path.
   */
  setupConfigWatcher(workspaceRootPath: string, workspaceId: string): void {
    if (this.configWatchers.has(workspaceRootPath)) {
      return // Already watching this workspace
    }

    log.info(`Setting up ConfigWatcher for workspace: ${workspaceId} (${workspaceRootPath})`)

    const callbacks: ConfigWatcherCallbacks = {
      onSourcesListChange: async (sources: LoadedSource[]) => {
        log.info(`Sources list changed in ${workspaceRootPath} (${sources.length} sources)`)
        this.broadcastSourcesChanged(workspaceId, sources)
        await this.deps.sourceOrchestrator?.reloadSourcesForWorkspace(workspaceRootPath)
      },
      onSourceChange: async (slug: string, source: LoadedSource | null) => {
        log.info(`Source '${slug}' changed:`, source ? 'updated' : 'deleted')
        const sources = loadWorkspaceSources(workspaceRootPath)
        this.broadcastSourcesChanged(workspaceId, sources)
        await this.deps.sourceOrchestrator?.reloadSourcesForWorkspace(workspaceRootPath)
      },
      onSourceGuideChange: (sourceSlug: string) => {
        log.info(`Source guide changed: ${sourceSlug}`)
        // Broadcast the updated sources list so sidebar picks up guide changes
        // Note: Guide changes don't require session source reload (no server changes)
        const sources = loadWorkspaceSources(workspaceRootPath)
        this.broadcastSourcesChanged(workspaceId, sources)
      },
      onStatusConfigChange: () => {
        log.info(`Status config changed in ${workspaceId}`)
        this.broadcastStatusesChanged(workspaceId)
      },
      onStatusIconChange: (_workspaceId: string, iconFilename: string) => {
        log.info(`Status icon changed: ${iconFilename} in ${workspaceId}`)
        this.broadcastStatusesChanged(workspaceId)
      },
      onLabelConfigChange: () => {
        log.info(`Label config changed in ${workspaceId}`)
        this.broadcastLabelsChanged(workspaceId)
        // Emit LabelConfigChange event via AutomationSystem
        const automationSystem = this.automationSystems.get(workspaceRootPath)
        if (automationSystem) {
          automationSystem.emitLabelConfigChange().catch((error) => {
            log.error(`[Automations] Failed to emit LabelConfigChange:`, error)
          })
        }
      },
      onAutomationsConfigChange: () => {
        log.info(`Automations config changed in ${workspaceId}`)
        // Reload automations config via AutomationSystem
        const automationSystem = this.automationSystems.get(workspaceRootPath)
        if (automationSystem) {
          const result = automationSystem.reloadConfig()
          if (result.errors.length === 0) {
            log.info(`Reloaded ${result.automationCount} automations for workspace ${workspaceId}`)
          } else {
            log.error(`Failed to reload automations for workspace ${workspaceId}:`, result.errors)
          }
        }
        // Notify renderer to re-read automations.json
        this.broadcastAutomationsChanged(workspaceId)
      },
      onLlmConnectionsChange: () => {
        log.info(`LLM connections changed in ${workspaceId}`)
        this.broadcastLlmConnectionsChanged()
      },
      onAppThemeChange: (theme) => {
        log.info(`App theme changed`)
        this.broadcastAppThemeChanged(theme)
      },
      onDefaultPermissionsChange: () => {
        log.info('Default permissions changed')
        this.broadcastDefaultPermissionsChanged()
      },
      onSkillsListChange: async (skills) => {
        log.info(`Skills list changed in ${workspaceRootPath} (${skills.length} skills)`)
        this.broadcastSkillsChanged(workspaceId, skills)
      },
      onSkillChange: async (slug, skill) => {
        log.info(`Skill '${slug}' changed:`, skill ? 'updated' : 'deleted')
        // Broadcast updated list to UI
        const { loadAllSkills: reloadSkills } = await import('@craft-agent/shared/skills')
        const skills = reloadSkills(workspaceRootPath)
        this.broadcastSkillsChanged(workspaceId, skills)
      },

      // Session metadata changes (edits to session.jsonl headers).
      // Detects changes from both internal writes (self) and external sources
      // (other instances, scripts, manual edits).
      onSessionMetadataChange: (sessionId, header) => {
        const managed = this.deps.getSession(sessionId)
        if (!managed) return

        // Check if this is our own write echoing back via fs.watch().
        // Self-writes don't need in-memory sync (already up to date), but
        // still need to notify the automation system for event matching.
        const incomingSignature = getHeaderMetadataSignature(header)
        const lastWrittenSignature = this.deps.getLastWrittenSignature?.(sessionId)
        const isSelfWrite = !!(lastWrittenSignature && incomingSignature === lastWrittenSignature)

        // For external writes: sync in-memory state + emit UI events.
        // Skip for self-writes to avoid feedback loops (especially on Windows
        // where fs.watch fires aggressively: unlink + rename = 2+ events).
        if (!isSelfWrite) {
          // Defer external metadata application when:
          // 1. Session is actively processing (agent running), OR
          // 2. Session was just written programmatically (set_session_status/labels tool)
          //    — fs.watch fires during atomic write (unlink+rename) and can read stale data
          const hasWriteGuard = managed._metadataWriteGuardUntil && Date.now() < managed._metadataWriteGuardUntil
          if (managed.isProcessing || hasWriteGuard) {
            managed.pendingExternalMetadata = header
            if (hasWriteGuard) {
              log.info(`Deferred external metadata update for session ${sessionId} (recent programmatic write)`)
            } else {
              log.info(`Deferred external metadata update for session ${sessionId} (processing active)`)
            }
          } else {
            this.deps.applyExternalSessionMetadata?.(managed, header)
          }
        }

        // Always notify automation system — it does its own diffing and needs
        // to see both self-writes and external changes for event matching.
        const automationSystem = this.automationSystems.get(managed.workspace.rootPath)
        if (automationSystem) {
          automationSystem.updateSessionMetadata(sessionId, {
            permissionMode: header.permissionMode,
            labels: header.labels,
            isFlagged: header.isFlagged,
            sessionStatus: header.sessionStatus,
            sessionName: header.name,
          }).catch((error) => {
            log.error(`[Automations] Failed to update session metadata:`, error)
          })
        }
      },
    }

    const watcher = new ConfigWatcher(workspaceRootPath, callbacks)
    watcher.start()
    this.configWatchers.set(workspaceRootPath, watcher)

    // Initialize AutomationSystem for this workspace (includes scheduler, handlers, and event logging)
    if (!this.automationSystems.has(workspaceRootPath)) {
      const automationSystem = new AutomationSystem({
        workspaceRootPath,
        workspaceId,
        enableScheduler: true,
        onPromptsReady: async (prompts) => {
          // Execute prompt automations by creating new sessions
          const settled = await Promise.allSettled(
            prompts.map((pending) =>
              this.executePromptAutomation(
                workspaceId,
                workspaceRootPath,
                pending.prompt,
                pending.labels,
                pending.permissionMode,
                pending.mentions,
                pending.llmConnection,
                pending.model,
                pending.thinkingLevel,
                pending.automationName,
              )
            )
          )

          // Write enriched history entries (with session IDs and prompt summaries)
          for (const [idx, result] of settled.entries()) {
            const pending = prompts[idx]
            if (!pending.matcherId) continue

            const entry = createPromptHistoryEntry({
              matcherId: pending.matcherId,
              ok: result.status === 'fulfilled',
              sessionId: result.status === 'fulfilled' ? result.value.sessionId : undefined,
              prompt: pending.prompt,
              error: result.status === 'rejected' ? String(result.reason) : undefined,
            })

            appendAutomationHistoryEntry(workspaceRootPath, entry).catch(e => log.warn('[Automations] Failed to write history:', e))

            if (result.status === 'rejected') {
              log.error(`[Automations] Failed to execute prompt action ${idx + 1}:`, result.reason)
            } else {
              log.info(`[Automations] Created session ${result.value.sessionId} from prompt action`)
            }
          }
        },
        onError: (event, error) => {
          log.error(`Automation failed for ${event}:`, error.message)
        },
      })
      this.automationSystems.set(workspaceRootPath, automationSystem)
      log.info(`Initialized AutomationSystem for workspace ${workspaceId}`)
    }
  }

  /**
   * Manually notify the ConfigWatcher of a file change.
   * Workaround for Bun's fs.watch on Linux not detecting atomic renames.
   */
  notifyConfigFileChange(workspaceRootPath: string, relativePath: string): void {
    const watcher = this.configWatchers.get(workspaceRootPath)
    watcher?.notifyFileChange(relativePath)
  }

  /**
   * Get the ConfigWatcher for a workspace path (used by SessionManager for
   * source credential invalidation and other external watcher interactions).
   */
  getConfigWatcher(workspaceRootPath: string): ConfigWatcher | undefined {
    return this.configWatchers.get(workspaceRootPath)
  }

  /**
   * Get the AutomationSystem for a workspace path.
   */
  getAutomationSystem(workspaceRootPath: string): AutomationSystem | undefined {
    return this.automationSystems.get(workspaceRootPath)
  }

  // ========================================================================
  // Broadcast helpers — push workspace config changes to renderer
  // ========================================================================

  broadcastSourcesChanged(workspaceId: string, sources: LoadedSource[]): void {
    const sink = this.deps.getEventSink()
    if (!sink) return
    sink(RPC_NAMESPACES.sources.CHANGED, { to: 'workspace', workspaceId }, workspaceId, toPublicSourceDtos(sources))
  }

  broadcastStatusesChanged(workspaceId: string): void {
    const sink = this.deps.getEventSink()
    if (!sink) return
    log.info(`Broadcasting statuses changed for ${workspaceId}`)
    sink(RPC_NAMESPACES.statuses.CHANGED, { to: 'workspace', workspaceId }, workspaceId)
  }

  broadcastLabelsChanged(workspaceId: string): void {
    const sink = this.deps.getEventSink()
    if (!sink) return
    log.info(`Broadcasting labels changed for ${workspaceId}`)
    sink(RPC_NAMESPACES.labels.CHANGED, { to: 'workspace', workspaceId }, workspaceId)
  }

  broadcastAutomationsChanged(workspaceId: string): void {
    const sink = this.deps.getEventSink()
    if (!sink) return
    log.info(`Broadcasting automations changed for ${workspaceId}`)
    sink(RPC_NAMESPACES.automations.CHANGED, { to: 'workspace', workspaceId }, workspaceId)
  }

  broadcastAppThemeChanged(theme: ThemeOverrides | null): void {
    const sink = this.deps.getEventSink()
    if (!sink) return
    log.info(`Broadcasting app theme changed`)
    sink(RPC_NAMESPACES.theme.APP_CHANGED, { to: 'all' }, theme)
  }

  broadcastLlmConnectionsChanged(): void {
    const sink = this.deps.getEventSink()
    if (!sink) return
    log.info('Broadcasting LLM connections changed')
    sink(RPC_NAMESPACES.llmConnections.CHANGED, { to: 'all' })
  }

  broadcastSkillsChanged(workspaceId: string, skills: LoadedSkill[]): void {
    const sink = this.deps.getEventSink()
    if (!sink) return
    log.info(`Broadcasting skills changed (${skills.length} skills)`)
    sink(RPC_NAMESPACES.skills.CHANGED, { to: 'workspace', workspaceId }, workspaceId, skills)
  }

  broadcastDefaultPermissionsChanged(): void {
    const sink = this.deps.getEventSink()
    if (!sink) return
    log.info('Broadcasting default permissions changed')
    sink(RPC_NAMESPACES.permissions.DEFAULTS_CHANGED, { to: 'all' }, null)
  }

  // ========================================================================
  // Prompt automation execution
  // ========================================================================

  /**
   * Execute a prompt automation by creating a new session and sending the prompt.
   */
  async executePromptAutomation(
    workspaceId: string,
    workspaceRootPath: string,
    prompt: string,
    labels?: string[],
    permissionMode?: PermissionMode,
    mentions?: string[],
    llmConnection?: string,
    model?: string,
    thinkingLevel?: ThinkingLevel,
    automationName?: string,
  ): Promise<{ sessionId: string }> {
    // Warn if llmConnection was specified but doesn't resolve
    if (llmConnection) {
      const connection = resolveSessionConnection(llmConnection)
      if (!connection) {
        log.warn(`[Automations] llmConnection "${llmConnection}" not found, using default`)
      }
    }

    // Resolve @mentions to source/skill slugs
    const resolved = mentions ? this.resolveAutomationMentions(workspaceRootPath, mentions) : undefined

    // Ensure labels exist in workspace config before assigning to session
    const resolvedLabels = labels?.length
      ? ensureLabelsExist(workspaceRootPath, labels)
      : labels

    // Use automation name if provided, otherwise fall back to prompt snippet
    const fallback = `Automation: ${prompt.slice(0, 50)}${prompt.length > 50 ? '...' : ''}`
    const sessionName = automationName || fallback

    // Create a new session for this automation
    const session = await this.deps.createSession(workspaceId, {
      name: sessionName,
      labels: resolvedLabels,
      permissionMode: permissionMode || 'safe',
      enabledSourceSlugs: resolved?.sourceSlugs,
      llmConnection,
      model,
      thinkingLevel,
    })

    // Populate triggeredBy metadata so title generation is explicitly skipped
    // and the session is identifiable as automation-initiated after reload
    const managed = this.deps.getSession(session.id)
    if (managed) {
      managed.triggeredBy = { automationName, timestamp: Date.now() }
      this.deps.persistSession(managed)
    }

    // Notify renderer to hydrate full session metadata (including title)
    // before streaming events arrive. Without this, the renderer may create
    // a synthetic empty session and temporarily show "New chat".
    this.deps.sendEvent({ type: 'session_created', sessionId: session.id }, workspaceId)

    // Send the prompt
    await this.deps.sendMessage(session.id, prompt)

    return { sessionId: session.id }
  }

  /**
   * Resolve @mentions in automation prompts to source and skill slugs.
   */
  resolveAutomationMentions(workspaceRootPath: string, mentions: string[]): { sourceSlugs: string[]; skillSlugs: string[] } | undefined {
    const sources = loadWorkspaceSources(workspaceRootPath)
    const skills = loadAllSkills(workspaceRootPath)
    const sourceSlugs: string[] = []
    const skillSlugs: string[] = []

    for (const mention of mentions) {
      if (sources.some(s => s.config.slug === mention)) {
        sourceSlugs.push(mention)
      } else if (skills.some(s => s.slug === mention)) {
        skillSlugs.push(mention)
      } else {
        log.warn(`[Automations] Unknown mention: @${mention}`)
      }
    }

    return (sourceSlugs.length > 0 || skillSlugs.length > 0) ? { sourceSlugs, skillSlugs } : undefined
  }

  // ========================================================================
  // Workspace / active-session queries
  // ========================================================================

  getWorkspaces(): Workspace[] {
    return getWorkspaces()
  }

  getWorkspacesInfo(): WorkspaceInfo[] {
    return getWorkspaces().map(({ rootPath, createdAt, ...info }) => info)
  }

  getActiveSessionCount(workspaceId?: string): number {
    let count = 0
    for (const managed of this.deps.getAllSessions()) {
      if (workspaceId && managed.workspace.id !== workspaceId) continue
      if (managed.isProcessing) count++
    }
    return count
  }

  getWorkspaceAutomationSummary(workspaceId: string): { automationCount: number; schedulerRunning: boolean } {
    const workspace = getWorkspaceByNameOrId(workspaceId)
    if (!workspace) return { automationCount: 0, schedulerRunning: false }

    const automationSystem = this.automationSystems.get(workspace.rootPath)
    if (!automationSystem) return { automationCount: 0, schedulerRunning: false }

    const config = automationSystem.getConfig()
    let automationCount = 0
    if (config) {
      for (const matchers of Object.values(config.automations)) {
        automationCount += matchers?.length ?? 0
      }
    }

    return {
      automationCount,
      // SchedulerService is running if the system was created with enableScheduler
      schedulerRunning: !automationSystem.isDisposed(),
    }
  }

  getActiveSessionsInfo(): ActiveSessionInfo[] {
    const result: ActiveSessionInfo[] = []
    for (const managed of this.deps.getAllSessions()) {
      if (!managed.isProcessing) continue

      let status: SessionProcessingStatus = 'processing'
      if (managed.stopRequested) status = 'idle'

      result.push({
        sessionId: managed.id,
        workspaceId: managed.workspace.id,
        workspaceName: managed.workspace.name,
        title: managed.name || undefined,
        status,
        triggeredBy: managed.triggeredBy
          ? { automationName: managed.triggeredBy.automationName ?? 'Unknown', timestamp: managed.triggeredBy.timestamp ?? 0 }
          : undefined,
        createdAt: managed.lastMessageAt,
      })
    }
    return result
  }

  // ========================================================================
  // Cleanup
  // ========================================================================

  /**
   * Stop all ConfigWatchers and dispose all AutomationSystems.
   * Should be called on app shutdown to prevent resource leaks.
   */
  cleanup(): void {
    log.info('Cleaning up workspace runtime resources...')

    // Stop all ConfigWatchers (file system watchers)
    for (const [path, watcher] of this.configWatchers) {
      watcher.stop()
      log.info(`Stopped config watcher for ${path}`)
    }
    this.configWatchers.clear()

    // Dispose all AutomationSystems (includes scheduler, handlers, and event loggers)
    for (const [workspacePath, automationSystem] of this.automationSystems) {
      try {
        automationSystem.dispose()
        log.info(`Disposed AutomationSystem for ${workspacePath}`)
      } catch (error) {
        log.error(`Failed to dispose AutomationSystem for ${workspacePath}:`, error)
      }
    }
    this.automationSystems.clear()

    log.info('Workspace runtime cleanup complete')
  }
}
