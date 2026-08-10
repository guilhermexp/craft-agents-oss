import type { Workspace } from '@craft-agent/shared/config'
import {
  loadSession as loadStoredSession,
  sessionPersistenceQueue,
  type StoredSession,
  pickSessionFields,
} from '@craft-agent/shared/sessions'
import { messageToStored, storedToMessage, type Message, type StoredAttachment } from '@craft-agent/core/types'
import type { FileAttachment, SendMessageOptions } from '@craft-agent/shared/protocol'
import { mkdir, readFile, writeFile } from 'fs/promises'
import { join } from 'path'

const DEFAULT_TOKEN_USAGE = {
  inputTokens: 0,
  outputTokens: 0,
  totalTokens: 0,
  contextTokens: 0,
  costUsd: 0,
}

/**
 * How long a self-write suppresses the fs-watcher echo of its own atomic
 * write. See {@link SessionMessageStore.persistMetadataNow}.
 */
const METADATA_WRITE_GUARD_MS = 5000

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
  /** Set by {@link SessionMessageStore.persistMetadataNow}; read by the workspace watcher. */
  _metadataWriteGuardUntil?: number
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
      if (!managed.messagesLoaded) {
        // Cold-session path: a metadata-only mutation (status/label/rename) on a
        // session whose messages were never lazy-loaded would otherwise enqueue
        // `messages: []` over the real JSONL. Hydrate messages + tokenUsage
        // synchronously from disk first (loadStoredSession is sync, so no race);
        // metadata fields the caller just mutated are deliberately left untouched
        // so the in-memory mutation wins.
        const stored = loadStoredSession(managed.workspace.rootPath, managed.id)
        if (stored) {
          managed.messages = (stored.messages || []).map(storedToMessage)
          managed.tokenUsage = stored.tokenUsage
        }
        managed.messagesLoaded = true
        // Recover queued-but-unprocessed messages the same way the lazy-load
        // path does. Without this, a metadata-only persist on a cold session
        // marks it loaded and permanently suppresses #616 recovery, because
        // ensureMessagesLoaded() short-circuits on `messagesLoaded`. Reuses the
        // messages just hydrated above — no second disk read.
        this.recoverQueuedMessages(managed)
      }

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

  /**
   * Persist and wait until the write actually reaches disk. `persist` alone
   * only enqueues behind the queue's debounce, so every caller that must not
   * race a reader — a renderer notification, a branch copy, an export — needs
   * both halves. Pairing them here keeps the debounce from leaking into
   * callers.
   */
  async persistNow(managed: StoreManagedSession): Promise<void> {
    this.persist(managed)
    await this.flush(managed.id)
  }

  /** {@link persistNow} for synchronous callbacks that cannot await it. */
  persistNowDetached(managed: StoreManagedSession): void {
    void this.persistNow(managed)
  }

  /**
   * Persist a metadata-only mutation. Arms the self-write guard first: the
   * fs watcher fires during the atomic write (unlink+rename) and can read
   * stale bytes, which would replay the pre-write header back over the
   * in-memory state this write came from.
   */
  async persistMetadataNow(managed: StoreManagedSession): Promise<void> {
    managed._metadataWriteGuardUntil = Date.now() + METADATA_WRITE_GUARD_MS
    await this.persistNow(managed)
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

      this.recoverQueuedMessages(managed)
    }
    managed.messagesLoaded = true
  }

  /**
   * Re-enqueue user messages persisted with `isQueued === true` that were never
   * processed — the durability guarantee behind #616. Idempotent: a message
   * already present in `messageQueue` (matched by `messageId`) is never pushed
   * twice, so the cold-persist and lazy-load paths can both run for the same
   * session without double-recovering. Fires `onQueuedMessagesRecovered` at most
   * once per call, only when something new was actually recovered.
   */
  private recoverQueuedMessages(managed: StoreManagedSession): void {
    const orphanedQueued = managed.messages.filter(message => (
      message.role === 'user' && message.isQueued === true
    ))
    if (orphanedQueued.length === 0) return

    managed.messageQueue ??= []
    const queuedIds = new Set(
      managed.messageQueue
        .map(entry => entry.messageId)
        .filter((id): id is string => id !== undefined),
    )
    let recovered = 0
    for (const message of orphanedQueued) {
      if (queuedIds.has(message.id)) continue
      managed.messageQueue.push({
        message: message.content,
        messageId: message.id,
        attachments: undefined,
        storedAttachments: message.attachments,
        options: undefined,
      })
      queuedIds.add(message.id)
      recovered++
    }
    if (recovered === 0) return

    this.info(`Recovering ${recovered} queued message(s) for session ${managed.id}`)
    if (!managed.isProcessing) {
      setImmediate(() => this.onQueuedMessagesRecovered?.(managed.id))
    }
  }
}

// ── Turn-anchor sidecars ────────────────────────────────────────────────────
// Branch-fork anchors persisted under each session's `meta/` directory. The
// store owns them because they are session-scoped disk state, mirroring the
// message JSONL it already manages.

const PI_TURN_ANCHORS_VERSION = 1
const PI_TURN_ANCHORS_FILE = 'pi-turn-anchors.json'

interface PiTurnAnchorsIndex {
  version: number
  anchors: Record<string, string>
}

function getPiTurnAnchorsPath(sessionPath: string): string {
  return join(sessionPath, 'meta', PI_TURN_ANCHORS_FILE)
}

export async function loadPiTurnAnchors(sessionPath: string): Promise<PiTurnAnchorsIndex> {
  const filePath = getPiTurnAnchorsPath(sessionPath)
  try {
    const raw = await readFile(filePath, 'utf-8')
    const parsed = JSON.parse(raw) as Partial<PiTurnAnchorsIndex>
    const anchors = (parsed.anchors && typeof parsed.anchors === 'object') ? parsed.anchors : {}
    const normalized: Record<string, string> = {}
    for (const [messageId, anchor] of Object.entries(anchors)) {
      if (typeof messageId === 'string' && typeof anchor === 'string' && messageId && anchor) {
        normalized[messageId] = anchor
      }
    }
    return {
      version: PI_TURN_ANCHORS_VERSION,
      anchors: normalized,
    }
  } catch {
    return {
      version: PI_TURN_ANCHORS_VERSION,
      anchors: {},
    }
  }
}

export async function getPiTurnAnchor(sessionPath: string, messageId: string): Promise<string | undefined> {
  if (!messageId) return undefined
  const index = await loadPiTurnAnchors(sessionPath)
  return index.anchors[messageId]
}

export async function savePiTurnAnchor(sessionPath: string, messageId: string, anchorId: string): Promise<void> {
  if (!messageId || !anchorId) return

  const index = await loadPiTurnAnchors(sessionPath)
  if (index.anchors[messageId] === anchorId) return

  index.anchors[messageId] = anchorId

  const filePath = getPiTurnAnchorsPath(sessionPath)
  await mkdir(join(sessionPath, 'meta'), { recursive: true })
  await writeFile(filePath, JSON.stringify(index), 'utf-8')
}

/**
 * Copy Pi turn anchors from the source session into the branch session,
 * filtered to the messages actually carried into the branch.
 *
 * Without this, branching a branch is silently lossy: the source branch's
 * sidecar contains no anchors for messages copied from its own parent, so a
 * downstream branch falls back to "full-history fork" — discarding the
 * branch cutoff and producing a session whose visible history doesn't match
 * what the LLM sees. See craft-agents-oss#782.
 */
export async function copyPiTurnAnchorsForBranch(
  sourceSessionPath: string,
  branchSessionPath: string,
  branchedMessageIds: Iterable<string>,
): Promise<void> {
  const index = await loadPiTurnAnchors(sourceSessionPath)
  if (Object.keys(index.anchors).length === 0) return
  const idSet = new Set(branchedMessageIds)
  const filtered: Record<string, string> = {}
  for (const [messageId, anchor] of Object.entries(index.anchors)) {
    if (idSet.has(messageId)) {
      filtered[messageId] = anchor
    }
  }
  if (Object.keys(filtered).length === 0) return
  await mkdir(join(branchSessionPath, 'meta'), { recursive: true })
  await writeFile(
    getPiTurnAnchorsPath(branchSessionPath),
    JSON.stringify({ version: PI_TURN_ANCHORS_VERSION, anchors: filtered }),
    'utf-8',
  )
}

const CLAUDE_TURN_ANCHORS_VERSION = 1
const CLAUDE_TURN_ANCHORS_FILE = 'claude-turn-anchors.json'

interface ClaudeTurnAnchorRecord {
  sdkSessionId: string
  sdkMessageUuid: string
}

interface ClaudeTurnAnchorsIndex {
  version: number
  anchors: Record<string, ClaudeTurnAnchorRecord>
}

function getClaudeTurnAnchorsPath(sessionPath: string): string {
  return join(sessionPath, 'meta', CLAUDE_TURN_ANCHORS_FILE)
}

export function isClaudeMessageUuid(turnId: string): boolean {
  return /^msg_[A-Za-z0-9]+$/.test(turnId)
}

async function loadClaudeTurnAnchors(sessionPath: string): Promise<ClaudeTurnAnchorsIndex> {
  const filePath = getClaudeTurnAnchorsPath(sessionPath)
  try {
    const raw = await readFile(filePath, 'utf-8')
    const parsed = JSON.parse(raw) as Partial<ClaudeTurnAnchorsIndex>
    const anchors = (parsed.anchors && typeof parsed.anchors === 'object') ? parsed.anchors : {}
    const normalized: Record<string, ClaudeTurnAnchorRecord> = {}

    for (const [messageId, value] of Object.entries(anchors)) {
      if (!messageId || typeof messageId !== 'string') continue
      if (!value || typeof value !== 'object') continue
      if (!('sdkSessionId' in value) || !('sdkMessageUuid' in value)) continue
      const { sdkSessionId, sdkMessageUuid } = value
      if (typeof sdkSessionId === 'string' && sdkSessionId && typeof sdkMessageUuid === 'string' && sdkMessageUuid) {
        normalized[messageId] = { sdkSessionId, sdkMessageUuid }
      }
    }

    return {
      version: CLAUDE_TURN_ANCHORS_VERSION,
      anchors: normalized,
    }
  } catch {
    return {
      version: CLAUDE_TURN_ANCHORS_VERSION,
      anchors: {},
    }
  }
}

export async function getClaudeTurnAnchor(sessionPath: string, messageId: string): Promise<ClaudeTurnAnchorRecord | undefined> {
  if (!messageId) return undefined
  const index = await loadClaudeTurnAnchors(sessionPath)
  return index.anchors[messageId]
}

export async function saveClaudeTurnAnchor(
  sessionPath: string,
  messageId: string,
  sdkSessionId: string,
  sdkMessageUuid: string,
): Promise<void> {
  if (!messageId || !sdkSessionId || !sdkMessageUuid) return

  const index = await loadClaudeTurnAnchors(sessionPath)
  const previous = index.anchors[messageId]
  if (previous && previous.sdkSessionId === sdkSessionId && previous.sdkMessageUuid === sdkMessageUuid) return

  index.anchors[messageId] = {
    sdkSessionId,
    sdkMessageUuid,
  }

  const filePath = getClaudeTurnAnchorsPath(sessionPath)
  await mkdir(join(sessionPath, 'meta'), { recursive: true })
  await writeFile(filePath, JSON.stringify(index), 'utf-8')
}
