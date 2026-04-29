/**
 * Tests for HermesAgent overrides — focus on the source-update lifecycle.
 *
 * The ACP provider is a heavy subprocess we never want to spawn from a unit
 * test, so we exercise the public surface (postInit, setSourceServers, the
 * chat finally block) and assert on observable side-effects: provider
 * teardown, pendingProviderRestart flag, and mcpPool.sync calls.
 */
import { describe, it, expect, beforeEach } from 'bun:test'

import { HermesAgent, resolveHermesModelId } from '../hermes-agent.ts'
import { createMockBackendConfig } from './test-utils.ts'
import type { BackendConfig, SdkMcpServerConfig } from '../backend/types.ts'

type FakeProvider = {
  cleanup: () => void
  cleanupCount: number
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
  return createMockBackendConfig({ provider: 'hermes', ...overrides })
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
}

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

  it('falls back to Hermes current model when a stale Craft model cannot be mapped', () => {
    expect(resolveHermesModelId('claude-opus-4-7', models)).toBe('openrouter:gpt-5.5')
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
