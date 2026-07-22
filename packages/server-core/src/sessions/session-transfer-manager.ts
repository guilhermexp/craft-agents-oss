/**
 * Session Transfer Manager
 *
 * Handles session import/export and remote transfer operations.
 * Extracted from SessionManager to isolate transfer/dispatch concerns.
 */

import { type AgentBackend, type BackendHostRuntimeContext, resolveBackendContext, createBackendFromResolvedContext, isNativeAgentProvider, spawnNativeAgent } from '@craft-agent/shared/agent/backend'
import { type PermissionMode, setPermissionMode, hydratePreviousPermissionMode, generateConversationSummary } from '@craft-agent/shared/agent'
import { getLlmConnection, getLlmConnections } from '@craft-agent/shared/config'
import { getMiniModel } from '@craft-agent/shared/config'
import { getDefaultSummarizationModel } from '@craft-agent/shared/config/models'
import { loadWorkspaceConfig } from '@craft-agent/shared/workspaces'
import { loadWorkspaceSources, type LoadedSource } from '@craft-agent/shared/sources'
import { resolveSessionConnection } from '@craft-agent/shared/agent/backend'
import { storedToMessage, type Message } from '@craft-agent/core/types'
import { restoreFiles } from '@craft-agent/shared/utils/bundle-files'
import { type ThinkingLevel } from '@craft-agent/shared/agent/thinking-levels'
import {
  getWorkspaceByNameOrId,
  type Workspace,
} from '@craft-agent/shared/config'
import {
  serializeSession,
  validateBundle,
  generateSessionId,
  ensureSessionDir,
  getSessionPath as getSessionStoragePath,
  getSessionFilePath,
  writeSessionJsonl,
  type SessionBundle,
  type DispatchMode,
  type StoredSession,
  type StoredMessage,
} from '@craft-agent/shared/sessions'
import {
  type Session,
  type SessionEvent,
  type RemoteSessionTransferPayload,
  type ImportRemoteSessionTransferResult,
  type CreateSessionOptions,
} from '@craft-agent/shared/protocol'
import { createScopedLogger, CONSOLE_LOGGER, type PlatformServices, type Logger } from '@craft-agent/server-core/runtime'

// Scoped logger
let transferLog: Logger = createScopedLogger(CONSOLE_LOGGER, 'session-transfer')

/** Allow the host to upgrade the logger (e.g. after platform init). */
export function setTransferManagerLogger(logger: Logger): void {
  transferLog = createScopedLogger(logger, 'session-transfer')
}

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

/** Agent-like object — only the subset used by transfer ops. */
type AgentInstance = AgentBackend

/**
 * Minimal session shape consumed by the transfer manager.
 * Mirrors the fields of ManagedSession that transfer ops actually touch.
 */
export interface TransferManagedSession {
  id: string
  workspace: Workspace
  agent: AgentInstance | null
  messages: Message[]
  isProcessing: boolean
  name?: string
  isFlagged: boolean
  permissionMode?: PermissionMode
  previousPermissionMode?: PermissionMode
  enabledSourceSlugs?: string[]
  labels?: string[]
  sessionStatus?: string
  workingDirectory?: string
  sdkCwd?: string
  sdkSessionId?: string
  model?: string
  llmConnection?: string
  connectionLocked?: boolean
  thinkingLevel?: ThinkingLevel
  hermesProfile?: string
  hidden?: boolean
  sharedUrl?: string
  sharedId?: string
  transferredSessionSummary?: string
  transferredSessionSummaryApplied?: boolean
  messagesLoaded: boolean
  tokenUsage?: {
    inputTokens: number
    outputTokens: number
    totalTokens: number
    contextTokens: number
    costUsd: number
    cacheReadTokens?: number
    cacheCreationTokens?: number
    contextWindow?: number
  }
  branchFromSdkSessionId?: string
  branchFromSdkTurnId?: string
  branchFromSdkCwd?: string
  branchSeedApplied?: boolean
  branchContextStrategy?: 'sdk-fork' | 'seeded-fresh-session'
  preview?: string
  messageCount?: number
  lastFinalMessageId?: string
  createdAt?: number
}

/**
 * Dependency interface — keeps the transfer manager decoupled from SessionManager.
 */
export interface SessionTransferManagerDeps {
  getSession(sessionId: string): TransferManagedSession | undefined
  persistSession(managed: TransferManagedSession): void
  flushSession(sessionId: string): Promise<void>
  ensureMessagesLoaded(managed: TransferManagedSession): Promise<void>
  createSession(workspaceId: string, options?: CreateSessionOptions): Promise<Session>
  sendEvent(event: SessionEvent, workspaceId?: string): void
  /** Register a managed session in the in-memory map. */
  registerSession(sessionId: string, managed: TransferManagedSession): void
  /** Build a BackendHostRuntimeContext (requires platform). */
  buildBackendHostRuntimeContext(): BackendHostRuntimeContext
  /** Create a ManagedSession from session-like source and workspace. */
  createManagedSession(
    source: { id: string } & Partial<TransferManagedSession>,
    workspace: Workspace,
    overrides?: Partial<TransferManagedSession>,
  ): TransferManagedSession
  /** Optional: initialize automation metadata for an imported session. */
  initializeAutomationMetadata?(sessionId: string, metadata: {
    permissionMode?: PermissionMode
    labels?: string[]
    isFlagged?: boolean
    sessionStatus?: string
    sessionName?: string
  }): void
}

const DEFAULT_TOKEN_USAGE = {
  inputTokens: 0, outputTokens: 0, totalTokens: 0,
  contextTokens: 0, costUsd: 0,
}

// ---------------------------------------------------------------------------
// Internal helpers
// ---------------------------------------------------------------------------

function createSessionBackendFromResolvedContext(
  args: Parameters<typeof createBackendFromResolvedContext>[0],
): AgentBackend {
  if (isNativeAgentProvider(args.context.provider)) {
    return spawnNativeAgent({
      context: {
        ...args.context,
        provider: args.context.provider,
      },
      coreConfig: args.coreConfig,
      hostRuntime: args.hostRuntime,
      providerOptions: args.providerOptions,
    })
  }

  return createBackendFromResolvedContext(args)
}

// ---------------------------------------------------------------------------
// SessionTransferManager class
// ---------------------------------------------------------------------------

/**
 * Manages session import, export, and remote transfer operations.
 */
export class SessionTransferManager {
  constructor(private readonly deps: SessionTransferManagerDeps) {}

  /**
   * Generate a conversation summary for remote transfer using a mini model.
   */
  private async generateRemoteTransferSummary(managed: TransferManagedSession): Promise<string | null> {
    await this.deps.ensureMessagesLoaded(managed)

    const messages = managed.messages
      .flatMap(m => (
        (m.role === 'user' || m.role === 'assistant') && !m.isIntermediate
          ? [{ type: m.role as 'user' | 'assistant', content: m.content }]
          : []
      ))

    if (messages.length === 0) return null

    const workspaceRootPath = managed.workspace.rootPath
    const wsConfig = loadWorkspaceConfig(workspaceRootPath)
    const defaultModel = wsConfig?.defaults?.model
    const backendContext = resolveBackendContext({
      sessionConnectionSlug: managed.llmConnection,
      workspaceDefaultConnectionSlug: wsConfig?.defaults?.defaultLlmConnection,
      managedModel: managed.model || defaultModel,
    })

    const miniModel = backendContext.connection
      ? (getMiniModel(backendContext.connection) ?? backendContext.connection.defaultModel ?? getDefaultSummarizationModel())
      : getDefaultSummarizationModel()

    const envOverrides: Record<string, string> = {
      CRAFT_WORKSPACE_PATH: workspaceRootPath,
      ...(miniModel ? { ANTHROPIC_DEFAULT_HAIKU_MODEL: miniModel } : {}),
    }

    const hostRuntime = this.deps.buildBackendHostRuntimeContext()

    const agent = createSessionBackendFromResolvedContext({
      context: backendContext,
      hostRuntime,
      coreConfig: {
        workspace: managed.workspace,
        session: {
          id: `${managed.id}-remote-transfer-summary`,
          workspaceRootPath,
          createdAt: Date.now(),
          lastUsedAt: Date.now(),
          workingDirectory: managed.workingDirectory,
          sdkCwd: managed.sdkCwd,
          model: managed.model,
          llmConnection: managed.llmConnection,
          hermesProfile: managed.hermesProfile,
          permissionMode: managed.permissionMode,
          previousPermissionMode: managed.previousPermissionMode,
        },
        miniModel,
        envOverrides,
        isHeadless: true,
      },
      providerOptions: { piAuthProvider: backendContext.connection?.piAuthProvider },
    })

    try {
      return await generateConversationSummary(messages, agent.runMiniCompletion.bind(agent))
    } finally {
      agent.destroy()
    }
  }

  /**
   * Export a session as a remote transfer payload (summary-based).
   */
  async exportRemoteSessionTransfer(sessionId: string, workspaceId: string): Promise<RemoteSessionTransferPayload | null> {
    const managed = this.deps.getSession(sessionId)
    if (!managed) {
      transferLog.warn(`[dispatch] Cannot export remote transfer: ${sessionId} not found`)
      return null
    }

    if (managed.workspace.id !== workspaceId) {
      transferLog.warn(`[dispatch] Session ${sessionId} does not belong to workspace ${workspaceId}`)
      return null
    }

    if (managed.isProcessing) {
      transferLog.warn(`[dispatch] Cannot export remote transfer ${sessionId}: still processing`)
      return null
    }

    this.deps.persistSession(managed)
    await this.deps.flushSession(sessionId)

    const summary = await this.generateRemoteTransferSummary(managed)
    if (!summary) {
      transferLog.warn(`[dispatch] Failed to generate remote transfer summary for ${sessionId}`)
      return null
    }

    return {
      sourceSessionId: managed.id,
      name: managed.name,
      sessionStatus: managed.sessionStatus,
      labels: managed.labels,
      permissionMode: managed.permissionMode,
      summary,
    }
  }

  /**
   * Import a remote session transfer payload into a workspace.
   */
  async importRemoteSessionTransfer(
    workspaceId: string,
    payload: RemoteSessionTransferPayload,
  ): Promise<ImportRemoteSessionTransferResult> {
    if (!payload || typeof payload !== 'object' || typeof payload.summary !== 'string' || !payload.summary.trim()) {
      throw new Error('Invalid remote session transfer payload')
    }

    const session = await this.deps.createSession(workspaceId, {
      name: payload.name,
      permissionMode: payload.permissionMode,
      sessionStatus: payload.sessionStatus,
      labels: payload.labels,
    })

    const managed = this.deps.getSession(session.id)
    if (!managed) {
      throw new Error(`Transferred session ${session.id} was not created`)
    }

    managed.transferredSessionSummary = payload.summary.trim()
    managed.transferredSessionSummaryApplied = false
    this.deps.persistSession(managed)
    await this.deps.flushSession(session.id)

    return { sessionId: session.id }
  }

  /**
   * Export a session as a portable SessionBundle.
   *
   * Steps:
   * 1. Validate session exists and resolve its workspace
   * 2. If session is processing, refuse (caller must stop it first)
   * 3. Flush pending persistence writes
   * 4. Serialize session directory into a bundle
   */
  async exportSession(sessionId: string, workspaceId: string): Promise<SessionBundle | null> {
    const managed = this.deps.getSession(sessionId)
    if (!managed) {
      transferLog.warn(`[dispatch] Cannot export session: ${sessionId} not found`)
      return null
    }

    if (managed.workspace.id !== workspaceId) {
      transferLog.warn(`[dispatch] Session ${sessionId} does not belong to workspace ${workspaceId}`)
      return null
    }

    if (managed.isProcessing) {
      transferLog.warn(`[dispatch] Cannot export session ${sessionId}: still processing`)
      return null
    }

    // Flush pending writes to ensure JSONL is up to date
    this.deps.persistSession(managed)
    await this.deps.flushSession(sessionId)

    const bundle = serializeSession(managed.workspace.rootPath, sessionId)
    if (!bundle) {
      transferLog.error(`[dispatch] Failed to serialize session ${sessionId}`)
      return null
    }

    return bundle
  }

  /**
   * Import a session bundle into a target workspace.
   *
   * Steps:
   * 1. Validate bundle structure and target workspace
   * 2. Generate new session ID (fork) or use original (move)
   * 3. Create session directory and write JSONL + files
   * 4. Register session in-memory
   * 5. Emit session_created event
   * 6. Return new session ID and compatibility warnings
   */
  async importSession(
    workspaceId: string,
    bundle: SessionBundle,
    mode: DispatchMode,
  ): Promise<{ sessionId: string; warnings?: string[] }> {
    transferLog.info(`[import] Starting import: workspaceId=${workspaceId}, mode=${mode}, bundleSessionId=${bundle?.session?.header?.id ?? 'unknown'}, files=${bundle?.files?.length ?? 0}`)

    if (!validateBundle(bundle)) {
      throw new Error('Invalid session bundle')
    }

    const workspace = getWorkspaceByNameOrId(workspaceId)
    if (!workspace) {
      throw new Error(`Workspace ${workspaceId} not found`)
    }

    transferLog.info(`[import] Target workspace: "${workspace.name}" at ${workspace.rootPath}`)

    const warnings: string[] = []
    const workspaceRootPath = workspace.rootPath

    // Determine session ID
    const sessionId = mode === 'move'
      ? bundle.session.header.id
      : generateSessionId(workspaceRootPath)

    // Check for ID collision on move
    if (mode === 'move' && this.deps.getSession(sessionId)) {
      throw new Error(`Session ${sessionId} already exists in target workspace`)
    }

    // Create session directory with all subdirectories
    const sessionDir = ensureSessionDir(workspaceRootPath, sessionId)

    // Build the stored session from bundle data
    const header = bundle.session.header
    const storedSession: StoredSession = {
      id: sessionId,
      workspaceRootPath,
      sdkSessionId: header.sdkSessionId, // Preserved initially; fork logic below may clear it
      // Always regenerate sdkCwd for the target workspace.
      // The source sdkCwd points to a path on the originating server
      // which doesn't exist here (cross-server transfer).
      sdkCwd: getSessionStoragePath(workspaceRootPath, sessionId),
      name: header.name,
      createdAt: header.createdAt,
      lastUsedAt: Date.now(),
      lastMessageAt: header.lastMessageAt,
      isFlagged: header.isFlagged,
      permissionMode: header.permissionMode,
      previousPermissionMode: header.previousPermissionMode,
      sessionStatus: header.sessionStatus,
      labels: header.labels,
      enabledSourceSlugs: header.enabledSourceSlugs,
      workingDirectory: header.workingDirectory,
      model: header.model,
      llmConnection: header.llmConnection,
      connectionLocked: header.connectionLocked,
      thinkingLevel: header.thinkingLevel,
      hermesProfile: header.hermesProfile,
      hidden: header.hidden,
      transferredSessionSummary: header.transferredSessionSummary,
      transferredSessionSummaryApplied: header.transferredSessionSummaryApplied,
      messages: bundle.session.messages,
      tokenUsage: header.tokenUsage ?? DEFAULT_TOKEN_USAGE,
    }

    // Fork-specific: set up SDK branching if branchInfo provided
    if (mode === 'fork' && bundle.branchInfo) {
      storedSession.branchFromSdkSessionId = bundle.branchInfo.sdkSessionId
      storedSession.branchFromSdkTurnId = bundle.branchInfo.sdkTurnId
      storedSession.branchFromSdkCwd = bundle.branchInfo.sdkCwd
    }

    // Fork-specific: clear sharing state and attempt resume-first strategy
    if (mode === 'fork') {
      storedSession.sharedUrl = undefined
      storedSession.sharedId = undefined

      // Resume-first: try to find a compatible LLM connection on the target workspace.
      // If found and the session has an sdkSessionId, preserve it for API-level resume.
      // If not, clear SDK state and fall back to transferred session summary.
      const sourceProviderType = header.llmConnection
        ? getLlmConnection(header.llmConnection)?.providerType
        : undefined
      const compatibleConnection = sourceProviderType
        ? this.findCompatibleLlmConnection(workspaceRootPath, sourceProviderType)
        : null

      if (compatibleConnection && storedSession.sdkSessionId) {
        // Resume path: compatible credentials exist — preserve SDK session ID
        transferLog.info(`[import] Fork: compatible ${sourceProviderType} connection "${compatibleConnection}" found — preserving sdkSessionId for resume`)
        storedSession.llmConnection = compatibleConnection
        storedSession.connectionLocked = false
      } else {
        // Summary path: no compatible connection or no SDK session — clear for fresh start
        if (storedSession.llmConnection) {
          transferLog.info(`[import] Fork: no compatible ${sourceProviderType ?? 'unknown'} connection — clearing, will use summary context`)
        }
        storedSession.sdkSessionId = undefined
        storedSession.llmConnection = undefined
        storedSession.connectionLocked = false
      }
      // Clear thinking level so the session inherits the workspace default
      storedSession.thinkingLevel = undefined
      // Clear working directory — the source path won't exist on a different server.
      // The user can set a new cwd after the session is transferred.
      storedSession.workingDirectory = undefined
    }

    // Check source compatibility (before writing JSONL so fixes are persisted)
    if (storedSession.enabledSourceSlugs?.length) {
      const availableSources = loadWorkspaceSources(workspaceRootPath)
      const availableSlugs = new Set(availableSources.map(s => s.config.slug))
      const missingSources = storedSession.enabledSourceSlugs.filter(s => !availableSlugs.has(s))
      if (missingSources.length > 0) {
        transferLog.warn(`[import] Sources not available: ${missingSources.join(', ')}`)
        warnings.push(`Sources not available in target workspace: ${missingSources.join(', ')}`)
      }
    }

    // Check LLM connection compatibility for move mode (fork already cleared above)
    if (mode === 'move' && storedSession.llmConnection) {
      transferLog.info(`[import] Checking LLM connection: "${storedSession.llmConnection}"`)
      const conn = resolveSessionConnection(storedSession.llmConnection, undefined)
      if (!conn) {
        transferLog.warn(`[import] LLM connection "${storedSession.llmConnection}" not found — clearing to use default`)
        warnings.push(`LLM connection "${storedSession.llmConnection}" not found in target — session will use default`)
        storedSession.llmConnection = undefined
        storedSession.connectionLocked = false
      } else {
        transferLog.info(`[import] LLM connection "${storedSession.llmConnection}" resolved OK`)
      }
    } else if (mode === 'move' && !storedSession.llmConnection) {
      transferLog.info('[import] No LLM connection in bundle — will use default')
    }

    // Write JSONL file (after compatibility checks so remapped values are persisted)
    const sessionFile = getSessionFilePath(workspaceRootPath, sessionId)
    transferLog.info(`[import] Writing JSONL: ${sessionFile} (llmConnection=${storedSession.llmConnection ?? 'default'}, messages=${storedSession.messages.length})`)
    writeSessionJsonl(sessionFile, storedSession)

    // Write all bundle files (attachments, plans, data, downloads, etc.)
    // Uses restoreFiles() for path traversal, size, and base64 validation.
    restoreFiles(sessionDir, bundle.files)

    // Register in-memory — pass session metadata without messages to avoid
    // StoredMessage[] vs Message[] type mismatch, then convert messages separately
    const { messages: bundleMessages, ...sessionMeta } = storedSession
    const managed = this.deps.createManagedSession(sessionMeta, workspace, {
      messagesLoaded: true,
      workingDirectory: storedSession.workingDirectory,
    })
    managed.messages = bundleMessages.map(storedToMessage)

    setPermissionMode(sessionId, managed.permissionMode ?? 'ask', { changedBy: 'restore' })
    if (managed.previousPermissionMode) {
      hydratePreviousPermissionMode(sessionId, managed.previousPermissionMode)
    }

    this.deps.registerSession(sessionId, managed)

    // Initialize automation metadata
    this.deps.initializeAutomationMetadata?.(sessionId, {
      permissionMode: storedSession.permissionMode,
      labels: storedSession.labels,
      isFlagged: storedSession.isFlagged,
      sessionStatus: storedSession.sessionStatus,
      sessionName: managed.name,
    })

    // Emit session_created so renderer picks it up
    this.deps.sendEvent({ type: 'session_created', sessionId }, workspaceId)

    transferLog.info(`[import] Complete: sessionId=${sessionId}, transferredSummary=${managed.transferredSessionSummary ? `${managed.transferredSessionSummary.length} chars` : 'none'}, applied=${managed.transferredSessionSummaryApplied}, warnings=${warnings.length > 0 ? warnings.join('; ') : 'none'}`)
    return { sessionId, warnings: warnings.length > 0 ? warnings : undefined }
  }

  /**
   * Find an LLM connection on this server that matches the given provider type.
   * Checks workspace default first, then falls back to any matching connection.
   */
  findCompatibleLlmConnection(workspaceRootPath: string, providerType: string): string | null {
    const wsConfig = loadWorkspaceConfig(workspaceRootPath)
    const defaultSlug = wsConfig?.defaults?.defaultLlmConnection
    if (defaultSlug) {
      const conn = getLlmConnection(defaultSlug)
      if (conn?.providerType === providerType) return defaultSlug
    }
    // Fall back: any connection with matching provider type
    const connections = getLlmConnections()
    const match = connections.find(c => c.providerType === providerType)
    return match?.slug ?? null
  }
}
