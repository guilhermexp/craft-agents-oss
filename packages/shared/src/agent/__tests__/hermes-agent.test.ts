/**
 * Tests for HermesAgent overrides — focus on the source-update lifecycle.
 *
 * The ACP provider is a heavy subprocess we never want to spawn from a unit
 * test, so we exercise the public surface (postInit, setSourceServers, the
 * chat finally block) and assert on observable side-effects: provider
 * teardown, pendingProviderRestart flag, and mcpPool.sync calls.
 */
import { describe, it, expect, beforeEach, afterEach } from 'bun:test'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { ACPProvider } from '@mcpc-tech/acp-ai-provider'
import type { RequestPermissionRequest } from '@agentclientprotocol/sdk'

import { HermesAgent, buildCraftSessionContextPrompt, extractHermesTextDelta, resolveHermesModelId, isHermesSubprocessIoError } from '../hermes-agent.ts'
import { createMockBackendConfig, createMockSession, createMockWorkspace } from './test-utils.ts'
import { AbortReason, type BackendConfig, type SdkMcpServerConfig } from '../backend/types.ts'
import type { NormalizedHermesRuntimeConfig } from '../../hermes/acp-config.ts'
import { warRoomChannelId } from '../../channels/types.ts'
import { saveChannelsConfig } from '../../channels/storage.ts'
import { saveLabelConfig } from '../../labels/storage.ts'
import { createSession } from '../../sessions/storage.ts'

type FakeProvider = {
  cleanup: () => void
  cleanupCount: number
}

type HermesAgentPermissionInstaller = {
  installAcpPermissionHandler: (provider: ACPProvider) => void
}

function makeFakeProvider(): FakeProvider {
  const provider: FakeProvider = {
    cleanupCount: 0,
    cleanup: () => {
      provider.cleanupCount += 1
    },
  }
  return provider
}

function createHermesConfig(overrides: Partial<BackendConfig> = {}): BackendConfig {
  return createMockBackendConfig({ provider: 'hermes', isHeadless: true, ...overrides })
}

class TestableHermesAgent extends HermesAgent {
  setProviderForTest(provider: unknown): void {
    ;(this as unknown as { provider: unknown }).provider = provider
  }
  getProviderForTest(): unknown {
    return (this as unknown as { provider: unknown }).provider
  }
  getActiveMcpServersForTest(): Record<string, SdkMcpServerConfig> {
    return (this as unknown as { activeMcpServers: Record<string, SdkMcpServerConfig> }).activeMcpServers
  }
  getPendingRestartForTest(): boolean {
    return (this as unknown as { pendingProviderRestart: boolean }).pendingProviderRestart
  }
  setStreamingForTest(value: boolean): void {
    ;(this as unknown as { isStreaming: boolean }).isStreaming = value
  }
  applyPendingRestartForTest(): void {
    if (this.getPendingRestartForTest()) {
      ;(this as unknown as { pendingProviderRestart: boolean }).pendingProviderRestart = false
      ;(this.getProviderForTest() as { cleanup?: () => void } | null)?.cleanup?.()
      ;(this as unknown as { provider: unknown }).provider = null
    }
  }
  getRuntimeConfigForTest(): NormalizedHermesRuntimeConfig {
    return (this as unknown as { getRuntimeConfig: () => NormalizedHermesRuntimeConfig }).getRuntimeConfig()
  }
  installAcpPermissionHandlerForTest(provider: ACPProvider): void {
    ;(this as unknown as HermesAgentPermissionInstaller).installAcpPermissionHandler(provider)
  }
  buildCraftSessionContextForTest(message: string): string | null {
    return (this as unknown as { buildCraftSessionContextForTurn: (message: string) => string | null }).buildCraftSessionContextForTurn(message)
  }
  observeProviderProcessExitForTest(provider: unknown): void {
    ;(this as unknown as { observeProviderProcessExit: (provider: unknown) => void }).observeProviderProcessExit(provider)
  }
}



describe('buildCraftSessionContextPrompt', () => {
  it('injects matching Craft channel metadata from session labels', () => {
    const prompt = buildCraftSessionContextPrompt({
      workspace: createMockWorkspace({ id: 'workspace-1', name: 'Client Workspace' }),
      session: createMockSession({
        id: 'session-1',
        name: 'Eae baum?',
        labels: ['certfacil'],
        sessionStatus: 'todo',
      }),
      labels: [{ id: 'certfacil', name: 'Cert Fácil' }],
      channels: [{
        id: warRoomChannelId('channel-certfacil'),
        name: 'certfacil',
        description: 'Cliente Cert Fácil — certificados digitais',
        labelId: 'channel-certfacil',
        workingDirectory: '/work/certfacil',
      }],
    })

    expect(prompt).toContain('<<craft-session-context hidden-from-user>>')
    expect(prompt).toContain('Workspace: Client Workspace')
    expect(prompt).toContain('Craft session title: Eae baum?')
    expect(prompt).toContain('Session labels: Cert Fácil (certfacil)')
    expect(prompt).toContain('Active Craft channel context:')
    expect(prompt).toContain('#certfacil')
    expect(prompt).toContain('description: Cliente Cert Fácil')
    expect(prompt).toContain('Privacy rule: do not mix data')
  })

  it('falls back to labels when no War Room channel matches', () => {
    const prompt = buildCraftSessionContextPrompt({
      workspace: createMockWorkspace(),
      session: createMockSession({ labels: ['client-x'] }),
      labels: [{ id: 'client-x', name: 'Client X' }],
      channels: [],
    })

    expect(prompt).toContain('Session labels: Client X (client-x)')
    expect(prompt).toContain('No matching War Room channel metadata was found')
  })
})



describe('HermesAgent Craft session context refresh', () => {
  const tempDirs: string[] = []

  afterEach(() => {
    for (const dir of tempDirs.splice(0)) rmSync(dir, { recursive: true, force: true })
  })

  it('refreshes labels from disk instead of using the stale session snapshot', async () => {
    const workspaceRoot = mkdtempSync(join(process.env.HOME!, '.craft-hermes-context-refresh-'))
    tempDirs.push(workspaceRoot)
    saveLabelConfig(workspaceRoot, {
      version: 1,
      labels: [{ id: 'channel-clients', name: 'Clients' }],
    })
    saveChannelsConfig(workspaceRoot, {
      version: 1,
      channels: [{
        id: warRoomChannelId('clients'),
        name: 'Clients',
        description: 'Canal dedicado para tratar de assuntos relacionados a clientes',
        labelId: 'channel-clients',
      }],
    })
    const diskSession = await createSession(workspaceRoot, {
      name: 'Eae baum?',
      labels: ['channel-clients'],
      llmConnection: 'hermes',
    })
    const staleSession = { ...diskSession, labels: undefined }
    const agent = new TestableHermesAgent(createHermesConfig({
      workspace: createMockWorkspace({ id: 'workspace-1', name: 'Code - Workspace', rootPath: `~/${workspaceRoot.slice(process.env.HOME!.length + 1)}` }),
      session: staleSession,
    }))

    const prompt = agent.buildCraftSessionContextForTest('Veja nao ta funcionando direito ainda nao ne?')

    expect(prompt).toContain('Session labels: Clients (channel-clients)')
    expect(prompt).toContain('Active Craft channel context:')
    expect(prompt).toContain('#Clients')
    expect(prompt).toContain('Canal dedicado para tratar de assuntos relacionados a clientes')
  })
})

describe('extractHermesTextDelta', () => {
  it('reads AI SDK text-delta parts with text field', () => {
    expect(extractHermesTextDelta({ text: 'oi' })).toBe('oi')
  })

  it('reads ACP provider text-delta parts with delta field', () => {
    expect(extractHermesTextDelta({ delta: 'baum?' })).toBe('baum?')
  })

  it('returns empty string for malformed delta parts', () => {
    expect(extractHermesTextDelta({ text: undefined, delta: 123 })).toBe('')
  })
})

describe('resolveHermesModelId', () => {
  const models = {
    currentModelId: 'openrouter:gpt-5.5',
    availableModels: [
      { modelId: 'openrouter:gpt-5.5' },
      { modelId: 'openrouter:openai/gpt-5.5' },
      { modelId: 'openrouter:anthropic/claude-sonnet-4.6' },
    ],
  }

  it('maps bare model ids to Hermes ACP model ids', () => {
    expect(resolveHermesModelId('gpt-5.5', models)).toBe('openrouter:gpt-5.5')
  })

  it('maps provider/model ids to the matching Hermes ACP id', () => {
    expect(resolveHermesModelId('openai/gpt-5.5', models)).toBe('openrouter:openai/gpt-5.5')
  })

  it('keeps exact Hermes ids unchanged', () => {
    expect(resolveHermesModelId('openrouter:anthropic/claude-sonnet-4.6', models)).toBe('openrouter:anthropic/claude-sonnet-4.6')
  })

  it('preserves the user-requested model when no alias maps into Hermes available list', () => {
    // Previously the code silently fell back to Hermes currentModelId here,
    // which routed e.g. a Codex pick into Anthropic and burned the wrong
    // provider's quota. The user pick wins.
    expect(resolveHermesModelId('claude-opus-4-7', models)).toBe('claude-opus-4-7')
  })
})

describe('HermesAgent runtime profile resolution', () => {
  it('uses the persisted session profile when deriving HERMES_HOME', () => {
    const session = { ...createMockSession(), hermesProfile: 'session-profile-test' }
    const agent = new TestableHermesAgent(createHermesConfig({
      session,
      runtime: {
        command: 'hermes',
        args: ['acp'],
        hermesHome: '/tmp/craft-hermes-test-home',
      },
    }))

    expect(agent.getRuntimeConfigForTest().hermesHome).toBe('/tmp/craft-hermes-test-home/profiles/session-profile-test')
  })
})

describe('HermesAgent.setSourceServers', () => {
  let agent: TestableHermesAgent
  let provider: FakeProvider

  beforeEach(() => {
    agent = new TestableHermesAgent(createHermesConfig())
    provider = makeFakeProvider()
    agent.setProviderForTest(provider)
  })

  it('does not tear down provider when descriptor set is unchanged', async () => {
    const servers: Record<string, SdkMcpServerConfig> = {
      a: { type: 'http', url: 'http://example.test/a' },
    }
    // Seed activeMcpServers via a first call (which intentionally triggers
    // cleanup of the original provider since {} -> {a:...} is a descriptor change).
    await agent.setSourceServers(servers, {}, ['a'])
    const fresh = makeFakeProvider()
    agent.setProviderForTest(fresh)

    await agent.setSourceServers(servers, {}, ['a'])

    expect(fresh.cleanupCount).toBe(0)
    expect(agent.getProviderForTest()).toBe(fresh)
  })

  it('restarts provider when descriptor set changes and no stream is active', async () => {
    const initial: Record<string, SdkMcpServerConfig> = {
      a: { type: 'http', url: 'http://example.test/a' },
    }
    // Seed activeMcpServers without exercising the cleanup path (initial set
    // differs from empty default, which would consume the fake provider).
    await agent.setSourceServers(initial, {}, ['a'])
    const fresh = makeFakeProvider()
    agent.setProviderForTest(fresh)

    const next: Record<string, SdkMcpServerConfig> = {
      a: { type: 'http', url: 'http://example.test/a' },
      b: { type: 'http', url: 'http://example.test/b' },
    }
    await agent.setSourceServers(next, {}, ['a', 'b'])

    expect(fresh.cleanupCount).toBe(1)
    expect(agent.getProviderForTest()).toBeNull()
    expect(agent.getActiveMcpServersForTest()).toEqual(next)
  })

  it('defers provider teardown while a stream is active and applies it on stream completion', async () => {
    const initial: Record<string, SdkMcpServerConfig> = {
      a: { type: 'http', url: 'http://example.test/a' },
    }
    await agent.setSourceServers(initial, {}, ['a'])
    const fresh = makeFakeProvider()
    agent.setProviderForTest(fresh)
    agent.setStreamingForTest(true)

    const next: Record<string, SdkMcpServerConfig> = {
      b: { type: 'http', url: 'http://example.test/b' },
    }
    await agent.setSourceServers(next, {}, ['b'])

    // Provider must NOT be cleaned up mid-stream.
    expect(fresh.cleanupCount).toBe(0)
    expect(agent.getProviderForTest()).toBe(fresh)
    expect(agent.getPendingRestartForTest()).toBe(true)
    expect(agent.getActiveMcpServersForTest()).toEqual(next)

    // Simulate the chatImpl finally block.
    agent.setStreamingForTest(false)
    agent.applyPendingRestartForTest()

    expect(fresh.cleanupCount).toBe(1)
    expect(agent.getProviderForTest()).toBeNull()
    expect(agent.getPendingRestartForTest()).toBe(false)
  })
})

describe('HermesAgent subprocess death recovery (F2.1)', () => {
  type FakeProviderWithProcess = FakeProvider & {
    model: { agentProcess: { once: (event: string, cb: () => void) => void } }
    fireExit: () => void
  }

  function makeFakeProviderWithProcess(): FakeProviderWithProcess {
    let exitListener: (() => void) | null = null
    const provider = {
      ...makeFakeProvider(),
      model: {
        agentProcess: {
          once: (event: string, cb: () => void) => {
            if (event === 'exit') exitListener = cb
          },
        },
      },
      fireExit: () => exitListener?.(),
    }
    // makeFakeProvider's cleanup closes over its own counter object; rebind.
    provider.cleanup = () => { provider.cleanupCount += 1 }
    return provider
  }

  let agent: TestableHermesAgent

  beforeEach(() => {
    agent = new TestableHermesAgent(createHermesConfig())
  })

  it('idle subprocess exit drops the stale provider so the next turn respawns', () => {
    const provider = makeFakeProviderWithProcess()
    agent.setProviderForTest(provider)
    agent.observeProviderProcessExitForTest(provider)

    provider.fireExit()

    expect(provider.cleanupCount).toBe(1)
    expect(agent.getProviderForTest()).toBeNull()
  })

  it('mid-turn subprocess exit defers the reset to the streaming finally block', () => {
    const provider = makeFakeProviderWithProcess()
    agent.setProviderForTest(provider)
    agent.observeProviderProcessExitForTest(provider)
    agent.setStreamingForTest(true)

    provider.fireExit()

    // Not torn down mid-stream — flagged for the finally reset.
    expect(provider.cleanupCount).toBe(0)
    expect(agent.getProviderForTest()).toBe(provider)
    expect(agent.getPendingRestartForTest()).toBe(true)

    agent.setStreamingForTest(false)
    agent.applyPendingRestartForTest()

    expect(provider.cleanupCount).toBe(1)
    expect(agent.getProviderForTest()).toBeNull()
  })

  it('exit from an intentionally replaced provider is a no-op', () => {
    const stale = makeFakeProviderWithProcess()
    agent.setProviderForTest(stale)
    agent.observeProviderProcessExitForTest(stale)

    // Intentional teardown/replacement (e.g. runtime switch) before exit fires.
    const fresh = makeFakeProviderWithProcess()
    agent.setProviderForTest(fresh)

    stale.fireExit()

    expect(fresh.cleanupCount).toBe(0)
    expect(agent.getProviderForTest()).toBe(fresh)
    expect(agent.getPendingRestartForTest()).toBe(false)
  })

  it('registers the exit observer only once per subprocess', () => {
    let onceCalls = 0
    const provider = makeFakeProviderWithProcess()
    const origOnce = provider.model.agentProcess.once
    provider.model.agentProcess.once = (event, cb) => { onceCalls += 1; origOnce(event, cb) }
    agent.setProviderForTest(provider)

    agent.observeProviderProcessExitForTest(provider)
    agent.observeProviderProcessExitForTest(provider)

    expect(onceCalls).toBe(1)
  })
})

describe('isHermesSubprocessIoError (F2.1)', () => {
  it('matches dead-pipe I/O signatures', () => {
    expect(isHermesSubprocessIoError('write EPIPE')).toBe(true)
    expect(isHermesSubprocessIoError('read ECONNRESET')).toBe(true)
    expect(isHermesSubprocessIoError('Cannot call write after a stream was destroyed [ERR_STREAM_DESTROYED]')).toBe(true)
    expect(isHermesSubprocessIoError('write after end')).toBe(true)
    expect(isHermesSubprocessIoError('Premature close')).toBe(true)
  })

  it('does not match business errors like rate limits', () => {
    expect(isHermesSubprocessIoError('429 rate limit exceeded, retry after 30s')).toBe(false)
    expect(isHermesSubprocessIoError('Invalid API key provided')).toBe(false)
    expect(isHermesSubprocessIoError('model overloaded, please retry')).toBe(false)
    expect(isHermesSubprocessIoError('context window exceeded')).toBe(false)
  })
})

describe('HermesAgent abort — orphan ACP notification guard', () => {
  type FakeAcpInternals = {
    provider: { cleanup: () => void }
    installedHandlers: Array<(notification: unknown) => void>
    cancelCalls: Array<{ sessionId: string }>
  }

  function makeProviderWithAcpInternals(sessionId: string | null): FakeAcpInternals {
    const installedHandlers: Array<(notification: unknown) => void> = []
    const cancelCalls: Array<{ sessionId: string }> = []
    const provider = {
      cleanup: () => {},
      model: {
        client: {
          setSessionUpdateHandler: (handler: (notification: unknown) => void) => {
            installedHandlers.push(handler)
          },
        },
        connection: {
          cancel: async (params: { sessionId: string }) => {
            cancelCalls.push(params)
          },
        },
        getSessionId: () => sessionId,
      },
    }
    return { provider, installedHandlers, cancelCalls }
  }

  it('detaches the session-update handler and sends session/cancel on abort', async () => {
    const agent = new TestableHermesAgent(createHermesConfig())
    const internals = makeProviderWithAcpInternals('hermes-session-1')
    agent.setProviderForTest(internals.provider)

    await agent.abort()

    // session/cancel was sent for the live session.
    expect(internals.cancelCalls).toEqual([{ sessionId: 'hermes-session-1' }])
    // A no-op handler was installed; invoking it must not throw (this is what
    // absorbs late notifications that would otherwise hit a closed controller).
    expect(internals.installedHandlers).toHaveLength(1)
    expect(() => internals.installedHandlers[0]!({ sessionUpdate: 'agent_thought_chunk' })).not.toThrow()
  })

  it('forceAbort also detaches the handler and cancels', () => {
    const agent = new TestableHermesAgent(createHermesConfig())
    const internals = makeProviderWithAcpInternals('hermes-session-2')
    agent.setProviderForTest(internals.provider)

    agent.forceAbort(AbortReason.UserStop)

    expect(internals.cancelCalls).toEqual([{ sessionId: 'hermes-session-2' }])
    expect(internals.installedHandlers).toHaveLength(1)
  })

  it('is a no-op without a session id (no cancel sent, no throw)', async () => {
    const agent = new TestableHermesAgent(createHermesConfig())
    const internals = makeProviderWithAcpInternals(null)
    agent.setProviderForTest(internals.provider)

    await agent.abort()

    // No session id -> no cancel notification, but the handler is still detached.
    expect(internals.cancelCalls).toEqual([])
    expect(internals.installedHandlers).toHaveLength(1)
  })
})

describe('HermesAgent.postInit', () => {
  it('skips redundant mcpPool.sync when SessionManager has already populated the pool', async () => {
    let syncCalls = 0
    const fakePool = {
      sync: async () => {
        syncCalls += 1
      },
      hasServer: () => false,
    } as unknown as BackendConfig['mcpPool']

    const agent = new TestableHermesAgent(
      createHermesConfig({
        mcpPool: fakePool,
        poolServerUrl: 'http://127.0.0.1:42424/mcp',
        initialSources: {
          mcpServers: { a: { type: 'http', url: 'http://example.test/a' } },
          apiServers: {},
          enabledSources: [],
          enabledSlugs: ['a'],
        },
      }),
    )

    await agent.postInit()

    expect(syncCalls).toBe(0)
    expect(agent.getActiveMcpServersForTest()).toEqual({
      a: { type: 'http', url: 'http://example.test/a' },
    })
  })

  it('falls back to setSourceServers (and mcpPool.sync) when no poolServerUrl is provided', async () => {
    let syncCalls = 0
    const fakePool = {
      sync: async () => {
        syncCalls += 1
      },
      hasServer: () => false,
    } as unknown as BackendConfig['mcpPool']

    const agent = new TestableHermesAgent(
      createHermesConfig({
        mcpPool: fakePool,
        initialSources: {
          mcpServers: { a: { type: 'http', url: 'http://example.test/a' } },
          apiServers: {},
          enabledSources: [],
          enabledSlugs: ['a'],
        },
      }),
    )

    await agent.postInit()

    expect(syncCalls).toBe(1)
  })
})

describe('HermesAgent ACP permission bridge', () => {
  it('routes ACP permission requests through the Craft permission UI callback', async () => {
    let capturedHandler: (request: RequestPermissionRequest) => Promise<unknown> = async () => {
      throw new Error('permission handler was not installed')
    }
    const fakeProvider = {
      model: {
        client: {
          setPermissionRequestHandler: (handler: (request: RequestPermissionRequest) => Promise<unknown>) => {
            capturedHandler = handler
          },
        },
      },
    } as unknown as ACPProvider
    const agent = new TestableHermesAgent(createHermesConfig())
    let pendingRequestId = ''
    let pendingCommand = ''

    agent.onPermissionRequest = (request) => {
      pendingRequestId = request.requestId
      pendingCommand = request.command ?? ''
    }
    agent.installAcpPermissionHandlerForTest(fakeProvider)

    const responsePromise = capturedHandler({
      sessionId: 'hermes-session-1',
      toolCall: {
        toolCallId: 'perm-check',
        kind: 'execute',
        title: 'npm install',
        rawInput: 'npm install',
      },
      options: [
        { optionId: 'allow_once', kind: 'allow_once', name: 'Allow once' },
        { optionId: 'allow_always', kind: 'allow_always', name: 'Allow always' },
        { optionId: 'deny', kind: 'reject_once', name: 'Deny' },
      ],
    })

    expect(pendingRequestId).toStartWith('hermes-acp-')
    expect(pendingCommand).toBe('npm install')

    agent.respondToPermission(pendingRequestId, true, false)

    await expect(responsePromise).resolves.toEqual({
      outcome: { outcome: 'selected', optionId: 'allow_once' },
    })
  })
})
