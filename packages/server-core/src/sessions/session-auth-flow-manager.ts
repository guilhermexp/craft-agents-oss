/**
 * SessionAuthFlowManager — extracted auth/permission flow methods from SessionManager.
 *
 * Owns state:
 *   - pendingCredentialResolvers
 *   - pendingPermissionRequests
 *   - adminRememberApprovals
 *   - privilegedExecutionBroker
 *
 * ADDITIVE extraction: SessionManager still holds the canonical implementation.
 * This module is the standalone, dependency-injected equivalent.
 */

import type { PermissionMode, AuthRequest, AuthResult, CredentialAuthRequest } from '@craft-agent/shared/agent'
import { setPermissionMode, hydratePreviousPermissionMode, getPermissionModeDiagnostics } from '@craft-agent/shared/agent'
import type { CredentialResponse, PermissionResponseOptions, SessionEvent } from '@craft-agent/shared/protocol'
import type { AgentBackend } from '@craft-agent/shared/agent/backend'
import { PrivilegedExecutionBroker } from '@craft-agent/server-core/services'
import { createScopedLogger, CONSOLE_LOGGER, type Logger } from '@craft-agent/server-core/runtime'

// ── Constants ──────────────────────────────────────────────────────────
const MAX_ADMIN_REMEMBER_MINUTES = 60

// ── Lightweight session shape required by this module ──────────────────
/** Minimal managed session surface consumed by auth-flow methods. */
export interface AuthFlowManagedSession {
  id: string
  workspace: { id: string; rootPath: string }
  agent: AgentBackend | null
  messages: Array<{
    id: string
    role: string
    content: string
    authRequestId?: string
    authStatus?: string
    authError?: string
    authEmail?: string
    authWorkspace?: string
    [key: string]: unknown
  }>
  isProcessing: boolean
  permissionMode?: PermissionMode
  previousPermissionMode?: PermissionMode
  pendingAuthRequestId?: string
  pendingAuthRequest?: AuthRequest
  enabledSourceSlugs?: string[]
  connectionLocked?: boolean
  lastSentMessage?: string
  lastSentAttachments?: unknown[]
  lastSentStoredAttachments?: unknown[]
  lastSentOptions?: Record<string, unknown>
  authRetryAttempted?: boolean
  authRetryInProgress?: boolean
  tokenRefreshManager: { clearCooldown(slug: string): void }
}

// ── Deps interface ─────────────────────────────────────────────────────
export interface SessionAuthFlowDeps {
  getSession(sessionId: string): AuthFlowManagedSession | undefined
  persistSession(managed: AuthFlowManagedSession): void
  sendEvent(event: SessionEvent, workspaceId?: string): void
  sendMessage(
    sessionId: string,
    message: string,
    attachments?: unknown[],
    storedAttachments?: unknown[],
    options?: Record<string, unknown>,
    existingMessageId?: string,
    isAuthRetry?: boolean,
  ): Promise<void>
  setProcessing(managed: AuthFlowManagedSession, processing: boolean): void
  onProcessingStopped(sessionId: string, reason: 'complete' | 'interrupted' | 'error' | 'timeout'): Promise<void>
  /** Monotonic timestamp generator */
  monotonic(): number
  /** Generate a unique message ID */
  generateMessageId(): string
}

// ── Logger ─────────────────────────────────────────────────────────────
let log: Logger = createScopedLogger(CONSOLE_LOGGER, 'session-auth')

export function setAuthFlowLogger(logger: Logger): void {
  log = createScopedLogger(logger, 'session-auth')
}

// ── Class ──────────────────────────────────────────────────────────────
export class SessionAuthFlowManager {
  // ── Owned state ──────────────────────────────────────────────────────
  private pendingCredentialResolvers: Map<string, (response: CredentialResponse) => void> = new Map()

  private pendingPermissionRequests: Map<string, {
    sessionId: string
    type?: 'bash' | 'file_write' | 'mcp_mutation' | 'api_mutation' | 'admin_approval'
    commandHash?: string
  }> = new Map()

  private privilegedExecutionBroker = new PrivilegedExecutionBroker(log)

  private adminRememberApprovals: Map<string, {
    createdAt: number
    expiresAt: number
    sourceRequestId: string
  }> = new Map()

  constructor(private readonly deps: SessionAuthFlowDeps) {}

  // ── Admin remember approval helpers ──────────────────────────────────

  private getAdminRememberKey(sessionId: string, commandHash: string): string {
    return `${sessionId}:${commandHash}`
  }

  hasActiveAdminRememberApproval(sessionId: string, commandHash: string): boolean {
    const key = this.getAdminRememberKey(sessionId, commandHash)
    const entry = this.adminRememberApprovals.get(key)
    if (!entry) {
      return false
    }

    if (Date.now() > entry.expiresAt) {
      this.adminRememberApprovals.delete(key)
      this.privilegedExecutionBroker.auditEvent('privileged_remember_window_expired', {
        sessionId,
        commandHash,
        sourceRequestId: entry.sourceRequestId,
        expiresAt: entry.expiresAt,
      })
      return false
    }

    return true
  }

  storeAdminRememberApproval(sessionId: string, commandHash: string, sourceRequestId: string, rememberForMinutes: number): void {
    const boundedMinutes = Math.min(Math.max(Math.floor(rememberForMinutes), 1), MAX_ADMIN_REMEMBER_MINUTES)
    const now = Date.now()
    const expiresAt = now + boundedMinutes * 60 * 1000

    this.adminRememberApprovals.set(this.getAdminRememberKey(sessionId, commandHash), {
      createdAt: now,
      expiresAt,
      sourceRequestId,
    })

    this.privilegedExecutionBroker.auditEvent('privileged_remember_window_stored', {
      sessionId,
      commandHash,
      sourceRequestId,
      rememberForMinutes: boundedMinutes,
      createdAt: now,
      expiresAt,
    })
  }

  clearAdminRememberApprovalsForSession(sessionId: string): void {
    const prefix = `${sessionId}:`
    for (const key of this.adminRememberApprovals.keys()) {
      if (key.startsWith(prefix)) {
        this.adminRememberApprovals.delete(key)
      }
    }
  }

  clearPendingPermissionRequestsForSession(sessionId: string): void {
    for (const [requestId, metadata] of this.pendingPermissionRequests.entries()) {
      if (metadata.sessionId === sessionId) {
        this.pendingPermissionRequests.delete(requestId)
      }
    }
  }

  // ── Pending permission request tracking ──────────────────────────────

  trackPermissionRequest(requestId: string, meta: {
    sessionId: string
    type?: 'bash' | 'file_write' | 'mcp_mutation' | 'api_mutation' | 'admin_approval'
    commandHash?: string
  }): void {
    this.pendingPermissionRequests.set(requestId, meta)
  }

  getPermissionRequestMeta(requestId: string) {
    return this.pendingPermissionRequests.get(requestId)
  }

  // ── Pending credential resolver tracking ─────────────────────────────

  trackCredentialResolver(requestId: string, resolver: (response: CredentialResponse) => void): void {
    this.pendingCredentialResolvers.set(requestId, resolver)
  }

  // ── Auth request helpers ─────────────────────────────────────────────

  /**
   * Get human-readable description for auth request
   */
  getAuthRequestDescription(request: AuthRequest): string {
    switch (request.type) {
      case 'credential':
        return `Authentication required for ${request.sourceName}`
      case 'oauth':
        return `OAuth authentication for ${request.sourceName}`
      case 'oauth-google':
        return `Sign in with Google for ${request.sourceName}`
      case 'oauth-slack':
        return `Sign in with Slack for ${request.sourceName}`
      case 'oauth-microsoft':
        return `Sign in with Microsoft for ${request.sourceName}`
    }
  }

  /**
   * Format auth result message to send back to agent
   */
  formatAuthResultMessage(result: AuthResult): string {
    if (result.success) {
      let msg = `Authentication completed for ${result.sourceSlug}.`
      if (result.email) msg += ` Signed in as ${result.email}.`
      if (result.workspace) msg += ` Connected to workspace: ${result.workspace}.`
      msg += ' Credentials have been saved.'
      return msg
    }
    if (result.cancelled) {
      return `Authentication cancelled for ${result.sourceSlug}.`
    }
    return `Authentication failed for ${result.sourceSlug}: ${result.error || 'Unknown error'}`
  }

  /**
   * Complete an auth request and send result back to agent.
   * Updates the auth message status and sends a faked user message.
   */
  async completeAuthRequest(sessionId: string, result: AuthResult): Promise<void> {
    const managed = this.deps.getSession(sessionId)
    if (!managed) {
      log.warn(`Cannot complete auth request - session ${sessionId} not found`)
      return
    }

    // Find and update the pending auth-request message
    const authMessage = managed.messages.find(m =>
      m.role === 'auth-request' &&
      m.authRequestId === result.requestId &&
      m.authStatus === 'pending'
    )

    if (authMessage) {
      authMessage.authStatus = result.success ? 'completed' :
                               result.cancelled ? 'cancelled' : 'failed'
      authMessage.authError = result.error
      authMessage.authEmail = result.email
      authMessage.authWorkspace = result.workspace
    }

    // Emit auth_completed event to update UI
    this.deps.sendEvent({
      type: 'auth_completed',
      sessionId,
      requestId: result.requestId,
      success: result.success,
      cancelled: result.cancelled,
      error: result.error,
    } as SessionEvent, managed.workspace.id)

    // Create faked user message with result
    const resultContent = this.formatAuthResultMessage(result)

    // Clear pending auth state
    managed.pendingAuthRequestId = undefined
    managed.pendingAuthRequest = undefined

    // Auto-enable the source in the session after successful auth
    if (result.success && result.sourceSlug) {
      const slugSet = new Set(managed.enabledSourceSlugs || [])
      if (!slugSet.has(result.sourceSlug)) {
        slugSet.add(result.sourceSlug)
        managed.enabledSourceSlugs = Array.from(slugSet)
        log.info(`Auto-enabled source ${result.sourceSlug} in session ${sessionId} after auth`)
      }

      // Clear any refresh cooldown so the source is immediately usable
      managed.tokenRefreshManager.clearCooldown(result.sourceSlug)
    }

    // Persist session with updated auth message and enabled sources
    this.deps.persistSession(managed)

    // Send the result as a new message to resume conversation
    await this.deps.sendMessage(sessionId, resultContent, [], [], {})

    log.info(`Auth request completed for ${result.sourceSlug}: ${result.success ? 'success' : 'failed'}`)
  }

  /**
   * Handle credential input from the UI (for non-OAuth auth).
   * Called when user submits credentials via the inline form.
   */
  async handleCredentialInput(
    sessionId: string,
    requestId: string,
    response: CredentialResponse,
  ): Promise<void> {
    const managed = this.deps.getSession(sessionId)
    if (!managed?.pendingAuthRequest) {
      log.warn(`Cannot handle credential input - no pending auth request for session ${sessionId}`)
      return
    }

    const request = managed.pendingAuthRequest as CredentialAuthRequest
    if (request.requestId !== requestId) {
      log.warn(`Credential request ID mismatch: expected ${request.requestId}, got ${requestId}`)
      return
    }

    if (response.cancelled) {
      await this.completeAuthRequest(sessionId, {
        requestId,
        sourceSlug: request.sourceSlug,
        success: false,
        cancelled: true,
      })
      return
    }

    try {
      // Store credentials using existing workspace ID extraction pattern
      const { getCredentialManager } = await import('@craft-agent/shared/credentials')
      const credManager = getCredentialManager()
      const { basename } = await import('path')
      // Extract workspace ID from root path (last segment of path)
      const wsId = basename(managed.workspace.rootPath) || managed.workspace.id

      if (request.mode === 'basic') {
        await credManager.set(
          { type: 'source_basic', workspaceId: wsId, sourceId: request.sourceSlug },
          { value: JSON.stringify({ username: response.username, password: response.password }) }
        )
      } else if (request.mode === 'bearer') {
        await credManager.set(
          { type: 'source_bearer', workspaceId: wsId, sourceId: request.sourceSlug },
          { value: response.value! }
        )
      } else if (request.mode === 'multi-header') {
        await credManager.set(
          { type: 'source_apikey', workspaceId: wsId, sourceId: request.sourceSlug },
          { value: JSON.stringify(response.headers) }
        )
      } else {
        // header or query - both use API key storage
        await credManager.set(
          { type: 'source_apikey', workspaceId: wsId, sourceId: request.sourceSlug },
          { value: response.value! }
        )
      }

      // Update source config to mark as authenticated
      const { markSourceAuthenticated } = await import('@craft-agent/shared/sources')
      markSourceAuthenticated(managed.workspace.rootPath, request.sourceSlug)

      // Mark source as unseen so fresh guide is injected on next message
      if (managed.agent) {
        managed.agent.markSourceUnseen(request.sourceSlug)
      }

      await this.completeAuthRequest(sessionId, {
        requestId,
        sourceSlug: request.sourceSlug,
        success: true,
      })
    } catch (error) {
      log.error(`Failed to save credentials for ${request.sourceSlug}:`, error)
      await this.completeAuthRequest(sessionId, {
        requestId,
        sourceSlug: request.sourceSlug,
        success: false,
        error: error instanceof Error ? error.message : 'Failed to save credentials',
      })
    }
  }

  // ── Auth retry ───────────────────────────────────────────────────────

  /**
   * Attempt an auth retry after a token-expiry error.
   * Returns true if a retry was initiated, false if conditions prevent it.
   */
  attemptAuthRetry(
    sessionId: string,
    managed: AuthFlowManagedSession,
    workspaceId: string,
    failureErrorCode?: string,
  ): boolean {
    if (managed.authRetryAttempted || !managed.lastSentMessage) return false

    log.info(`Auth error detected, attempting token refresh and retry for session ${sessionId}`)
    managed.authRetryAttempted = true
    managed.authRetryInProgress = true

    // Emit lightweight info so the user sees progress instead of a scary red error
    this.deps.sendEvent({
      type: 'info',
      sessionId,
      message: 'Token expired, refreshing session…',
      timestamp: this.deps.monotonic(),
    } as SessionEvent, workspaceId)

    setImmediate(async () => {
      try {
        // 1. Destroy the agent — the new agent's postInit() will refresh auth
        log.info(`[auth-retry] Destroying agent for session ${sessionId}`)
        managed.agent = null

        // 2. Retry the message
        const retryMessage = managed.lastSentMessage
        const retryAttachments = managed.lastSentAttachments
        const retryStoredAttachments = managed.lastSentStoredAttachments
        const retryOptions = managed.lastSentOptions

        if (retryMessage) {
          log.info(`[auth-retry] Retrying message for session ${sessionId}`)
          this.deps.setProcessing(managed, false)

          // Remove the user message that was added for this failed attempt
          const lastUserMsgIndex = managed.messages.findLastIndex(m => m.role === 'user')
          if (lastUserMsgIndex !== -1) {
            managed.messages.splice(lastUserMsgIndex, 1)
          }

          managed.authRetryInProgress = false

          await this.deps.sendMessage(
            sessionId,
            retryMessage,
            retryAttachments,
            retryStoredAttachments,
            retryOptions as Record<string, unknown>,
            undefined,  // existingMessageId
            true        // _isAuthRetry - prevents infinite retry loop
          )
          log.info(`[auth-retry] Retry completed for session ${sessionId}`)
        } else {
          managed.authRetryInProgress = false
        }
      } catch (retryError) {
        managed.authRetryInProgress = false
        log.error(`[auth-retry] Failed to retry after auth refresh for session ${sessionId}:`, retryError)
        const failedMessage = {
          id: this.deps.generateMessageId(),
          role: 'error' as const,
          content: 'Authentication failed. Please check your credentials.',
          timestamp: this.deps.monotonic(),
          errorCode: failureErrorCode,
        }
        managed.messages.push(failedMessage as AuthFlowManagedSession['messages'][number])
        this.deps.sendEvent({
          type: 'error',
          sessionId,
          error: 'Authentication failed. Please check your credentials.',
          timestamp: failedMessage.timestamp,
        } as SessionEvent, workspaceId)
        await this.deps.onProcessingStopped(sessionId, 'error')
      }
    })

    return true
  }

  // ── Permission response ──────────────────────────────────────────────

  respondToPermission(
    sessionId: string,
    requestId: string,
    allowed: boolean,
    alwaysAllow: boolean,
    options?: PermissionResponseOptions,
  ): boolean {
    const managed = this.deps.getSession(sessionId)
    if (managed?.agent) {
      const requestMeta = this.pendingPermissionRequests.get(requestId)
      this.pendingPermissionRequests.delete(requestId)

      if (requestMeta?.type === 'admin_approval') {
        const brokerResult = this.privilegedExecutionBroker.resolveApproval(requestId, allowed, {
          expectedCommandHash: requestMeta.commandHash,
        })
        if (!brokerResult.ok) {
          log.warn(`Admin approval rejected by broker for ${requestId}: ${brokerResult.reason}`)
          managed.agent.respondToPermission(requestId, false, false)
          return false
        }

        if (allowed && requestMeta.commandHash && options?.rememberForMinutes) {
          this.storeAdminRememberApproval(sessionId, requestMeta.commandHash, requestId, options.rememberForMinutes)
        }
      }

      log.info(`Permission response for ${requestId}: allowed=${allowed}, alwaysAllow=${alwaysAllow}`)
      managed.agent.respondToPermission(requestId, allowed, alwaysAllow)
      return true
    } else {
      log.warn(`Cannot respond to permission - no agent for session ${sessionId}`)
      return false
    }
  }

  // ── Credential response ──────────────────────────────────────────────

  /**
   * Respond to a pending credential request.
   * Supports both the unified auth flow (via handleCredentialInput) and the
   * legacy callback flow (via pendingCredentialResolvers).
   */
  async respondToCredential(sessionId: string, requestId: string, response: CredentialResponse): Promise<boolean> {
    // First, check if this is a new unified auth flow request
    const managed = this.deps.getSession(sessionId)
    if (managed?.pendingAuthRequest && managed.pendingAuthRequest.requestId === requestId) {
      log.info(`Credential response (unified flow) for ${requestId}: cancelled=${response.cancelled}`)
      await this.handleCredentialInput(sessionId, requestId, response)
      return true
    }

    // Fall back to legacy callback flow
    const resolver = this.pendingCredentialResolvers.get(requestId)
    if (resolver) {
      log.info(`Credential response (legacy flow) for ${requestId}: cancelled=${response.cancelled}`)
      resolver(response)
      this.pendingCredentialResolvers.delete(requestId)
      return true
    } else {
      log.warn(`Cannot respond to credential - no pending request for ${requestId}`)
      return false
    }
  }

  // ── Permission mode ──────────────────────────────────────────────────

  /**
   * Set the permission mode for a session ('safe', 'ask', 'allow-all').
   */
  setSessionPermissionMode(sessionId: string, mode: PermissionMode): void {
    const managed = this.deps.getSession(sessionId)
    if (managed) {
      const previousManagedMode = managed.permissionMode ?? 'ask'
      const diagnosticsBefore = getPermissionModeDiagnostics(sessionId)
      const previousEffectiveMode = diagnosticsBefore.permissionMode

      // No-op when BOTH managed state and mode-manager state already match.
      if (previousManagedMode === mode && previousEffectiveMode === mode) {
        return
      }

      if (previousManagedMode === mode && previousEffectiveMode !== mode) {
        log.warn('Permission mode drift detected on same-mode update; reconciling authoritative mode state', {
          sessionId,
          managedMode: previousManagedMode,
          diagnosticsMode: previousEffectiveMode,
          targetMode: mode,
          modeVersion: diagnosticsBefore.modeVersion,
          changedBy: diagnosticsBefore.lastChangedBy,
        })
      }

      // Update in-memory managed mode first
      managed.permissionMode = mode

      // Reconcile mode-manager state for this specific session.
      if (previousEffectiveMode !== mode) {
        const changedBy = previousManagedMode === mode ? 'restore' : 'user'
        setPermissionMode(sessionId, mode, { changedBy })
      }

      const diagnostics = getPermissionModeDiagnostics(sessionId)
      managed.previousPermissionMode = diagnostics.previousPermissionMode
      log.info('Permission mode changed', {
        sessionId,
        permissionMode: mode,
        modeVersion: diagnostics.modeVersion,
        changedBy: diagnostics.lastChangedBy,
        changedAt: diagnostics.lastChangedAt,
      })

      // Forward to the agent instance so backends can propagate mode changes downstream.
      if (managed.agent) {
        managed.agent.setPermissionMode(mode)
      }

      this.deps.sendEvent({
        type: 'permission_mode_changed',
        sessionId: managed.id,
        permissionMode: mode,
        modeVersion: diagnostics.modeVersion,
        changedBy: diagnostics.lastChangedBy,
        changedAt: diagnostics.lastChangedAt,
        previousPermissionMode: diagnostics.previousPermissionMode,
        transitionDisplay: diagnostics.transitionDisplay,
      } as SessionEvent, managed.workspace.id)

      // Persist to disk
      this.deps.persistSession(managed)
    }
  }

  /**
   * Get authoritative permission mode diagnostics for a session.
   * Used by renderer to reconcile optimistic/stale mode state.
   */
  getSessionPermissionModeState(sessionId: string): {
    permissionMode: PermissionMode
    previousPermissionMode?: PermissionMode
    transitionDisplay?: string
    modeVersion: number
    changedAt: string
    changedBy: 'user' | 'system' | 'restore' | 'automation' | 'unknown'
  } | null {
    const managed = this.deps.getSession(sessionId)
    if (!managed) return null

    let diagnostics = getPermissionModeDiagnostics(sessionId)

    // Hydrate persisted transition context when mode-manager has been reset (e.g. app restart).
    if (managed.previousPermissionMode && !diagnostics.previousPermissionMode) {
      hydratePreviousPermissionMode(sessionId, managed.previousPermissionMode)
      diagnostics = getPermissionModeDiagnostics(sessionId)
    }

    // Heal restore races where mode-manager still has default state while
    // session metadata already has a persisted non-default mode.
    if (managed.permissionMode && diagnostics.permissionMode !== managed.permissionMode) {
      log.warn('Permission mode diagnostics mismatch, reconciling to managed session mode', {
        sessionId,
        managedMode: managed.permissionMode,
        diagnosticsMode: diagnostics.permissionMode,
        modeVersion: diagnostics.modeVersion,
        changedBy: diagnostics.lastChangedBy,
      })
      setPermissionMode(sessionId, managed.permissionMode, { changedBy: 'restore' })
      if (managed.previousPermissionMode) {
        hydratePreviousPermissionMode(sessionId, managed.previousPermissionMode)
      }
      diagnostics = getPermissionModeDiagnostics(sessionId)
    }

    managed.previousPermissionMode = diagnostics.previousPermissionMode

    return {
      permissionMode: diagnostics.permissionMode,
      previousPermissionMode: diagnostics.previousPermissionMode,
      transitionDisplay: diagnostics.transitionDisplay,
      modeVersion: diagnostics.modeVersion,
      changedAt: diagnostics.lastChangedAt,
      changedBy: diagnostics.lastChangedBy,
    }
  }
}
