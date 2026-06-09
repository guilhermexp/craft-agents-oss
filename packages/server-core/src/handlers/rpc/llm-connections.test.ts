import { afterEach, describe, expect, it } from 'bun:test'
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import type { LlmConnection } from '@craft-agent/shared/config'
import {
  applyHermesLiveModelMetadata,
  readHermesLiveModelMetadata,
} from './llm-connections'

let previousHermesConfigPath: string | undefined

function restoreEnv(name: string, value: string | undefined): void {
  if (value === undefined) {
    delete process.env[name]
  } else {
    process.env[name] = value
  }
}

afterEach(() => {
  restoreEnv('CRAFT_HERMES_CONFIG_PATH', previousHermesConfigPath)
  previousHermesConfigPath = undefined
})

describe('Hermes LLM connection model sync', () => {
  it('reads the live provider and model from the Hermes runtime config', async () => {
    previousHermesConfigPath = process.env.CRAFT_HERMES_CONFIG_PATH
    const dir = await mkdtemp(join(tmpdir(), 'craft-hermes-llm-sync-'))
    const configPath = join(dir, 'config.yaml')
    process.env.CRAFT_HERMES_CONFIG_PATH = configPath

    await writeFile(configPath, [
      'model:',
      '  provider: openai-codex',
      '  default: gpt-5',
    ].join('\n'), 'utf-8')

    try {
      await expect(readHermesLiveModelMetadata()).resolves.toEqual({
        provider: 'openai-codex',
        model: 'gpt-5',
      })
    } finally {
      await rm(dir, { recursive: true, force: true })
    }
  })

  it('overlays stale Craft Hermes model metadata without mutating other connection fields', () => {
    const connection: LlmConnection = {
      slug: 'hermes',
      name: 'Hermes',
      providerType: 'hermes',
      authType: 'none',
      defaultModel: 'claude-opus-4-7',
      models: [{
        id: 'claude-opus-4-7',
        name: 'Claude Opus 4.7 via Hermes/CLIProxy',
        shortName: 'Opus 4.7',
        description: 'old stale model',
        provider: 'hermes',
        contextWindow: 256000,
      }],
      createdAt: 123,
    }

    const synced = applyHermesLiveModelMetadata(connection, {
      provider: 'openai-codex',
      model: 'gpt-5',
    })

    expect(synced.slug).toBe('hermes')
    expect(synced.name).toBe('Hermes')
    expect(synced.defaultModel).toBe('gpt-5')
    expect(synced.models).toEqual([{
      id: 'gpt-5',
      name: 'gpt-5 via Hermes',
      shortName: 'gpt-5',
      description: 'Modelo ativo no Hermes (openai-codex)',
      provider: 'hermes',
      contextWindow: 256000,
      supportsThinking: true,
    }])
    expect(JSON.stringify(synced)).not.toContain('CLIProxy')
  })
})
