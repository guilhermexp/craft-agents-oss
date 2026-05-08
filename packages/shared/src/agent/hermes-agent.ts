import { homedir } from 'node:os'
import { join } from 'node:path'

import { createACPProvider, ACP_PROVIDER_AGENT_DYNAMIC_TOOL_NAME, providerAgentDynamicToolSchema, type ACPProvider } from '@mcpc-tech/acp-ai-provider'
import type { PermissionOption, RequestPermissionRequest, RequestPermissionResponse } from '@agentclientprotocol/sdk'
import { generateText, streamText } from 'ai'

import type { AgentEvent } from '@craft-agent/core/types'

import { BaseAgent } from './base-agent.ts'
import type { BackendConfig, ChatOptions, PostInitResult, SdkMcpServerConfig } from './backend/types.ts'
import { AbortReason } from './backend/types.ts'
import { getBackendRuntime } from './backend/internal/driver-types.ts'
import type { FileAttachment } from '../utils/files.ts'
import type { PermissionMode } from './mode-manager.ts'
import type { LLMQueryRequest, LLMQueryResult } from './llm-tool.ts'
import { getActiveHermesProfile, type Workspace } from '../config/storage.ts'
import { applyHermesProfileToRuntime, buildHermesAcpMcpServers, isValidHermesProfileName, normalizeHermesRuntimeConfig, type HermesRuntimeConfig } from '../hermes/acp-config.ts'
import { seedHermesAuthFromCraft } from '../hermes/auth-bridge.ts'
import { CraftSessionToolsMcpServer } from '../mcp/session-tools-server.ts'
import { clearPlanFileState, mergeSessionScopedToolCallbacks, unregisterSessionScopedToolCallbacks } from './session-scoped-tools.ts'

type StreamToolPart = {
  type: 'tool-call' | 'tool-result'
  toolName: string
  input: unknown
  output?: unknown
}

type StreamTextDeltaPart = {
  text?: unknown
  delta?: unknown
}

type AcpPermissionHandler = (request: RequestPermissionRequest) => Promise<RequestPermissionResponse>

type AcpClientWithPermissionHandler = {
  setPermissionRequestHandler?: (handler: AcpPermissionHandler) => void
}

type AcpLanguageModelWithClient = {
  client?: AcpClientWithPermissionHandler
}

type AcpProviderInternalShape = {
  model?: AcpLanguageModelWithClient
}

type PendingAcpPermission = {
  resolve: (response: RequestPermissionResponse) => void
  options: PermissionOption[]
}

export function extractHermesTextDelta(part: StreamTextDeltaPart): string {
  if (typeof part.text === 'string') return part.text
  // @mcpc-tech/acp-ai-provider currently emits LanguageModelV3-style
  // text deltas as `{ type: 'text-delta', delta }`. The installed AI SDK
  // fullStream type exposes `{ text }`, so keep both shapes to avoid Hermes
  // completing a turn after tool calls without rendering the final answer.
  if (typeof part.delta === 'string') return part.delta
  return ''
}

function serializeToolResult(result: unknown): string {
  if (typeof result === 'string') return result
  if (result instanceof Error) return result.message
  try {
    return JSON.stringify(result, null, 2)
  } catch {
    return String(result)
  }
}

function modelIdAliases(modelId: string): string[] {
  const trimmed = modelId.trim()
  if (!trimmed) return []

  const aliases = new Set<string>([trimmed])
  const afterProvider = trimmed.includes(':') ? trimmed.split(':').pop() : undefined
  if (afterProvider) aliases.add(afterProvider)
  const afterSlash = trimmed.includes('/') ? trimmed.split('/').pop() : undefined
  if (afterSlash) aliases.add(afterSlash)
  return Array.from(aliases)
}

export function resolveHermesModelId(
  requestedModel: string | undefined,
  models?: { currentModelId?: string | null; availableModels?: Array<{ modelId: string }> | null } | null,
): string | undefined {
  const available = models?.availableModels
    ?.map(model => model.modelId)
    .filter((modelId): modelId is string => typeof modelId === 'string' && modelId.trim().length > 0) ?? []

  const requested = requestedModel?.trim()
  if (!requested) return models?.currentModelId || available[0]
  if (available.length === 0 || available.includes(requested)) return requested

  const directAliasMatch = available.find(candidate => modelIdAliases(candidate).includes(requested))
  if (directAliasMatch) return directAliasMatch

  const requestedAliases = modelIdAliases(requested)
  const match = available.find(candidate => {
    const candidateAliases = modelIdAliases(candidate)
    return requestedAliases.some(alias => candidateAliases.includes(alias))
  })

  // Prefer the explicit user request over Hermes' currentModelId. Falling back
  // to currentModelId silently routed Codex picks (gpt-5.5) into the dashboard's
  // main_model (claude-opus-*) and burned the wrong provider's quota.
  return match ?? requested
}

function buildHermesProcessEnv(runtime: ReturnType<typeof normalizeHermesRuntimeConfig>): Record<string, string> {
  const env: Record<string, string> = Object.fromEntries(
    Object.entries(process.env).filter((entry): entry is [string, string] => typeof entry[1] === 'string'),
  )
  env.HERMES_HOME = runtime.hermesHome
  const sep = process.platform === 'win32' ? ';' : ':'
  const agentRoot = process.env.CRAFT_HERMES_AGENT_ROOT?.trim()
  if (agentRoot) {
    env.PYTHONPATH = env.PYTHONPATH ? `${agentRoot}${sep}${env.PYTHONPATH}` : agentRoot
  }

  const pathEntries: string[] = []
  const virtualEnv = process.env.CRAFT_HERMES_VIRTUAL_ENV?.trim()
  if (virtualEnv) {
    env.VIRTUAL_ENV = virtualEnv
    pathEntries.push(join(virtualEnv, process.platform === 'win32' ? 'Scripts' : 'bin'))
  }
  const vendorBin = process.env.CRAFT_HERMES_VENDOR_BIN?.trim()
  if (vendorBin) pathEntries.push(vendorBin)
  if (pathEntries.length > 0) {
    env.PATH = `${pathEntries.join(sep)}${sep}${env.PATH ?? ''}`
  }

  return env
}

function stringifyAcpValue(value: unknown): string | undefined {
  if (typeof value === 'string') return value
  if (value === null || value === undefined) return undefined
  try {
    return JSON.stringify(value)
  } catch {
    return String(value)
  }
}

function getAcpToolCallCommand(request: RequestPermissionRequest): string | undefined {
  const rawInput = stringifyAcpValue(request.toolCall.rawInput)
  if (rawInput) return rawInput
  const title = request.toolCall.title?.trim()
  if (title) return title
  return undefined
}

function chooseAcpPermissionOption(
  options: PermissionOption[],
  allowed: boolean,
  alwaysAllow: boolean,
): PermissionOption | undefined {
  if (allowed) {
    if (alwaysAllow) {
      const allowAlways = options.find(option => option.kind === 'allow_always')
      if (allowAlways) return allowAlways
    }
    return options.find(option => option.kind === 'allow_once')
      ?? options.find(option => option.kind === 'allow_always')
  }

  return options.find(option => option.kind === 'reject_once')
    ?? options.find(option => option.kind === 'reject_always')
}

export class HermesAgent extends BaseAgent {
  protected backendName = 'Hermes'

  private provider: ACPProvider | null = null
  private providerRuntimeHome: string | null = null
  private hermesSessionId: string | null = null
  private isStreaming = false
  private abortController: AbortController | null = null
  private activeMcpServers: Record<string, SdkMcpServerConfig> = {}
  private pendingProviderRestart = false
  private sessionToolsServer: CraftSessionToolsMcpServer | null = null
  private sessionToolsServerUrl: string | undefined
  private pendingAcpPermissions = new Map<string, PendingAcpPermission>()

  constructor(config: BackendConfig) {
    super(config, config.model || '', 200_000)
    this._supportsBranching = false
    this.hermesSessionId = config.session?.sdkSessionId || null
    this.activeMcpServers = { ...(config.initialSources?.mcpServers ?? {}) }
    this.refreshSessionToolCallbacks()

    if (!config.isHeadless) {
      this.startConfigWatcher()
    }
  }

  override getSessionId(): string | null {
    return this.hermesSessionId
  }

  override setSessionId(sessionId: string | null): void {
    this.hermesSessionId = sessionId
  }

  override setWorkspace(workspace: Workspace): void {
    super.setWorkspace(workspace)
    this.hermesSessionId = null
    this.activeMcpServers = {}
    this.pendingProviderRestart = false
    this.provider?.cleanup()
    this.provider = null
    this.providerRuntimeHome = null
    void this.stopSessionToolsServer()
  }

  override clearHistory(): void {
    super.clearHistory()
    this.hermesSessionId = null
    this.pendingProviderRestart = false
    this.provider?.cleanup()
    this.provider = null
    this.providerRuntimeHome = null
  }

  private getRuntimeConfig() {
    const runtime = normalizeHermesRuntimeConfig(getBackendRuntime(this.config) as HermesRuntimeConfig)
    const sessionProfile = this.config.session?.hermesProfile?.trim()
    const activeProfile = getActiveHermesProfile()
    const profileName = sessionProfile && isValidHermesProfileName(sessionProfile)
      ? sessionProfile
      : activeProfile
    return applyHermesProfileToRuntime(runtime, isValidHermesProfileName(profileName) ? profileName : 'default')
  }

  private resolvedCwd(): string {
    if (this.workingDirectory === '~') return homedir()
    if (this.workingDirectory.startsWith('~/')) return join(homedir(), this.workingDirectory.slice(2))
    return this.workingDirectory
  }

  private getCraftSessionId(): string | undefined {
    return this.config.session?.id
  }

  private refreshSessionToolCallbacks(): void {
    const sessionId = this.getCraftSessionId()
    if (!sessionId) return

    // Merge instead of replace so Electron-provided browserPaneFns survive.
    mergeSessionScopedToolCallbacks(sessionId, {
      onPlanSubmitted: (planPath) => this.onPlanSubmitted?.(planPath),
      onAuthRequest: (request) => this.onAuthRequest?.(request),
      queryFn: (request) => this.queryLlm(request),
      spawnSessionFn: (input) => this.preExecuteSpawnSession(input),
    })
  }

  private async ensureSessionToolsServer(): Promise<string | undefined> {
    const sessionId = this.getCraftSessionId()
    if (!sessionId || this.config.isHeadless) return undefined
    if (this.sessionToolsServerUrl) return this.sessionToolsServerUrl

    this.refreshSessionToolCallbacks()
    this.sessionToolsServer = new CraftSessionToolsMcpServer({
      sessionId,
      workspaceRootPath: this.config.workspace.rootPath,
      workspaceId: this.config.workspace.id,
      debug: (message) => this.onDebug?.(message),
      defaultLlmConnection: this.config.connectionSlug,
      defaultModel: this._model || this.config.model,
      automationSystem: this.config.automationSystem,
    })
    this.sessionToolsServerUrl = await this.sessionToolsServer.start()
    return this.sessionToolsServerUrl
  }

  private async stopSessionToolsServer(): Promise<void> {
    const server = this.sessionToolsServer
    this.sessionToolsServer = null
    this.sessionToolsServerUrl = undefined
    await server?.stop().catch(() => {})
  }

  private async getOrCreateProvider(): Promise<ACPProvider> {
    const runtime = this.getRuntimeConfig()
    if (this.provider && this.providerRuntimeHome === runtime.hermesHome) return this.provider

    if (this.provider) {
      this.provider.cleanup()
      this.provider = null
      this.providerRuntimeHome = null
      this.hermesSessionId = null
    }

    const sessionToolsServerUrl = await this.ensureSessionToolsServer()
    const baseEnv = buildHermesProcessEnv(runtime)
    let bridgedEnv: Record<string, string> = {}
    try {
      const seed = await seedHermesAuthFromCraft({
        hermesHome: runtime.hermesHome,
        connectionSlug: this.config.connectionSlug,
        model: this._model || this.config.model,
      })
      bridgedEnv = seed.env
      if (seed.seededProviders.length > 0) {
        this.onDebug?.(
          `[hermes-auth-bridge] seeded ${seed.seededProviders.join(', ')} from Craft (active=${seed.activeProvider ?? 'unset'})`,
        )
      }
    } catch (err) {
      this.onDebug?.(`[hermes-auth-bridge] seed failed (non-fatal): ${err instanceof Error ? err.message : String(err)}`)
    }
    this.provider = createACPProvider({
      command: runtime.command,
      args: runtime.args,
      env: { ...baseEnv, ...bridgedEnv },
      session: {
        cwd: this.resolvedCwd(),
        mcpServers: buildHermesAcpMcpServers({
          mcpServers: this.activeMcpServers,
          poolServerUrl: this.config.poolServerUrl,
          sessionToolsServerUrl,
        }),
      },
      ...(this.hermesSessionId ? { existingSessionId: this.hermesSessionId } : {}),
      persistSession: true,
    })
    this.providerRuntimeHome = runtime.hermesHome

    return this.provider
  }

  private installAcpPermissionHandler(provider: ACPProvider): void {
    const client = (provider as unknown as AcpProviderInternalShape).model?.client
    if (!client?.setPermissionRequestHandler) return

    client.setPermissionRequestHandler(async (request: RequestPermissionRequest) => this.handleAcpPermissionRequest(request))
  }

  private async handleAcpPermissionRequest(request: RequestPermissionRequest): Promise<RequestPermissionResponse> {
    if (!this.onPermissionRequest) {
      this.onDebug?.('[hermes-permission] ACP permission request received without UI handler; denying')
      return { outcome: { outcome: 'cancelled' } }
    }

    const requestId = `hermes-acp-${Date.now()}-${Math.random().toString(36).slice(2)}`
    const command = getAcpToolCallCommand(request)
    const toolName = request.toolCall.title?.trim() || request.toolCall.kind || 'Hermes tool'
    const description = command ? `Hermes wants to run: ${command}` : 'Hermes wants to run a protected action.'

    return await new Promise<RequestPermissionResponse>((resolve) => {
      this.pendingAcpPermissions.set(requestId, { resolve, options: request.options })
      this.onPermissionRequest?.({
        requestId,
        toolName,
        command,
        description,
        type: request.toolCall.kind === 'execute' ? 'bash' : 'api_mutation',
      })
    })
  }

  override async postInit(): Promise<PostInitResult> {
    this.refreshSessionToolCallbacks()
    await this.ensureSessionToolsServer()

    const initial = this.config.initialSources
    if (initial) {
      this.setAllSources(initial.enabledSources)
      // When poolServerUrl is set, SessionManager has already synced the MCP pool
      // before constructing the agent. Skip the redundant sync here; just track
      // intended state via SourceManager so getActiveSourceSlugs() stays correct.
      if (this.config.poolServerUrl) {
        this.sourceManager.updateActiveState(
          Object.keys(initial.mcpServers),
          Object.keys(initial.apiServers),
          initial.enabledSlugs,
        )
        this.activeMcpServers = { ...initial.mcpServers }
      } else {
        await this.setSourceServers(initial.mcpServers, initial.apiServers, initial.enabledSlugs)
      }
    }

    return { authInjected: true }
  }

  override async setSourceServers(
    mcpServers: Record<string, SdkMcpServerConfig>,
    apiServers: Record<string, unknown>,
    intendedSlugs?: string[],
  ): Promise<void> {
    await super.setSourceServers(mcpServers, apiServers, intendedSlugs)

    const previousKeys = Object.keys(this.activeMcpServers).sort()
    const nextKeys = Object.keys(mcpServers).sort()
    const descriptorsChanged =
      previousKeys.length !== nextKeys.length ||
      previousKeys.some((key, idx) => key !== nextKeys[idx])

    this.activeMcpServers = { ...mcpServers }

    if (!descriptorsChanged) return

    // ACP sends MCP server descriptors only during session creation/load/resume.
    // Restart provider so the next turn recreates the Hermes session with the new
    // descriptor set. Defer when a stream is active to avoid killing the subprocess
    // mid-response; chatImpl applies the pending restart in finally.
    if (this.isStreaming) {
      this.pendingProviderRestart = true
      return
    }

    this.provider?.cleanup()
    this.provider = null
    this.providerRuntimeHome = null
  }

  protected async *chatImpl(
    message: string,
    attachments?: FileAttachment[],
    _options?: ChatOptions,
  ): AsyncGenerator<AgentEvent> {
    this.isStreaming = true
    this.abortController = new AbortController()

    const provider = await this.getOrCreateProvider()
    const sessionInfo = await provider.initSession()
    this.installAcpPermissionHandler(provider)

    this.hermesSessionId = provider.getSessionId() || sessionInfo.sessionId || null
    if (this.hermesSessionId) {
      this.config.onSdkSessionIdUpdate?.(this.hermesSessionId)
    }

    const selectedModel = resolveHermesModelId(this._model || undefined, sessionInfo.models)
    if (selectedModel) {
      this._model = selectedModel
      await provider.setModel(selectedModel).catch(() => {})
    } else if (sessionInfo.models?.currentModelId) {
      this._model = sessionInfo.models.currentModelId
    }

    const attachmentHint = attachments?.length
      ? `\n\nAttached files:\n${attachments.map(file => `- ${file.path}`).join('\n')}`
      : ''

    const result = streamText({
      model: provider.languageModel(resolveHermesModelId(this._model || undefined, sessionInfo.models)),
      tools: provider.tools as Parameters<typeof streamText>[0]['tools'],
      abortSignal: this.abortController.signal,
      messages: [
        {
          role: 'user',
          content: [{ type: 'text', text: `${message}${attachmentHint}` }],
        },
      ],
    })

    let finalText = ''

    try {
      for await (const part of result.fullStream) {
        switch (part.type) {
          case 'text-delta': {
            const delta = extractHermesTextDelta(part)
            if (!delta) break
            finalText += delta
            yield { type: 'text_delta', text: delta }
            break
          }
          case 'tool-call': {
            const toolPart = part as StreamToolPart
            if (toolPart.toolName !== ACP_PROVIDER_AGENT_DYNAMIC_TOOL_NAME) break
            const parsed = providerAgentDynamicToolSchema.safeParse(toolPart.input)
            if (!parsed.success) break
            yield {
              type: 'tool_start',
              toolName: parsed.data.toolName,
              toolUseId: parsed.data.toolCallId,
              input: parsed.data.args,
              displayName: parsed.data.toolName,
            }
            break
          }
          case 'tool-result': {
            const toolPart = part as StreamToolPart
            if (toolPart.toolName !== ACP_PROVIDER_AGENT_DYNAMIC_TOOL_NAME) break
            const parsed = providerAgentDynamicToolSchema.safeParse(toolPart.input)
            if (!parsed.success) break
            yield {
              type: 'tool_result',
              toolUseId: parsed.data.toolCallId,
              toolName: parsed.data.toolName,
              input: parsed.data.args,
              result: serializeToolResult(toolPart.output),
              isError: toolPart.output instanceof Error,
            }
            break
          }
        }
      }

      if (finalText) {
        yield { type: 'text_complete', text: finalText }
      }

      yield { type: 'complete' }
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error)
      yield { type: 'error', message }
    } finally {
      this.hermesSessionId = provider.getSessionId() || this.hermesSessionId
      if (this.hermesSessionId) {
        this.config.onSdkSessionIdUpdate?.(this.hermesSessionId)
      }
      this.isStreaming = false
      this.abortController = null

      if (this.pendingProviderRestart) {
        this.pendingProviderRestart = false
        this.provider?.cleanup()
        this.provider = null
        this.providerRuntimeHome = null
      }
    }
  }

  async abort(_reason?: string): Promise<void> {
    this.abortController?.abort()
    this.isStreaming = false
  }

  override forceAbort(_reason: AbortReason): void {
    this.abortController?.abort()
    this.isStreaming = false
  }

  override interruptForHandoff(reason: AbortReason): void {
    this.forceAbort(reason)
  }

  override isProcessing(): boolean {
    return this.isStreaming
  }

  override respondToPermission(requestId: string, allowed: boolean, alwaysAllow?: boolean): void {
    const pending = this.pendingAcpPermissions.get(requestId)
    if (!pending) return

    this.pendingAcpPermissions.delete(requestId)
    const option = chooseAcpPermissionOption(
      pending.options,
      allowed,
      alwaysAllow ?? false,
    )
    pending.resolve({
      outcome: option
        ? { outcome: 'selected', optionId: option.optionId }
        : { outcome: 'cancelled' },
    })
  }

  async runMiniCompletion(prompt: string): Promise<string | null> {
    const provider = await this.getOrCreateProvider()
    const sessionInfo = await provider.initSession()
    this.hermesSessionId = provider.getSessionId() || sessionInfo.sessionId || this.hermesSessionId

    const result = await generateText({
      model: provider.languageModel(resolveHermesModelId(this.config.miniModel || this._model || undefined, sessionInfo.models)),
      prompt,
    })

    return result.text || null
  }

  async queryLlm(request: LLMQueryRequest): Promise<LLMQueryResult> {
    const text = await this.runMiniCompletion(request.prompt)
    return {
      text: text || '',
      model: request.model || this.config.miniModel || this._model,
    }
  }

  override updateWorkingDirectory(path: string): void {
    super.updateWorkingDirectory(path)
    this.provider?.cleanup()
    this.provider = null
    this.providerRuntimeHome = null
  }

  override destroy(): void {
    this.provider?.cleanup()
    this.provider = null
    this.providerRuntimeHome = null
    this.abortController?.abort()
    this.abortController = null
    this.isStreaming = false
    this.pendingProviderRestart = false
    void this.stopSessionToolsServer()

    const sessionId = this.getCraftSessionId()
    if (sessionId) {
      clearPlanFileState(sessionId)
      unregisterSessionScopedToolCallbacks(sessionId)
    }
  }

  override dispose(): void {
    this.destroy()
  }
}
