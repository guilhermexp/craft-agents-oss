/**
 * Session Source Orchestrator
 *
 * Handles source/MCP lifecycle: building servers from sources,
 * refreshing OAuth tokens, applying bridge updates, and reloading
 * sources for sessions and workspaces.
 *
 * Extracted from SessionManager to isolate source management concerns.
 */

import { type AgentBackend, type SdkMcpServerConfig } from '@craft-agent/shared/agent/backend'
import { type LoadedSource, isSourceUsable, loadAllSources, getSourcesBySlugs, getSourceCredentialManager, getSourceServerBuilder, type SourceWithCredential, isApiOAuthProvider, hasRenewEndpoint, SERVER_BUILD_ERRORS, TokenRefreshManager, createTokenGetter, type SummarizeCallback } from '@craft-agent/shared/sources'
import { type SessionEvent } from '@craft-agent/shared/protocol'
import { getSessionPath as getSessionStoragePath } from '@craft-agent/shared/sessions'
import { perf } from '@craft-agent/shared/utils'
import { createScopedLogger, CONSOLE_LOGGER, type Logger } from '@craft-agent/server-core/runtime'
import { cleanupSourceRuntimeArtifacts } from '@craft-agent/shared/agent/backend'

// Scoped logger — callers may upgrade via setLogger()
let sourceLog: Logger = createScopedLogger(CONSOLE_LOGGER, 'session-source')

/** Allow the host to upgrade the logger (e.g. after platform init). */
export function setSourceOrchestratorLogger(logger: Logger): void {
  sourceLog = createScopedLogger(logger, 'session-source')
}

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

/** Agent-like object — only the subset of AgentBackend used by source ops. */
type AgentInstance = AgentBackend

/**
 * Minimal session shape consumed by the orchestrator.
 * Mirrors the fields of ManagedSession that source ops actually touch.
 */
export interface SourceManagedSession {
  id: string
  workspace: { id: string; rootPath: string }
  agent: AgentInstance | null
  isProcessing: boolean
  enabledSourceSlugs?: string[]
  tokenRefreshManager: TokenRefreshManager
  poolServer?: { url: string }
}

/**
 * Dependency interface — keeps the orchestrator decoupled from SessionManager.
 */
export interface SessionSourceOrchestratorDeps {
  getSession(sessionId: string): SourceManagedSession | undefined
  getSessionsByWorkspace(workspaceRootPath: string): SourceManagedSession[]
  persistSession(managed: SourceManagedSession): void
  sendEvent(event: SessionEvent, workspaceId?: string): void
  onDebug?: (msg: string) => void
}

// ---------------------------------------------------------------------------
// Standalone helpers (module-level functions)
// ---------------------------------------------------------------------------

/**
 * Result of OAuth token refresh operation.
 */
export interface OAuthTokenRefreshResult {
  /** Whether any tokens were refreshed (configs were updated) */
  tokensRefreshed: boolean
  /** Sources that failed to refresh (for warning display) */
  failedSources: Array<{ slug: string; reason: string }>
}

/**
 * Build MCP and API servers from sources using the new unified modules.
 * Handles credential loading and server building in one step.
 * When auth errors occur, updates source configs to reflect actual state.
 *
 * @param sources - Sources to build servers for
 * @param sessionPath - Optional path to session folder for saving large API responses
 * @param tokenRefreshManager - Optional TokenRefreshManager for OAuth token refresh
 * @param summarize - Optional summarize callback for API responses
 */
export async function buildServersFromSources(
  sources: LoadedSource[],
  sessionPath?: string,
  tokenRefreshManager?: TokenRefreshManager,
  summarize?: SummarizeCallback,
) {
  const span = perf.span('sources.buildServers', { count: sources.length })
  const credManager = getSourceCredentialManager()
  const serverBuilder = getSourceServerBuilder()

  // Load credentials for all sources
  const sourcesWithCreds: SourceWithCredential[] = await Promise.all(
    sources.map(async (source) => ({
      source,
      token: await credManager.getToken(source),
      credential: await credManager.getApiCredential(source),
    }))
  )
  span.mark('credentials.loaded')

  // Build token getter for refreshable sources (OAuth + renew-endpoint)
  // Uses TokenRefreshManager for unified refresh logic (DRY principle)
  const getTokenForSource = (source: LoadedSource) => {
    const provider = source.config.provider
    // Provider-specific OAuth (Google, Slack, Microsoft) or generic OAuth (authType: 'oauth')
    if (isApiOAuthProvider(provider) || source.config.api?.authType === 'oauth') {
      const manager = tokenRefreshManager ?? new TokenRefreshManager(credManager, {
        log: (msg) => sourceLog.debug(msg),
      })
      return createTokenGetter(manager, source)
    }
    // API renew endpoint — non-OAuth token refresh
    if (hasRenewEndpoint(source)) {
      const manager = tokenRefreshManager ?? new TokenRefreshManager(credManager, {
        log: (msg) => sourceLog.debug(msg),
      })
      return createTokenGetter(manager, source)
    }
    return undefined
  }

  // Per-request credential getter for non-OAuth / non-renew API sources
  // (bearer / header / query / basic auth).
  //
  // Without this, the in-process API tool captures the credential as a static
  // string at build time and keeps using it forever — meaning a fresh JWT
  // entered via source_credential_prompt is ignored until session restart.
  //
  // With this getter, every API call reads the latest credential from the
  // vault, so credential updates take effect on the next call. OAuth and
  // renew-endpoint sources have their own refresh logic via TokenRefreshManager
  // and are skipped here.
  const getCredentialForSource = (source: LoadedSource) => {
    if (source.config.type !== 'api') return undefined
    if (source.config.api?.authType === 'none') return undefined
    if (isApiOAuthProvider(source.config.provider)) return undefined
    if (source.config.api?.authType === 'oauth') return undefined
    if (hasRenewEndpoint(source)) return undefined
    return async () => credManager.getApiCredential(source)
  }

  // Pass sessionPath to enable saving large API responses to session folder
  const result = await serverBuilder.buildAll(
    sourcesWithCreds,
    getTokenForSource,
    sessionPath,
    summarize,
    getCredentialForSource,
  )
  span.mark('servers.built')
  span.setMetadata('mcpCount', Object.keys(result.mcpServers).length)
  span.setMetadata('apiCount', Object.keys(result.apiServers).length)

  // Update source configs for auth errors so UI reflects actual state
  for (const error of result.errors) {
    if (error.error === SERVER_BUILD_ERRORS.AUTH_REQUIRED) {
      const source = sources.find(s => s.config.slug === error.sourceSlug)
      if (!source) continue

      // Re-classify AUTH_REQUIRED → TOKEN_EXPIRED when the credential is merely
      // expired-but-refreshable; in that case the refresh cycle handles recovery
      // and we must NOT mark the source as needing manual re-auth.
      const cred = await credManager.load(source)
      const isExpiredRefreshable =
        cred &&
        (credManager.isExpired(cred) || credManager.needsRefresh(cred)) &&
        (cred.refreshToken || hasRenewEndpoint(source))

      if (isExpiredRefreshable) {
        error.error = SERVER_BUILD_ERRORS.TOKEN_EXPIRED
        sourceLog.debug(`Source ${error.sourceSlug}: TOKEN_EXPIRED — refresh cycle will handle`)
        continue
      }

      credManager.markSourceNeedsReauth(source, 'Token missing or expired')
      sourceLog.info(`Marked source ${error.sourceSlug} as needing re-auth`)
    }
  }

  span.end()
  return result
}

/**
 * Refresh expired OAuth tokens and rebuild server configs.
 * Uses TokenRefreshManager for unified refresh logic (DRY/SOLID principles).
 *
 * This implements "proactive refresh at query time" - tokens are refreshed before
 * each agent.chat() call, then server configs are rebuilt with fresh headers.
 *
 * Handles both:
 * - MCP OAuth sources (e.g., Linear, Notion)
 * - API OAuth sources (Google, Slack, Microsoft)
 *
 * @param agent - The agent to update server configs on
 * @param sources - All loaded sources for the session
 * @param sessionPath - Path to session folder for API response storage
 * @param tokenRefreshManager - TokenRefreshManager instance for this session
 * @param options - Optional session/workspace context for bridge updates
 */
export async function refreshOAuthTokensIfNeeded(
  agent: AgentInstance,
  sources: LoadedSource[],
  sessionPath: string,
  tokenRefreshManager: TokenRefreshManager,
  options?: { sessionId?: string; workspaceRootPath?: string; poolServerUrl?: string },
): Promise<OAuthTokenRefreshResult> {
  sourceLog.debug('[OAuth] Checking if any OAuth tokens need refresh')

  // Use TokenRefreshManager to find sources needing refresh (handles rate limiting)
  const needRefresh = await tokenRefreshManager.getSourcesNeedingRefresh(sources)

  if (needRefresh.length === 0) {
    return { tokensRefreshed: false, failedSources: [] }
  }

  sourceLog.debug(`[OAuth] Found ${needRefresh.length} source(s) needing token refresh: ${needRefresh.map(s => s.config.slug).join(', ')}`)

  // Use TokenRefreshManager to refresh all tokens (handles rate limiting and error tracking)
  const { refreshed, failed } = await tokenRefreshManager.refreshSources(needRefresh)

  // Convert failed results to the expected format
  const failedSources = failed.map(({ source, reason }) => ({
    slug: source.config.slug,
    reason,
  }))

  if (refreshed.length > 0) {
    // Rebuild server configs with fresh tokens
    sourceLog.debug(`[OAuth] Rebuilding servers after ${refreshed.length} token refresh(es)`)
    const enabledSources = sources.filter(isSourceUsable)
    const { mcpServers, apiServers } = await buildServersFromSources(
      enabledSources,
      sessionPath,
      tokenRefreshManager,
      agent.getSummarizeCallback()
    )
    const intendedSlugs = enabledSources.map(s => s.config.slug)
    await agent.setSourceServers(mcpServers, apiServers, intendedSlugs)

    // Update bridge-mcp-server config/credentials for backends that need it
    if (options?.sessionId && options?.workspaceRootPath) {
      await applyBridgeUpdates(agent, sessionPath, enabledSources, mcpServers, options.sessionId, options.workspaceRootPath, 'token refresh', options.poolServerUrl)
    }

    return { tokensRefreshed: true, failedSources }
  }

  return { tokensRefreshed: false, failedSources }
}

/**
 * Apply bridge-mcp-server updates for backends that use it.
 * Delegates to the backend's own applyBridgeUpdates() method.
 * Each backend handles its own strategy via applyBridgeUpdates().
 */
export async function applyBridgeUpdates(
  agent: AgentInstance,
  sessionPath: string,
  enabledSources: LoadedSource[],
  mcpServers: Record<string, SdkMcpServerConfig>,
  sessionId: string,
  workspaceRootPath: string,
  context: string,
  poolServerUrl?: string,
): Promise<void> {
  await agent.applyBridgeUpdates({
    sessionPath,
    enabledSources,
    mcpServers,
    sessionId,
    workspaceRootPath,
    context,
    poolServerUrl,
  })
}

// ---------------------------------------------------------------------------
// SessionSourceOrchestrator class
// ---------------------------------------------------------------------------

/**
 * Manages source lifecycle for sessions: reloading sources when configs
 * change on disk, and setting/getting per-session source selections.
 */
export class SessionSourceOrchestrator {
  constructor(private readonly deps: SessionSourceOrchestratorDeps) {}

  /**
   * Reload sources for all sessions in a workspace, skipping those currently processing.
   */
  async reloadSourcesForWorkspace(workspaceRootPath: string): Promise<void> {
    const sessions = this.deps.getSessionsByWorkspace(workspaceRootPath)
    for (const managed of sessions) {
      if (managed.isProcessing) {
        sourceLog.info(`Skipping source reload for session ${managed.id} (processing)`)
        continue
      }
      await this.reloadSessionSources(managed)
    }
  }

  /**
   * Reload sources for a session with an active agent.
   * Called by ConfigWatcher when source files change on disk.
   * If agent is null (session hasn't sent any messages), skip - fresh build happens on next message.
   */
  async reloadSessionSources(managed: SourceManagedSession): Promise<void> {
    if (!managed.agent) return  // No agent = nothing to update (fresh build on next message)

    const workspaceRootPath = managed.workspace.rootPath
    sourceLog.info(`Reloading sources for session ${managed.id}`)

    // Reload all sources from disk (craft-agents-docs is always available as MCP server)
    const allSources = loadAllSources(workspaceRootPath)
    managed.agent.setAllSources(allSources)

    // Rebuild MCP and API servers for session's enabled sources
    const enabledSlugs = managed.enabledSourceSlugs || []
    const enabledSources = allSources.filter(s =>
      enabledSlugs.includes(s.config.slug) && isSourceUsable(s)
    )
    // Pass session path so large API responses can be saved to session folder
    const sessionPath = getSessionStoragePath(workspaceRootPath, managed.id)
    const { mcpServers, apiServers } = await buildServersFromSources(enabledSources, sessionPath, managed.tokenRefreshManager, managed.agent?.getSummarizeCallback())
    const intendedSlugs = enabledSources.map(s => s.config.slug)

    // Update bridge-mcp-server config/credentials for backends that need it
    await applyBridgeUpdates(managed.agent, sessionPath, enabledSources, mcpServers, managed.id, workspaceRootPath, 'source reload', managed.poolServer?.url)

    await managed.agent.setSourceServers(mcpServers, apiServers, intendedSlugs)

    sourceLog.info(`Sources reloaded for session ${managed.id}: ${Object.keys(mcpServers).length} MCP, ${Object.keys(apiServers).length} API`)
  }

  /**
   * Update session's enabled sources.
   * If agent exists, builds and applies servers immediately.
   * Otherwise, servers will be built fresh on next message.
   */
  async setSessionSources(sessionId: string, sourceSlugs: string[]): Promise<void> {
    const managed = this.deps.getSession(sessionId)
    if (!managed) {
      throw new Error(`Session not found: ${sessionId}`)
    }

    const workspaceRootPath = managed.workspace.rootPath
    sourceLog.info(`Setting sources for session ${sessionId}:`, sourceSlugs)

    // Clean up credential cache for sources being disabled (security)
    // This removes decrypted tokens from disk when sources are no longer active
    const previousSlugs = new Set(managed.enabledSourceSlugs || [])
    const newSlugs = new Set(sourceSlugs)
    const disabledSlugs = [...previousSlugs].filter(prevSlug => !newSlugs.has(prevSlug))
    if (disabledSlugs.length > 0) {
      try {
        await cleanupSourceRuntimeArtifacts(workspaceRootPath, disabledSlugs)
      } catch (err) {
        sourceLog.warn(`Failed to clean up source runtime artifacts: ${err}`)
      }
    }

    // Store the selection
    managed.enabledSourceSlugs = sourceSlugs

    // If agent exists, build and apply servers immediately
    if (managed.agent) {
      const sources = getSourcesBySlugs(workspaceRootPath, sourceSlugs)
      // Pass session path so large API responses can be saved to session folder
      const sessionPath = getSessionStoragePath(workspaceRootPath, sessionId)
      const { mcpServers, apiServers, errors } = await buildServersFromSources(sources, sessionPath, managed.tokenRefreshManager, managed.agent.getSummarizeCallback())
      if (errors.length > 0) {
        sourceLog.warn(`Source build errors:`, errors)
      }

      // Set all sources for context (agent sees full list with descriptions, including built-ins)
      const allSources = loadAllSources(workspaceRootPath)
      managed.agent.setAllSources(allSources)

      // Set active source servers (tools are only available from these)
      const intendedSlugs = sources.filter(isSourceUsable).map(s => s.config.slug)

      // Update bridge-mcp-server config/credentials for backends that need it
      const usableSources = sources.filter(isSourceUsable)
      await applyBridgeUpdates(managed.agent, sessionPath, usableSources, mcpServers, managed.id, workspaceRootPath, 'source config change', managed.poolServer?.url)

      await managed.agent.setSourceServers(mcpServers, apiServers, intendedSlugs)

      sourceLog.info(`Applied ${Object.keys(mcpServers).length} MCP + ${Object.keys(apiServers).length} API sources to active agent (${allSources.length} total)`)
    }

    // Persist the session with updated sources
    this.deps.persistSession(managed)

    // Notify renderer of the source change
    this.deps.sendEvent({
      type: 'sources_changed',
      sessionId,
      enabledSourceSlugs: sourceSlugs,
    }, managed.workspace.id)

    sourceLog.info(`Session ${sessionId} sources updated: ${sourceSlugs.length} sources`)
  }

  /**
   * Get the enabled source slugs for a session.
   */
  getSessionSources(sessionId: string): string[] {
    const managed = this.deps.getSession(sessionId)
    return managed?.enabledSourceSlugs ?? []
  }
}
