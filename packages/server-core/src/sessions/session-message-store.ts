import type { Workspace } from '@craft-agent/shared/config'
import {
  loadSession as loadStoredSession,
  sessionPersistenceQueue,
  type StoredSession,
  pickSessionFields,
} from '@craft-agent/shared/sessions'
import { messageToStored, storedToMessage, type Message, type StoredAttachment } from '@craft-agent/core/types'
import type { FileAttachment, SendMessageOptions } from '@craft-agent/shared/protocol'

const DEFAULT_TOKEN_USAGE = {
  inputTokens: 0,
  outputTokens: 0,
  totalTokens: 0,
  contextTokens: 0,
  costUsd: 0,
}

export interface StoreManagedSession {
  id: string
  workspace: Pick<Workspace, 'rootPath'>
  messages: Message[]
  messagesLoaded: boolean
  tokenUsage?: StoredSession['tokenUsage']
  createdAt?: number
  lastReadMessageId?: string
  hasUnread?: boolean
  enabledSourceSlugs?: string[]
  sharedUrl?: string
  sharedId?: string
  name?: string
  llmConnection?: string
  connectionLocked?: boolean
  hermesProfile?: string
  transferredSessionSummary?: string
  transferredSessionSummaryApplied?: boolean
  messageQueue?: Array<{
    message: string
    attachments?: FileAttachment[]
    storedAttachments?: StoredAttachment[]
    options?: SendMessageOptions
    messageId?: string
    optimisticMessageId?: string
  }>
  isProcessing?: boolean
}

export interface SessionMessageStoreOptions {
  onQueuedMessagesRecovered?: (sessionId: string) => void
  debug?: (message: string) => void
  info?: (message: string) => void
  error?: (message: string, error: unknown) => void
}

export class SessionMessageStore {
  private readonly messageLoadingPromises = new Map<string, Promise<void>>()
  private readonly onQueuedMessagesRecovered?: (sessionId: string) => void
  private readonly debug: (message: string) => void
  private readonly info: (message: string) => void
  private readonly error: (message: string, error: unknown) => void

  constructor(options: SessionMessageStoreOptions = {}) {
    this.onQueuedMessagesRecovered = options.onQueuedMessagesRecovered
    this.debug = options.debug ?? (() => {})
    this.info = options.info ?? (() => {})
    this.error = options.error ?? (() => {})
  }

  async load(sessionId: string, workspaceRootPath: string): Promise<StoredSession | null> {
    return loadStoredSession(workspaceRootPath, sessionId)
  }

  async ensureMessagesLoaded(managed: StoreManagedSession): Promise<void> {
    if (managed.messagesLoaded) return

    const existingPromise = this.messageLoadingPromises.get(managed.id)
    if (existingPromise) {
      return existingPromise
    }

    const loadPromise = this.loadMessagesFromDisk(managed)
    this.messageLoadingPromises.set(managed.id, loadPromise)

    try {
      await loadPromise
    } finally {
      this.messageLoadingPromises.delete(managed.id)
    }
  }

  persist(managed: StoreManagedSession): void {
    try {
      if (!managed.messagesLoaded) return

      const persistableMessages = managed.messages.filter(message => message.role !== 'status')
      const storedSession: StoredSession = {
        ...pickSessionFields(managed),
        workspaceRootPath: managed.workspace.rootPath,
        createdAt: managed.createdAt ?? Date.now(),
        lastUsedAt: Date.now(),
        messages: persistableMessages.map(messageToStored),
        tokenUsage: managed.tokenUsage ?? DEFAULT_TOKEN_USAGE,
      } as StoredSession

      sessionPersistenceQueue.enqueue(storedSession)
    } catch (error) {
      this.error(`Failed to queue session ${managed.id} for persistence:`, error)
    }
  }

  async flush(sessionId: string): Promise<void> {
    await sessionPersistenceQueue.flush(sessionId)
  }

  async flushAll(): Promise<void> {
    await sessionPersistenceQueue.flushAll()
  }

  cancel(sessionId: string): void {
    sessionPersistenceQueue.cancel(sessionId)
  }

  getLastWrittenSignature(sessionId: string): string | null {
    return sessionPersistenceQueue.getLastWrittenSignature(sessionId) ?? null
  }

  private async loadMessagesFromDisk(managed: StoreManagedSession): Promise<void> {
    const storedSession = loadStoredSession(managed.workspace.rootPath, managed.id)
    if (storedSession) {
      managed.messages = (storedSession.messages || []).map(storedToMessage)
      managed.tokenUsage = storedSession.tokenUsage
      managed.lastReadMessageId = storedSession.lastReadMessageId
      managed.hasUnread = storedSession.hasUnread
      managed.enabledSourceSlugs = storedSession.enabledSourceSlugs
      managed.sharedUrl = storedSession.sharedUrl
      managed.sharedId = storedSession.sharedId
      managed.name = storedSession.name
      if (storedSession.llmConnection) managed.llmConnection = storedSession.llmConnection
      if (storedSession.connectionLocked) managed.connectionLocked = storedSession.connectionLocked
      if (storedSession.hermesProfile) managed.hermesProfile = storedSession.hermesProfile
      managed.transferredSessionSummary = storedSession.transferredSessionSummary
      managed.transferredSessionSummaryApplied = storedSession.transferredSessionSummaryApplied
      this.debug(`Lazy-loaded ${managed.messages.length} messages for session ${managed.id}`)

      const orphanedQueued = managed.messages.filter(message => (
        message.role === 'user' && message.isQueued === true
      ))
      if (orphanedQueued.length > 0) {
        this.info(`Recovering ${orphanedQueued.length} queued message(s) for session ${managed.id}`)
        managed.messageQueue ??= []
        for (const message of orphanedQueued) {
          managed.messageQueue.push({
            message: message.content,
            messageId: message.id,
            attachments: undefined,
            storedAttachments: message.attachments,
            options: undefined,
          })
        }
        if (!managed.isProcessing && managed.messageQueue.length > 0) {
          setImmediate(() => this.onQueuedMessagesRecovered?.(managed.id))
        }
      }
    }
    managed.messagesLoaded = true
  }
}
