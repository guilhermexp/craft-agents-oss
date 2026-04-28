import { homedir } from 'node:os'
import { join } from 'node:path'

import { createACPProvider, ACP_PROVIDER_AGENT_DYNAMIC_TOOL_NAME, providerAgentDynamicToolSchema, type ACPProvider } from '@mcpc-tech/acp-ai-provider'
import { generateText, streamText } from 'ai'

import type { AgentEvent } from '@craft-agent/core/types'

import { BaseAgent } from './base-agent.ts'
import type { BackendConfig, ChatOptions, PostInitResult, SdkMcpServerConfig } from './backend/types.ts'
import { AbortReason } from './backend/types.ts'
import { getBackendRuntime } from './backend/internal/driver-types.ts'
import type { FileAttachment } from '../utils/files.ts'
import type { PermissionMode } from './mode-manager.ts'
import type { LLMQueryRequest, LLMQueryResult } from './llm-tool.ts'
import type { Workspace } from '../config/storage.ts'
import { buildHermesAcpMcpServers, normalizeHermesRuntimeConfig, type HermesRuntimeConfig } from '../hermes/acp-config.ts'

type StreamToolPart = {
  type: 'tool-call' | 'tool-result'
  toolName: string
  input: unknown
  output?: unknown
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

export class HermesAgent extends BaseAgent {
  protected backendName = 'Hermes'

  private provider: ACPProvider | null = null
  private hermesSessionId: string | null = null
  private isStreaming = false
  private abortController: AbortController | null = null
  private activeMcpServers: Record<string, SdkMcpServerConfig> = {}
  private pendingProviderRestart = false

  constructor(config: BackendConfig) {
    super(config, config.model || '', 200_000)
    this._supportsBranching = false
    this.hermesSessionId = config.session?.sdkSessionId || null
    this.activeMcpServers = { ...(config.initialSources?.mcpServers ?? {}) }

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
  }

  override clearHistory(): void {
    super.clearHistory()
    this.hermesSessionId = null
    this.pendingProviderRestart = false
    this.provider?.cleanup()
    this.provider = null
  }

  private getRuntimeConfig() {
    return normalizeHermesRuntimeConfig(getBackendRuntime(this.config) as HermesRuntimeConfig)
  }

  private resolvedCwd(): string {
    if (this.workingDirectory === '~') return homedir()
    if (this.workingDirectory.startsWith('~/')) return join(homedir(), this.workingDirectory.slice(2))
    return this.workingDirectory
  }

  private getOrCreateProvider(): ACPProvider {
    if (this.provider) return this.provider

    const runtime = this.getRuntimeConfig()
    this.provider = createACPProvider({
      command: runtime.command,
      args: runtime.args,
      env: {
        ...process.env,
        HERMES_HOME: runtime.hermesHome,
      },
      session: {
        cwd: this.resolvedCwd(),
        mcpServers: buildHermesAcpMcpServers({
          mcpServers: this.activeMcpServers,
          poolServerUrl: this.config.poolServerUrl,
        }),
      },
      ...(this.hermesSessionId ? { existingSessionId: this.hermesSessionId } : {}),
      persistSession: true,
    })

    return this.provider
  }

  override async postInit(): Promise<PostInitResult> {
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
  }

  protected async *chatImpl(
    message: string,
    attachments?: FileAttachment[],
    _options?: ChatOptions,
  ): AsyncGenerator<AgentEvent> {
    this.isStreaming = true
    this.abortController = new AbortController()

    const provider = this.getOrCreateProvider()
    const sessionInfo = await provider.initSession()

    this.hermesSessionId = provider.getSessionId() || sessionInfo.sessionId || null
    if (this.hermesSessionId) {
      this.config.onSdkSessionIdUpdate?.(this.hermesSessionId)
    }

    if (this._model) {
      await provider.setModel(this._model).catch(() => {})
    } else if (sessionInfo.models?.currentModelId) {
      this._model = sessionInfo.models.currentModelId
    }

    const attachmentHint = attachments?.length
      ? `\n\nAttached files:\n${attachments.map(file => `- ${file.path}`).join('\n')}`
      : ''

    const result = streamText({
      model: provider.languageModel(this._model || undefined),
      tools: provider.tools,
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
          case 'text-delta':
            finalText += part.text
            yield { type: 'text_delta', text: part.text }
            break
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

  override respondToPermission(_requestId: string, _allowed: boolean, _alwaysAllow?: boolean): void {
    // Hermes handles its own local runtime permission UX.
  }

  async runMiniCompletion(prompt: string): Promise<string | null> {
    const provider = this.getOrCreateProvider()
    const sessionInfo = await provider.initSession()
    this.hermesSessionId = provider.getSessionId() || sessionInfo.sessionId || this.hermesSessionId

    const result = await generateText({
      model: provider.languageModel(this.config.miniModel || this._model || undefined),
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
  }

  override destroy(): void {
    this.provider?.cleanup()
    this.provider = null
    this.abortController?.abort()
    this.abortController = null
    this.isStreaming = false
    this.pendingProviderRestart = false
  }

  override dispose(): void {
    this.destroy()
  }
}
