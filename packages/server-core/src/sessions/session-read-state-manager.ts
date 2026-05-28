/**
 * SessionReadStateManager — extracted metadata/read-unread/sharing methods from SessionManager.
 *
 * Owns state:
 *   - activeViewingSession: Map<string, string>  (workspaceId -> sessionId)
 *
 * ADDITIVE extraction: SessionManager still holds the canonical implementation.
 * This module is the standalone, dependency-injected equivalent.
 */

import type { SessionEvent } from '@craft-agent/shared/protocol'
import type { Message } from '@craft-agent/core/types'
import type { SessionStatus, SessionHeader } from '@craft-agent/shared/sessions'
import { updateSessionMetadata, loadSession as loadStoredSession } from '@craft-agent/shared/sessions'
import {
  setPendingPlanExecution as setStoredPendingPlanExecution,
  markCompactionComplete as markStoredCompactionComplete,
  markPendingPlanExecutionDispatched as markStoredPendingPlanExecutionDispatched,
  clearPendingPlanExecution as clearStoredPendingPlanExecution,
  getPendingPlanExecution as getStoredPendingPlanExecution,
} from '@craft-agent/shared/sessions'
import { createScopedLogger, CONSOLE_LOGGER, type Logger } from '@craft-agent/server-core/runtime'
import { i18n, LOCALE_REGISTRY, type LanguageCode } from '@craft-agent/shared/i18n'

// ── Constants ──────────────────────────────────────────────────────────
const MAX_ANNOTATIONS_PER_MESSAGE = 200
const MAX_ANNOTATION_JSON_BYTES = 32 * 1024

// ── Lightweight session shape required by this module ──────────────────
/** Minimal managed session surface consumed by read-state methods. */
export interface ReadStateManagedSession {
  id: string
  workspace: { id: string; rootPath: string }
  agent: {
    regenerateTitle(userMessages: string[], assistantResponse: string, options?: { language?: string }): Promise<string | null>
    setModel(model: string): void
    destroy(): void
    postInit(): Promise<unknown>
    markSourceUnseen?(slug: string): void
  } | null
  messages: Message[]
  isProcessing: boolean
  name?: string
  isFlagged: boolean
  isArchived?: boolean
  archivedAt?: number
  sessionStatus?: string
  lastReadMessageId?: string
  hasUnread?: boolean
  hidden?: boolean
  sharedUrl?: string
  sharedId?: string
  isAsyncOperationOngoing?: boolean
  model?: string
  llmConnection?: string
  connectionLocked?: boolean
  hermesProfile?: string
  enabledSourceSlugs?: string[]
  labels?: string[]
  _metadataWriteGuardUntil?: number
  permissionMode?: string
  systemPromptPreset?: 'default' | 'mini' | string
  tokenRefreshManager: { clearCooldown(slug: string): void }
}

// ── Deps interface ─────────────────────────────────────────────────────
export interface SessionReadStateDeps {
  getSession(sessionId: string): ReadStateManagedSession | undefined
  getSessionsByWorkspace(workspaceId: string): ReadStateManagedSession[]
  getAllSessions(): Iterable<ReadStateManagedSession>
  persistSession(managed: ReadStateManagedSession): void
  flushSession(sessionId: string): Promise<void>
  sendEvent(event: SessionEvent, workspaceId?: string): void
  ensureMessagesLoaded(managed: ReadStateManagedSession): Promise<void>
  /** Broadcast global unread summary to badge + renderers */
  broadcastUnreadSummary(summary: UnreadSummary): void
  /** Runtime hook: update OS badge count */
  updateBadgeCount(count: number): void
  /** Get all workspace objects for unread aggregation */
  getWorkspaces(): Array<{ id: string }>
  /** Monotonic timestamp generator */
  monotonic(): number
  /** Config watcher for fs.watch workaround */
  getConfigWatcher(rootPath: string): { notifyFileChange(path: string): void } | undefined
}

// ── Types ──────────────────────────────────────────────────────────────
export interface UnreadSummary {
  totalUnreadSessions: number
  byWorkspace: Record<string, number>
  hasUnreadByWorkspace: Record<string, boolean>
}

// ── Logger ─────────────────────────────────────────────────────────────
let log: Logger = createScopedLogger(CONSOLE_LOGGER, 'session-readstate')

export function setReadStateLogger(logger: Logger): void {
  log = createScopedLogger(logger, 'session-readstate')
}

// ── Class ──────────────────────────────────────────────────────────────
export class SessionReadStateManager {
  // ── Owned state ──────────────────────────────────────────────────────
  /**
   * Track which session the user is actively viewing (per workspace).
   * Map of workspaceId -> sessionId.
   */
  private activeViewingSession: Map<string, string> = new Map()

  constructor(private readonly deps: SessionReadStateDeps) {}

  // ── Flag / Archive ───────────────────────────────────────────────────

  async flagSession(sessionId: string): Promise<void> {
    const managed = this.deps.getSession(sessionId)
    if (managed) {
      managed.isFlagged = true
      this.deps.persistSession(managed)
      await this.deps.flushSession(managed.id)
      this.deps.sendEvent({ type: 'session_flagged', sessionId } as SessionEvent, managed.workspace.id)
      const watcher = this.deps.getConfigWatcher(managed.workspace.rootPath)
      watcher?.notifyFileChange(`sessions/${sessionId}/session.jsonl`)
    }
  }

  async unflagSession(sessionId: string): Promise<void> {
    const managed = this.deps.getSession(sessionId)
    if (managed) {
      managed.isFlagged = false
      this.deps.persistSession(managed)
      await this.deps.flushSession(managed.id)
      this.deps.sendEvent({ type: 'session_unflagged', sessionId } as SessionEvent, managed.workspace.id)
      const watcher = this.deps.getConfigWatcher(managed.workspace.rootPath)
      watcher?.notifyFileChange(`sessions/${sessionId}/session.jsonl`)
    }
  }

  async archiveSession(sessionId: string): Promise<void> {
    const managed = this.deps.getSession(sessionId)
    if (managed) {
      managed.isArchived = true
      managed.archivedAt = Date.now()
      this.deps.persistSession(managed)
      await this.deps.flushSession(managed.id)
      this.deps.sendEvent({ type: 'session_archived', sessionId } as SessionEvent, managed.workspace.id)
      this.emitUnreadSummaryChanged()
    }
  }

  async unarchiveSession(sessionId: string): Promise<void> {
    const managed = this.deps.getSession(sessionId)
    if (managed) {
      managed.isArchived = false
      managed.archivedAt = undefined
      this.deps.persistSession(managed)
      await this.deps.flushSession(managed.id)
      this.deps.sendEvent({ type: 'session_unarchived', sessionId } as SessionEvent, managed.workspace.id)
      this.emitUnreadSummaryChanged()
    }
  }

  // ── Session status / connection / Hermes profile ─────────────────────

  async setSessionStatus(sessionId: string, sessionStatus: SessionStatus): Promise<void> {
    const managed = this.deps.getSession(sessionId)
    if (managed) {
      managed.sessionStatus = sessionStatus
      managed._metadataWriteGuardUntil = Date.now() + 5000
      this.deps.persistSession(managed)
      await this.deps.flushSession(managed.id)
      this.deps.sendEvent({ type: 'session_status_changed', sessionId, sessionStatus } as SessionEvent, managed.workspace.id)
      const watcher = this.deps.getConfigWatcher(managed.workspace.rootPath)
      watcher?.notifyFileChange(`sessions/${sessionId}/session.jsonl`)
    }
  }

  async setSessionConnection(sessionId: string, connectionSlug: string): Promise<void> {
    const managed = this.deps.getSession(sessionId)
    if (!managed) {
      log.warn(`setSessionConnection: session ${sessionId} not found`)
      throw new Error(`Session ${sessionId} not found`)
    }

    if (managed.messages && managed.messages.length > 0) {
      log.warn(`setSessionConnection: cannot change connection after session has started (${sessionId})`)
      throw new Error('Cannot change connection after session has started')
    }

    const { getLlmConnection } = await import('@craft-agent/shared/config/storage')
    const connection = getLlmConnection(connectionSlug)
    if (!connection) {
      log.warn(`setSessionConnection: connection "${connectionSlug}" not found`)
      throw new Error(`LLM connection "${connectionSlug}" not found`)
    }

    managed.llmConnection = connectionSlug
    this.deps.persistSession(managed)
    await this.deps.flushSession(managed.id)
    log.info(`Set LLM connection for session ${sessionId} to ${connectionSlug}`)

    this.deps.sendEvent({
      type: 'connection_changed',
      sessionId,
      connectionSlug,
    } as SessionEvent, managed.workspace.id)
  }

  async setSessionHermesProfile(sessionId: string, profileName: string): Promise<void> {
    const managed = this.deps.getSession(sessionId)
    if (!managed) {
      log.warn(`setSessionHermesProfile: session ${sessionId} not found`)
      throw new Error(`Session ${sessionId} not found`)
    }

    const target = profileName.trim() || 'default'

    if ((managed as { hermesProfile?: string }).hermesProfile === target) {
      return
    }

    ;(managed as { hermesProfile?: string }).hermesProfile = target

    this.deps.persistSession(managed)
    await this.deps.flushSession(managed.id)
    log.info(`Set Hermes profile for session ${sessionId} to "${target}"`)

    this.deps.sendEvent({
      type: 'hermes_profile_changed',
      sessionId,
      hermesProfile: target,
    } as SessionEvent, managed.workspace.id)
  }

  // ── Pending plan execution ───────────────────────────────────────────

  async setPendingPlanExecution(sessionId: string, planPath: string, draftInputSnapshot?: string): Promise<void> {
    const managed = this.deps.getSession(sessionId)
    if (managed) {
      await setStoredPendingPlanExecution(managed.workspace.rootPath, sessionId, planPath, draftInputSnapshot)
      log.info(`Session ${sessionId}: set pending plan execution for ${planPath}`)
    }
  }

  async markCompactionComplete(sessionId: string): Promise<void> {
    const managed = this.deps.getSession(sessionId)
    if (managed) {
      await markStoredCompactionComplete(managed.workspace.rootPath, sessionId)
      log.info(`Session ${sessionId}: compaction marked complete for pending plan`)
    }
  }

  async markPendingPlanExecutionDispatched(sessionId: string): Promise<void> {
    const managed = this.deps.getSession(sessionId)
    if (managed) {
      await markStoredPendingPlanExecutionDispatched(managed.workspace.rootPath, sessionId)
      log.info(`Session ${sessionId}: marked pending plan execution as dispatched`)
    }
  }

  async clearPendingPlanExecution(sessionId: string): Promise<void> {
    const managed = this.deps.getSession(sessionId)
    if (managed) {
      await clearStoredPendingPlanExecution(managed.workspace.rootPath, sessionId)
      log.info(`Session ${sessionId}: cleared pending plan execution`)
    }
  }

  getPendingPlanExecution(sessionId: string): { planPath: string; draftInputSnapshot?: string; awaitingCompaction: boolean; executionDispatched: boolean } | null {
    const managed = this.deps.getSession(sessionId)
    if (!managed) return null
    return getStoredPendingPlanExecution(managed.workspace.rootPath, sessionId)
  }

  // ── Sharing ──────────────────────────────────────────────────────────

  async shareToViewer(sessionId: string): Promise<{ success: boolean; url?: string; error?: string }> {
    const managed = this.deps.getSession(sessionId)
    if (!managed) {
      return { success: false, error: 'Session not found' }
    }

    managed.isAsyncOperationOngoing = true
    this.deps.sendEvent({ type: 'async_operation', sessionId, isOngoing: true } as SessionEvent, managed.workspace.id)

    try {
      const storedSession = loadStoredSession(managed.workspace.rootPath, sessionId)
      if (!storedSession) {
        return { success: false, error: 'Session file not found' }
      }

      const { VIEWER_URL } = await import('@craft-agent/shared/branding')
      const response = await fetch(`${VIEWER_URL}/s/api`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(storedSession),
      })

      if (!response.ok) {
        log.error(`Share failed with status ${response.status}`)
        if (response.status === 413) {
          return { success: false, error: 'Session file is too large to share' }
        }
        return { success: false, error: 'Failed to upload session' }
      }

      const data = await response.json() as { id: string; url: string }

      managed.sharedUrl = data.url
      managed.sharedId = data.id
      await updateSessionMetadata(managed.workspace.rootPath, sessionId, {
        sharedUrl: data.url,
        sharedId: data.id,
      })

      log.info(`Session ${sessionId} shared at ${data.url}`)
      this.deps.sendEvent({ type: 'session_shared', sessionId, sharedUrl: data.url } as SessionEvent, managed.workspace.id)
      return { success: true, url: data.url }
    } catch (error) {
      log.error('Share error:', error)
      return { success: false, error: error instanceof Error ? error.message : 'Unknown error' }
    } finally {
      managed.isAsyncOperationOngoing = false
      this.deps.sendEvent({ type: 'async_operation', sessionId, isOngoing: false } as SessionEvent, managed.workspace.id)
    }
  }

  async updateShare(sessionId: string): Promise<{ success: boolean; url?: string; error?: string }> {
    const managed = this.deps.getSession(sessionId)
    if (!managed) {
      return { success: false, error: 'Session not found' }
    }
    if (!managed.sharedId) {
      return { success: false, error: 'Session not shared' }
    }

    managed.isAsyncOperationOngoing = true
    this.deps.sendEvent({ type: 'async_operation', sessionId, isOngoing: true } as SessionEvent, managed.workspace.id)

    try {
      const storedSession = loadStoredSession(managed.workspace.rootPath, sessionId)
      if (!storedSession) {
        return { success: false, error: 'Session file not found' }
      }

      const { VIEWER_URL } = await import('@craft-agent/shared/branding')
      const response = await fetch(`${VIEWER_URL}/s/api/${managed.sharedId}`, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(storedSession),
      })

      if (!response.ok) {
        log.error(`Update share failed with status ${response.status}`)
        if (response.status === 413) {
          return { success: false, error: 'Session file is too large to share' }
        }
        return { success: false, error: 'Failed to update shared session' }
      }

      log.info(`Session ${sessionId} share updated at ${managed.sharedUrl}`)
      return { success: true, url: managed.sharedUrl }
    } catch (error) {
      log.error('Update share error:', error)
      return { success: false, error: error instanceof Error ? error.message : 'Unknown error' }
    } finally {
      managed.isAsyncOperationOngoing = false
      this.deps.sendEvent({ type: 'async_operation', sessionId, isOngoing: false } as SessionEvent, managed.workspace.id)
    }
  }

  async revokeShare(sessionId: string): Promise<{ success: boolean; error?: string }> {
    const managed = this.deps.getSession(sessionId)
    if (!managed) {
      return { success: false, error: 'Session not found' }
    }
    if (!managed.sharedId) {
      return { success: false, error: 'Session not shared' }
    }

    managed.isAsyncOperationOngoing = true
    this.deps.sendEvent({ type: 'async_operation', sessionId, isOngoing: true } as SessionEvent, managed.workspace.id)

    try {
      const { VIEWER_URL } = await import('@craft-agent/shared/branding')
      const response = await fetch(
        `${VIEWER_URL}/s/api/${managed.sharedId}`,
        { method: 'DELETE' }
      )

      if (!response.ok) {
        log.error(`Revoke failed with status ${response.status}`)
        return { success: false, error: 'Failed to revoke share' }
      }

      delete managed.sharedUrl
      delete managed.sharedId
      await updateSessionMetadata(managed.workspace.rootPath, sessionId, {
        sharedUrl: undefined,
        sharedId: undefined,
      })

      log.info(`Session ${sessionId} share revoked`)
      this.deps.sendEvent({ type: 'session_unshared', sessionId } as SessionEvent, managed.workspace.id)
      return { success: true }
    } catch (error) {
      log.error('Revoke error:', error)
      return { success: false, error: error instanceof Error ? error.message : 'Unknown error' }
    } finally {
      managed.isAsyncOperationOngoing = false
      this.deps.sendEvent({ type: 'async_operation', sessionId, isOngoing: false } as SessionEvent, managed.workspace.id)
    }
  }

  // ── Active viewing / read-unread ─────────────────────────────────────

  setActiveViewingSession(sessionId: string | null, workspaceId: string): void {
    if (sessionId) {
      this.activeViewingSession.set(workspaceId, sessionId)
      const managed = this.deps.getSession(sessionId)
      if (managed && !managed.isProcessing && managed.hasUnread) {
        this.markSessionRead(sessionId)
      }
    } else {
      this.activeViewingSession.delete(workspaceId)
    }
  }

  clearActiveViewingSession(workspaceId: string): void {
    this.activeViewingSession.delete(workspaceId)
  }

  isSessionBeingViewed(sessionId: string, workspaceId: string): boolean {
    return this.activeViewingSession.get(workspaceId) === sessionId
  }

  async markSessionRead(sessionId: string): Promise<void> {
    const managed = this.deps.getSession(sessionId)
    if (!managed) return

    if (managed.isProcessing) return

    let needsPersist = false
    const updates: { lastReadMessageId?: string; hasUnread?: boolean } = {}

    if (managed.messages.length > 0) {
      const lastFinalId = this.getLastFinalAssistantMessageId(managed.messages)
      if (lastFinalId && managed.lastReadMessageId !== lastFinalId) {
        managed.lastReadMessageId = lastFinalId
        updates.lastReadMessageId = lastFinalId
        needsPersist = true
      }
    }

    if (managed.hasUnread) {
      managed.hasUnread = false
      updates.hasUnread = false
      needsPersist = true
    }

    if (needsPersist) {
      await updateSessionMetadata(managed.workspace.rootPath, sessionId, updates)
      this.emitUnreadSummaryChanged()
    }
  }

  async markSessionUnread(sessionId: string): Promise<void> {
    const managed = this.deps.getSession(sessionId)
    if (managed) {
      managed.hasUnread = true
      managed.lastReadMessageId = undefined
      await updateSessionMetadata(managed.workspace.rootPath, sessionId, { hasUnread: true, lastReadMessageId: undefined })
      this.emitUnreadSummaryChanged()
    }
  }

  async markAllSessionsRead(workspaceId: string): Promise<void> {
    const updates: Promise<void>[] = []
    for (const managed of this.deps.getAllSessions()) {
      if (managed.workspace.id !== workspaceId) continue
      if (managed.hidden || managed.isArchived) continue
      if (managed.isProcessing) continue
      if (!managed.hasUnread) continue
      managed.hasUnread = false
      updates.push(
        updateSessionMetadata(managed.workspace.rootPath, managed.id, { hasUnread: false })
      )
    }
    if (updates.length > 0) {
      await Promise.all(updates)
      this.emitUnreadSummaryChanged()
    }
  }

  // ── Rename / refresh title ───────────────────────────────────────────

  async renameSession(sessionId: string, name: string): Promise<void> {
    const managed = this.deps.getSession(sessionId)
    if (managed) {
      managed.name = name
      this.deps.persistSession(managed)
      this.deps.sendEvent({ type: 'title_generated', sessionId, title: name } as SessionEvent, managed.workspace.id)
      const watcher = this.deps.getConfigWatcher(managed.workspace.rootPath)
      watcher?.notifyFileChange(`sessions/${sessionId}/session.jsonl`)
    }
  }

  async refreshTitle(sessionId: string): Promise<{ success: boolean; title?: string; error?: string }> {
    log.info(`refreshTitle called for session ${sessionId}`)
    const managed = this.deps.getSession(sessionId)
    if (!managed) {
      log.warn(`refreshTitle: Session ${sessionId} not found`)
      return { success: false, error: 'Session not found' }
    }

    await this.deps.ensureMessagesLoaded(managed)

    const { selectSpreadMessages } = await import('@craft-agent/shared/utils')
    const allUserContents = managed.messages
      .filter((m) => m.role === 'user')
      .map((m) => m.content)
    const userMessages = selectSpreadMessages(allUserContents)

    log.info(`refreshTitle: Selected ${userMessages.length} spread messages from ${allUserContents.length} total`)

    if (userMessages.length === 0) {
      log.warn(`refreshTitle: No user messages found`)
      return { success: false, error: 'No user messages to generate title from' }
    }

    const lastAssistantMsg = managed.messages
      .filter((m) => m.role === 'assistant' && !m.isIntermediate)
      .slice(-1)[0]

    const assistantResponse = lastAssistantMsg?.content ?? ''

    const titleLangCode = (i18n.resolvedLanguage ?? 'en') as LanguageCode
    const titleLangEntry = LOCALE_REGISTRY[titleLangCode]
    const titleOptions = { language: titleLangEntry?.nativeName }

    if (!managed.agent) {
      log.warn(`refreshTitle: No agent for session ${sessionId}`)
      return { success: false, error: 'No agent available' }
    }

    managed.isAsyncOperationOngoing = true
    this.deps.sendEvent({ type: 'async_operation', sessionId, isOngoing: true } as SessionEvent, managed.workspace.id)
    this.deps.sendEvent({ type: 'title_regenerating', sessionId, isRegenerating: true } as SessionEvent, managed.workspace.id)

    try {
      const title = await managed.agent.regenerateTitle(userMessages, assistantResponse, titleOptions)
      log.info(`refreshTitle: regenerateTitle returned: ${title ? `"${title}"` : 'null'}`)
      if (title) {
        managed.name = title
        this.deps.persistSession(managed)
        this.deps.sendEvent({ type: 'title_generated', sessionId, title } as SessionEvent, managed.workspace.id)
        return { success: true, title }
      }
      return { success: false, error: 'Title generation returned null' }
    } catch (error) {
      log.error(`Failed to regenerate title for session ${sessionId}:`, error)
      return { success: false, error: error instanceof Error ? error.message : 'Unknown error' }
    } finally {
      managed.isAsyncOperationOngoing = false
      this.deps.sendEvent({ type: 'async_operation', sessionId, isOngoing: false } as SessionEvent, managed.workspace.id)
      this.deps.sendEvent({ type: 'title_regenerating', sessionId, isRegenerating: false } as SessionEvent, managed.workspace.id)
    }
  }

  // ── Annotations ──────────────────────────────────────────────────────

  addMessageAnnotation(sessionId: string, messageId: string, annotation: NonNullable<Message['annotations']>[number]): void {
    const managed = this.deps.getSession(sessionId)
    if (!managed) {
      log.warn(`Cannot add annotation: session ${sessionId} not found`)
      return
    }

    const message = managed.messages.find(m => m.id === messageId)
    if (!message) {
      log.warn(`Cannot add annotation: message ${messageId} not found in session ${sessionId}`)
      return
    }

    if (!annotation?.id || !annotation?.target?.selectors?.length) {
      log.warn(`Cannot add annotation: invalid annotation payload for message ${messageId}`)
      return
    }

    if (annotation.target.source.messageId !== messageId) {
      log.warn(`Cannot add annotation: target source.messageId mismatch (${annotation.target.source.messageId} !== ${messageId})`)
      return
    }

    const safeAnnotation: NonNullable<Message['annotations']>[number] = {
      ...annotation,
      schemaVersion: 1,
      target: {
        ...annotation.target,
        source: {
          ...annotation.target.source,
          sessionId,
          messageId,
        },
      },
    }

    const annotationBytes = Buffer.byteLength(JSON.stringify(safeAnnotation), 'utf8')
    if (annotationBytes > MAX_ANNOTATION_JSON_BYTES) {
      log.warn(`Cannot add annotation: payload too large (${annotationBytes} bytes > ${MAX_ANNOTATION_JSON_BYTES}) on message ${messageId}`)
      return
    }

    const existing = message.annotations ?? []
    if (existing.some(a => a.id === safeAnnotation.id)) {
      log.warn(`Cannot add annotation: duplicate annotation id ${safeAnnotation.id} on message ${messageId}`)
      return
    }

    if (existing.length >= MAX_ANNOTATIONS_PER_MESSAGE) {
      log.warn(`Cannot add annotation: per-message limit reached (${MAX_ANNOTATIONS_PER_MESSAGE}) on message ${messageId}`)
      return
    }

    message.annotations = [...existing, safeAnnotation]
    this.deps.persistSession(managed)
    this.deps.sendEvent({ type: 'message_annotations_updated', sessionId, messageId, annotations: message.annotations } as SessionEvent, managed.workspace.id)
  }

  updateMessageAnnotation(
    sessionId: string,
    messageId: string,
    annotationId: string,
    patch: Partial<NonNullable<Message['annotations']>[number]>,
  ): void {
    const managed = this.deps.getSession(sessionId)
    if (!managed) {
      log.warn(`Cannot update annotation: session ${sessionId} not found`)
      return
    }

    const message = managed.messages.find(m => m.id === messageId)
    if (!message) {
      log.warn(`Cannot update annotation: message ${messageId} not found in session ${sessionId}`)
      return
    }

    const existing = message.annotations ?? []
    const idx = existing.findIndex(a => a.id === annotationId)
    if (idx === -1) {
      log.warn(`Cannot update annotation: annotation ${annotationId} not found on message ${messageId}`)
      return
    }

    if (patch.target?.source?.messageId && patch.target.source.messageId !== messageId) {
      log.warn(`Cannot update annotation: target source.messageId mismatch in patch (${patch.target.source.messageId} !== ${messageId})`)
      return
    }

    if (patch.target?.selectors && patch.target.selectors.length === 0) {
      log.warn(`Cannot update annotation: empty selectors patch for annotation ${annotationId} on message ${messageId}`)
      return
    }

    const current = existing[idx]!
    const updated = {
      ...current,
      ...patch,
      id: current.id,
      schemaVersion: current.schemaVersion,
      target: patch.target
        ? {
            ...current.target,
            ...patch.target,
            source: {
              ...current.target.source,
              ...(patch.target.source ?? {}),
              sessionId,
              messageId,
            },
          }
        : {
            ...current.target,
            source: {
              ...current.target.source,
              sessionId,
              messageId,
            },
          },
      updatedAt: Date.now(),
    }

    const updatedBytes = Buffer.byteLength(JSON.stringify(updated), 'utf8')
    if (updatedBytes > MAX_ANNOTATION_JSON_BYTES) {
      log.warn(`Cannot update annotation: payload too large (${updatedBytes} bytes > ${MAX_ANNOTATION_JSON_BYTES}) for annotation ${annotationId} on message ${messageId}`)
      return
    }

    const next = [...existing]
    next[idx] = updated
    message.annotations = next
    this.deps.persistSession(managed)
    this.deps.sendEvent({ type: 'message_annotations_updated', sessionId, messageId, annotations: message.annotations } as SessionEvent, managed.workspace.id)
  }

  removeMessageAnnotation(sessionId: string, messageId: string, annotationId: string): void {
    const managed = this.deps.getSession(sessionId)
    if (!managed) {
      log.warn(`Cannot remove annotation: session ${sessionId} not found`)
      return
    }

    const message = managed.messages.find(m => m.id === messageId)
    if (!message) {
      log.warn(`Cannot remove annotation: message ${messageId} not found in session ${sessionId}`)
      return
    }

    const existing = message.annotations ?? []
    if (!existing.some(a => a.id === annotationId)) {
      log.warn(`Cannot remove annotation: annotation ${annotationId} not found on message ${messageId}`)
      return
    }

    message.annotations = existing.filter(a => a.id !== annotationId)
    this.deps.persistSession(managed)
    this.deps.sendEvent({ type: 'message_annotations_updated', sessionId, messageId, annotations: message.annotations } as SessionEvent, managed.workspace.id)
  }

  // ── Title generation ─────────────────────────────────────────────────

  async generateTitle(managed: ReadStateManagedSession, userMessage: string): Promise<void> {
    log.info(`[generateTitle] Starting for session ${managed.id}`)

    if (!managed.agent) {
      let attempts = 0
      while (!managed.agent && attempts < 10) {
        await new Promise(resolve => setTimeout(resolve, 100))
        attempts++
      }
    }

    if (!managed.agent) {
      log.warn(`[generateTitle] No agent for session ${managed.id}`)
      return
    }

    try {
      const genLangCode = (i18n.resolvedLanguage ?? 'en') as LanguageCode
      const genLangEntry = LOCALE_REGISTRY[genLangCode]
      const title = await (managed.agent as any).generateTitle(userMessage, { language: genLangEntry?.nativeName })
      if (title) {
        managed.name = title
        this.deps.persistSession(managed)
        await this.deps.flushSession(managed.id)
        this.deps.sendEvent({ type: 'title_generated', sessionId: managed.id, title } as SessionEvent, managed.workspace.id)
        log.info(`Generated title for session ${managed.id}: "${title}"`)
      } else {
        log.warn(`Title generation returned null for session ${managed.id}`)
      }
    } catch (error) {
      log.error(`Failed to generate title for session ${managed.id}:`, error)
    }
  }

  // ── Unread summary ───────────────────────────────────────────────────

  getUnreadSummary(): UnreadSummary {
    const byWorkspace: Record<string, number> = {}
    const hasUnreadByWorkspace: Record<string, boolean> = {}

    for (const workspace of this.deps.getWorkspaces()) {
      byWorkspace[workspace.id] = 0
      hasUnreadByWorkspace[workspace.id] = false
    }

    for (const session of this.deps.getAllSessions()) {
      if (session.hidden || session.isArchived) continue
      if (!session.hasUnread) continue

      const workspaceId = session.workspace.id
      byWorkspace[workspaceId] = (byWorkspace[workspaceId] ?? 0) + 1
      hasUnreadByWorkspace[workspaceId] = true
    }

    const totalUnreadSessions = Object.values(byWorkspace).reduce((sum, count) => sum + count, 0)

    return {
      totalUnreadSessions,
      byWorkspace,
      hasUnreadByWorkspace,
    }
  }

  refreshBadge(): void {
    const summary = this.getUnreadSummary()
    this.deps.updateBadgeCount(summary.totalUnreadSessions)
  }

  private emitUnreadSummaryChanged(): void {
    const summary = this.getUnreadSummary()
    this.deps.updateBadgeCount(summary.totalUnreadSessions)
    this.deps.broadcastUnreadSummary(summary)
  }

  // ── Model update ─────────────────────────────────────────────────────

  async updateSessionModel(sessionId: string, workspaceId: string, model: string | null, connection?: string): Promise<void> {
    log.info(`[updateSessionModel] sessionId=${sessionId}, model=${model}, connection=${connection}`)
    const managed = this.deps.getSession(sessionId)
    if (managed) {
      managed.model = model ?? undefined
      if (connection && !managed.connectionLocked) {
        managed.llmConnection = connection
      }
      const updates: { model?: string; llmConnection?: string } = { model: model ?? undefined }
      if (connection && !managed.connectionLocked) {
        updates.llmConnection = connection
      }
      await updateSessionMetadata(managed.workspace.rootPath, sessionId, updates)
      if (managed.agent) {
        const { loadWorkspaceConfig } = await import('@craft-agent/shared/workspaces')
        const { resolveSessionConnection } = await import('@craft-agent/shared/agent/backend')
        const wsConfig = loadWorkspaceConfig(managed.workspace.rootPath)
        const sessionConn = resolveSessionConnection(managed.llmConnection, wsConfig?.defaults?.defaultLlmConnection)
        const effectiveModel = model ?? wsConfig?.defaults?.model ?? sessionConn?.defaultModel!
        log.info(`[updateSessionModel] Calling agent.setModel(${effectiveModel}) [agent exists=${!!managed.agent}, connectionLocked=${managed.connectionLocked}]`)
        managed.agent.setModel(effectiveModel)
      } else {
        log.info(`[updateSessionModel] No agent yet, model will apply on next agent creation`)
      }
      this.deps.sendEvent({ type: 'session_model_changed', sessionId, model } as SessionEvent, managed.workspace.id)
      log.info(`Session ${sessionId} model updated to: ${model ?? '(global config)'}`)
    }
  }

  // ── External session metadata ────────────────────────────────────────

  applyExternalSessionMetadata(managed: ReadStateManagedSession, header: SessionHeader): boolean {
    const sessionId = managed.id
    let changed = false

    // Labels
    const oldLabels = JSON.stringify(managed.labels ?? [])
    const newLabels = JSON.stringify(header.labels ?? [])
    if (oldLabels !== newLabels) {
      managed.labels = header.labels
      this.deps.sendEvent({ type: 'labels_changed', sessionId, labels: header.labels ?? [] } as SessionEvent, managed.workspace.id)
      changed = true
    }

    // Session status
    if (header.sessionStatus !== undefined && managed.sessionStatus !== header.sessionStatus) {
      managed.sessionStatus = header.sessionStatus
      this.deps.sendEvent({ type: 'session_status_changed', sessionId, sessionStatus: header.sessionStatus ?? '' } as SessionEvent, managed.workspace.id)
      changed = true
    }

    // Name
    if (header.name !== undefined && managed.name !== header.name) {
      managed.name = header.name
      this.deps.sendEvent({ type: 'name_changed', sessionId, name: header.name } as SessionEvent, managed.workspace.id)
      changed = true
    }

    if (changed) {
      this.deps.persistSession(managed)
    }

    return changed
  }

  // ── Unread on turn end ───────────────────────────────────────────────

  /**
   * Called from onProcessingStopped to handle unread state transitions.
   */
  async handleUnreadOnTurnEnd(
    sessionId: string,
    managed: ReadStateManagedSession,
    reason: 'complete' | 'interrupted' | 'error' | 'timeout',
    turnStartFinalMessageId: string | undefined,
  ): Promise<void> {
    const isViewing = this.isSessionBeingViewed(sessionId, managed.workspace.id)
    const currentFinalMessageId = this.getLastFinalAssistantMessageId(managed.messages)
    const didReceiveNewFinalMessage = !!currentFinalMessageId && currentFinalMessageId !== turnStartFinalMessageId

    if (reason === 'complete' && didReceiveNewFinalMessage) {
      if (isViewing) {
        await this.markSessionRead(sessionId)
      } else {
        if (!managed.hasUnread) {
          managed.hasUnread = true
          await updateSessionMetadata(managed.workspace.rootPath, sessionId, { hasUnread: true })
          this.emitUnreadSummaryChanged()
        }
      }
    }
  }

  // ── Helpers ──────────────────────────────────────────────────────────

  getLastFinalAssistantMessageId(messages: Message[]): string | undefined {
    for (let i = messages.length - 1; i >= 0; i--) {
      const msg = messages[i]
      if (msg.role === 'assistant' && !msg.isIntermediate) {
        return msg.id
      }
    }
    return undefined
  }
}
