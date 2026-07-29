import type { AgentEvent } from '@craft-agent/shared/agent'
import type { EventSink } from '@craft-agent/server-core/transport'
import type { LoadedSkill } from '@craft-agent/shared/skills'
import type { ThemeOverrides } from '@craft-agent/shared/config'
import type { LoadedSource } from '@craft-agent/shared/sources'
import type { Message } from '@craft-agent/core/types'
import { RPC_NAMESPACES, type SessionEvent, type UnreadSummary } from '@craft-agent/shared/protocol'

interface PendingDelta {
  delta: string
  turnId?: string
}

/**
 * The slice of a managed session this module needs to address an event: an
 * identity plus the workspace the event is scoped to. Declared structurally —
 * like `StoreManagedSession` — so the publisher never depends on
 * `SessionManager`'s full session record.
 */
export interface PublisherSession {
  readonly id: string
  readonly workspace: { readonly id: string }
  /** Kept in sync by {@link SessionEventPublisher.asyncOperation}. */
  isAsyncOperationOngoing?: boolean
}

/** A `SessionEvent` variant. */
type EventOf<T extends SessionEvent['type']> = Extract<SessionEvent, { type: T }>

/** A `SessionEvent` variant minus the fields the publisher fills in itself. */
type EventBody<T extends SessionEvent['type']> = Omit<EventOf<T>, 'type' | 'sessionId'>

/**
 * Agent-side background-task and team events forwarded to the renderer
 * verbatim, re-keyed to the owning session.
 */
type ForwardedAgentEvent = Extract<
  AgentEvent,
  {
    type:
      | 'task_backgrounded'
      | 'task_progress'
      | 'task_completed'
      | 'shell_backgrounded'
      | 'workflow_agent_completed'
      | 'team_task_created'
      | 'team_task_completed'
      | 'teammate_idle'
  }
>

export interface SessionEventPublisherOptions {
  batchIntervalMs?: number
  warn?: (message: string) => void
}

/**
 * Owns every server → renderer emission for the sessions domain.
 *
 * Callers state *what happened* (`titleGenerated`, `connectionChanged`,
 * `turnComplete`); this module owns the wire shape, the workspace scoping and
 * the text-delta batching. `publish` and the channel-level `publish*` helpers
 * stay public for the transport-level tests, but domain code should reach for
 * the named operations below so no `SessionEvent` payload is built outside
 * this file.
 */
export class SessionEventPublisher {
  private readonly batchIntervalMs: number
  private readonly warn: (message: string) => void
  private eventSink: EventSink | null = null
  private pendingDeltas = new Map<string, PendingDelta>()
  private deltaFlushTimers = new Map<string, NodeJS.Timeout>()

  constructor(options: SessionEventPublisherOptions = {}) {
    this.batchIntervalMs = options.batchIntervalMs ?? 50
    this.warn = options.warn ?? (() => {})
  }

  // ── Transport ───────────────────────────────────────────────────────────────

  setSink(sink: EventSink): void {
    this.eventSink = sink
  }

  /** True once a transport is attached; broadcasts before that are dropped. */
  hasSink(): boolean {
    return this.eventSink !== null
  }

  publish(event: SessionEvent, workspaceId?: string): void {
    if ('sessionId' in event && typeof event.sessionId === 'string') {
      this.flushTextDelta(event.sessionId, workspaceId)
    }

    if (!this.eventSink) {
      this.warn('Cannot send event - no event sink')
      return
    }

    if (!workspaceId) {
      this.warn(`Cannot send ${event.type} event - no workspaceId`)
      return
    }

    this.eventSink(RPC_NAMESPACES.sessions.EVENT, { to: 'workspace', workspaceId }, event)
  }

  publishToClient(clientId: string, event: SessionEvent): void {
    this.eventSink?.(RPC_NAMESPACES.sessions.EVENT, { to: 'client', clientId }, event)
  }

  publishWorkspaceChanged(channel: string, workspaceId: string, ...payload: unknown[]): void {
    this.eventSink?.(channel, { to: 'workspace', workspaceId }, ...payload)
  }

  publishAll(channel: string, ...payload: unknown[]): void {
    this.eventSink?.(channel, { to: 'all' }, ...payload)
  }

  publishClient(channel: string, clientId: string, ...payload: unknown[]): void {
    this.eventSink?.(channel, { to: 'client', clientId }, ...payload)
  }

  /** Emit into a session's workspace. Every domain operation funnels here. */
  private emit(session: PublisherSession, event: SessionEvent): void {
    this.publish(event, session.workspace.id)
  }

  // ── Session header ──────────────────────────────────────────────────────────

  sessionCreated(sessionId: string, workspaceId: string): void {
    this.publish({ type: 'session_created', sessionId }, workspaceId)
  }

  sessionDeleted(session: PublisherSession): void {
    this.emit(session, { type: 'session_deleted', sessionId: session.id })
  }

  nameChanged(session: PublisherSession, name: EventBody<'name_changed'>['name']): void {
    this.emit(session, { type: 'name_changed', sessionId: session.id, name })
  }

  titleGenerated(session: PublisherSession, title: string): void {
    this.emit(session, { type: 'title_generated', sessionId: session.id, title })
  }

  titleRegenerating(session: PublisherSession, isRegenerating: boolean): void {
    this.emit(session, { type: 'title_regenerating', sessionId: session.id, isRegenerating })
  }

  labelsChanged(session: PublisherSession, labels: string[]): void {
    this.emit(session, { type: 'labels_changed', sessionId: session.id, labels })
  }

  /** `session_flagged` / `session_unflagged` — one polarity, one call. */
  flagChanged(session: PublisherSession, isFlagged: boolean): void {
    this.emit(session, { type: isFlagged ? 'session_flagged' : 'session_unflagged', sessionId: session.id })
  }

  /** `session_archived` / `session_unarchived`. */
  archiveChanged(session: PublisherSession, isArchived: boolean): void {
    this.emit(session, { type: isArchived ? 'session_archived' : 'session_unarchived', sessionId: session.id })
  }

  /** `session_shared` with the new URL, or `session_unshared` when revoked. */
  shareChanged(session: PublisherSession, sharedUrl: string | null): void {
    this.emit(session, sharedUrl === null
      ? { type: 'session_unshared', sessionId: session.id }
      : { type: 'session_shared', sessionId: session.id, sharedUrl })
  }

  sessionStatusChanged(
    session: PublisherSession,
    sessionStatus: EventBody<'session_status_changed'>['sessionStatus'],
  ): void {
    this.emit(session, { type: 'session_status_changed', sessionId: session.id, sessionStatus })
  }

  projectIdChanged(session: PublisherSession, projectId: string | null): void {
    this.emit(session, { type: 'project_id_changed', sessionId: session.id, projectId })
  }

  metadataChanged(session: PublisherSession, changes: EventBody<'session_metadata_changed'>['changes']): void {
    this.emit(session, { type: 'session_metadata_changed', sessionId: session.id, changes })
  }

  workingDirectoryChanged(session: PublisherSession, workingDirectory: string): void {
    this.emit(session, { type: 'working_directory_changed', sessionId: session.id, workingDirectory })
  }

  workingDirectoryError(session: PublisherSession, error: string): void {
    this.emit(session, { type: 'working_directory_error', sessionId: session.id, error })
  }

  modelChanged(session: PublisherSession, model: string | null): void {
    this.emit(session, { type: 'session_model_changed', sessionId: session.id, model })
  }

  connectionChanged(session: PublisherSession, connection: EventBody<'connection_changed'>): void {
    this.emit(session, { type: 'connection_changed', sessionId: session.id, ...connection })
  }

  hermesProfileChanged(session: PublisherSession, hermesProfile: string): void {
    this.emit(session, { type: 'hermes_profile_changed', sessionId: session.id, hermesProfile })
  }

  sourcesChanged(session: PublisherSession, enabledSourceSlugs: string[]): void {
    this.emit(session, { type: 'sources_changed', sessionId: session.id, enabledSourceSlugs })
  }

  /**
   * Shimmer state for long-running session operations (share, revoke, title
   * refresh). Owns the `isAsyncOperationOngoing` mirror so the flag and the
   * event cannot drift apart.
   */
  asyncOperation(session: PublisherSession, isOngoing: boolean): void {
    session.isAsyncOperationOngoing = isOngoing
    this.emit(session, { type: 'async_operation', sessionId: session.id, isOngoing })
  }

  // ── Turn & streaming ────────────────────────────────────────────────────────

  userMessage(
    session: PublisherSession,
    message: Message,
    status: EventBody<'user_message'>['status'],
    optimisticMessageId: string | undefined,
  ): void {
    this.emit(session, { type: 'user_message', sessionId: session.id, message, status, optimisticMessageId })
  }

  textComplete(session: PublisherSession, body: EventBody<'text_complete'>): void {
    this.emit(session, { type: 'text_complete', sessionId: session.id, ...body })
  }

  toolStart(session: PublisherSession, body: EventBody<'tool_start'>): void {
    this.emit(session, { type: 'tool_start', sessionId: session.id, ...body })
  }

  toolResult(session: PublisherSession, body: EventBody<'tool_result'>): void {
    this.emit(session, { type: 'tool_result', sessionId: session.id, ...body })
  }

  /** End-of-turn `complete`. */
  turnComplete(session: PublisherSession, body: EventBody<'complete'>): void {
    this.emit(session, { type: 'complete', sessionId: session.id, ...body })
  }

  /**
   * Turn interrupted. `queuedTexts` is echoed back so the UI can restore the
   * input field; `message` is omitted for a silent (redirect) interrupt.
   */
  interrupted(session: PublisherSession, queuedTexts: string[], message?: Message): void {
    this.emit(session, {
      type: 'interrupted',
      sessionId: session.id,
      ...(message ? { message } : {}),
      ...(queuedTexts.length > 0 ? { queuedMessages: queuedTexts } : {}),
    })
  }

  statusMessage(
    session: PublisherSession,
    message: string,
    statusType: EventBody<'status'>['statusType'],
  ): void {
    this.emit(session, { type: 'status', sessionId: session.id, message, statusType })
  }

  info(session: PublisherSession, message: string, extra?: Omit<EventBody<'info'>, 'message'>): void {
    this.emit(session, { type: 'info', sessionId: session.id, message, ...extra })
  }

  error(session: PublisherSession, error: string, extra?: Omit<EventBody<'error'>, 'error'>): void {
    this.emit(session, { type: 'error', sessionId: session.id, error, ...extra })
  }

  typedError(
    session: PublisherSession,
    error: EventBody<'typed_error'>['error'],
    extra?: Omit<EventBody<'typed_error'>, 'error'>,
  ): void {
    this.emit(session, { type: 'typed_error', sessionId: session.id, error, ...extra })
  }

  usageUpdate(session: PublisherSession, tokenUsage: EventBody<'usage_update'>['tokenUsage']): void {
    this.emit(session, { type: 'usage_update', sessionId: session.id, tokenUsage })
  }

  messageAnnotationsUpdated(
    session: PublisherSession,
    messageId: string,
    annotations: EventBody<'message_annotations_updated'>['annotations'],
  ): void {
    this.emit(session, { type: 'message_annotations_updated', sessionId: session.id, messageId, annotations })
  }

  sourceActivated(session: PublisherSession, sourceSlug: string, originalMessage: string): void {
    this.emit(session, { type: 'source_activated', sessionId: session.id, sourceSlug, originalMessage })
  }

  shellKilled(session: PublisherSession, shellId: string): void {
    this.emit(session, { type: 'shell_killed', sessionId: session.id, shellId })
  }

  /** Re-key an agent background-task/workflow event to the session, verbatim. */
  forwardBackgroundTaskEvent(session: PublisherSession, event: ForwardedAgentEvent): void {
    this.emit(session, { ...event, sessionId: session.id })
  }

  // ── Permissions & auth ──────────────────────────────────────────────────────

  permissionRequest(session: PublisherSession, request: EventBody<'permission_request'>['request']): void {
    this.emit(session, { type: 'permission_request', sessionId: session.id, request })
  }

  /**
   * Projects the mode-manager diagnostics record onto the wire event — the
   * `lastChangedBy`/`lastChangedAt` → `changedBy`/`changedAt` rename lives
   * here rather than at each mutation site.
   */
  permissionModeChanged(
    session: PublisherSession,
    permissionMode: EventBody<'permission_mode_changed'>['permissionMode'],
    diagnostics: {
      modeVersion?: EventBody<'permission_mode_changed'>['modeVersion']
      lastChangedAt?: EventBody<'permission_mode_changed'>['changedAt']
      lastChangedBy?: EventBody<'permission_mode_changed'>['changedBy']
      previousPermissionMode?: EventBody<'permission_mode_changed'>['previousPermissionMode']
      transitionDisplay?: EventBody<'permission_mode_changed'>['transitionDisplay']
    },
  ): void {
    this.emit(session, {
      type: 'permission_mode_changed',
      sessionId: session.id,
      permissionMode,
      modeVersion: diagnostics.modeVersion,
      changedBy: diagnostics.lastChangedBy,
      changedAt: diagnostics.lastChangedAt,
      previousPermissionMode: diagnostics.previousPermissionMode,
      transitionDisplay: diagnostics.transitionDisplay,
    })
  }

  planSubmitted(session: PublisherSession, message: Message): void {
    this.emit(session, { type: 'plan_submitted', sessionId: session.id, message })
  }

  authRequest(
    session: PublisherSession,
    message: Message,
    request: EventBody<'auth_request'>['request'],
  ): void {
    this.emit(session, { type: 'auth_request', sessionId: session.id, message, request })
  }

  authCompleted(session: PublisherSession, result: EventBody<'auth_completed'>): void {
    this.emit(session, { type: 'auth_completed', sessionId: session.id, ...result })
  }

  // ── Client-scoped session events ────────────────────────────────────────────

  /** Failure of a client-initiated send, delivered back to that client only. */
  clientSendFailed(clientId: string, sessionId: string, error: string): void {
    this.publishToClient(clientId, { type: 'error', sessionId, error })
    this.publishToClient(clientId, { type: 'complete', sessionId })
  }

  sessionFilesChanged(clientId: string, sessionId: string): void {
    this.publishClient(RPC_NAMESPACES.sessions.FILES_CHANGED, clientId, sessionId)
  }

  // ── Workspace & global broadcasts ───────────────────────────────────────────

  unreadSummaryChanged(summary: UnreadSummary): void {
    this.publishAll(RPC_NAMESPACES.sessions.UNREAD_SUMMARY_CHANGED, summary)
  }

  workspaceSourcesChanged(workspaceId: string, sources: LoadedSource[]): void {
    this.publishWorkspaceChanged(RPC_NAMESPACES.sources.CHANGED, workspaceId, workspaceId, sources)
  }

  workspaceStatusesChanged(workspaceId: string): void {
    this.publishWorkspaceChanged(RPC_NAMESPACES.statuses.CHANGED, workspaceId, workspaceId)
  }

  workspaceLabelsChanged(workspaceId: string): void {
    this.publishWorkspaceChanged(RPC_NAMESPACES.labels.CHANGED, workspaceId, workspaceId)
  }

  workspaceAutomationsChanged(workspaceId: string): void {
    this.publishWorkspaceChanged(RPC_NAMESPACES.automations.CHANGED, workspaceId, workspaceId)
  }

  workspaceSkillsChanged(workspaceId: string, skills: LoadedSkill[]): void {
    this.publishWorkspaceChanged(RPC_NAMESPACES.skills.CHANGED, workspaceId, workspaceId, skills)
  }

  appThemeChanged(theme: ThemeOverrides | null): void {
    this.publishAll(RPC_NAMESPACES.theme.APP_CHANGED, theme)
  }

  llmConnectionsChanged(): void {
    this.publishAll(RPC_NAMESPACES.llmConnections.CHANGED)
  }

  defaultPermissionsChanged(): void {
    this.publishAll(RPC_NAMESPACES.permissions.DEFAULTS_CHANGED, null)
  }

  // ── Text-delta batching ─────────────────────────────────────────────────────

  queueTextDelta(sessionId: string, workspaceId: string, delta: string, turnId?: string): void {
    const existing = this.pendingDeltas.get(sessionId)
    if (existing) {
      existing.delta += delta
      if (turnId) existing.turnId = turnId
    } else {
      this.pendingDeltas.set(sessionId, { delta, turnId })
    }

    if (!this.deltaFlushTimers.has(sessionId)) {
      const timer = setTimeout(() => {
        this.flushTextDelta(sessionId, workspaceId)
      }, this.batchIntervalMs)
      this.deltaFlushTimers.set(sessionId, timer)
    }
  }

  flushTextDelta(sessionId: string, workspaceId?: string): void {
    const timer = this.deltaFlushTimers.get(sessionId)
    if (timer) {
      clearTimeout(timer)
      this.deltaFlushTimers.delete(sessionId)
    }

    const pending = this.pendingDeltas.get(sessionId)
    if (!pending?.delta) return

    this.pendingDeltas.delete(sessionId)
    this.publish({
      type: 'text_delta',
      sessionId,
      delta: pending.delta,
      turnId: pending.turnId,
    }, workspaceId)
  }

  cleanupSession(sessionId: string): void {
    clearTimeout(this.deltaFlushTimers.get(sessionId))
    this.deltaFlushTimers.delete(sessionId)
    this.pendingDeltas.delete(sessionId)
  }

  cleanup(): void {
    for (const timer of this.deltaFlushTimers.values()) {
      clearTimeout(timer)
    }
    this.deltaFlushTimers.clear()
    this.pendingDeltas.clear()
  }
}
