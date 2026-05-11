import { describe, expect, it } from 'bun:test'

import { ClaudeAgent } from '../claude-agent.ts'
import { PiAgent } from '../pi-agent.ts'
import { spawnNativeAgent, isNativeAgentProvider, getAvailableNativeAgentProviders } from './index.ts'
import type { NativeAgentSpawnConfig } from './index.ts'
import type { Workspace } from '../../config/storage.ts'
import type { SessionConfig as Session } from '../../sessions/storage.ts'

function workspace(): Workspace {
  return {
    id: 'native-workspace',
    name: 'Native Workspace',
    slug: 'native-workspace',
    rootPath: '/tmp/native-workspace',
    createdAt: 0,
  }
}

function session(): Session {
  return {
    id: 'native-session',
    workspaceRootPath: '/tmp/native-workspace',
    createdAt: 0,
    lastUsedAt: 0,
  }
}

function spawnConfig(
  provider: 'anthropic' | 'pi',
  overrides: Partial<NativeAgentSpawnConfig['context']> = {},
): NativeAgentSpawnConfig {
  return {
    context: {
      connection: null,
      provider,
      resolvedModel: provider === 'anthropic' ? 'claude-sonnet-4-6' : '',
      capabilities: { needsHttpPoolServer: false },
      ...overrides,
    },
    coreConfig: {
      workspace: workspace(),
      session: session(),
      isHeadless: true,
    },
    hostRuntime: {
      appRootPath: process.cwd(),
      isPackaged: false,
    },
  }
}

describe('native agent runtime contract', () => {
  it('owns only Anthropic and Pi providers', () => {
    expect(getAvailableNativeAgentProviders()).toEqual(['anthropic', 'pi'])
    expect(isNativeAgentProvider('anthropic')).toBe(true)
    expect(isNativeAgentProvider('pi')).toBe(true)
    expect(isNativeAgentProvider('hermes')).toBe(false)
  })

  it('spawns Claude SDK backend for Anthropic', () => {
    const agent = spawnNativeAgent(spawnConfig('anthropic'))

    expect(agent).toBeInstanceOf(ClaudeAgent)
    agent.destroy()
  })

  it('spawns Pi subprocess backend for Pi', () => {
    const agent = spawnNativeAgent(spawnConfig('pi'))

    expect(agent).toBeInstanceOf(PiAgent)
    agent.destroy()
  })

  it('rejects Hermes before any native backend is created', () => {
    const config = {
      ...spawnConfig('anthropic'),
      context: {
        ...spawnConfig('anthropic').context,
        provider: 'hermes',
      },
    } as unknown as NativeAgentSpawnConfig

    expect(() => spawnNativeAgent(config)).toThrow('No native backend driver registered for provider: hermes')
  })
})
