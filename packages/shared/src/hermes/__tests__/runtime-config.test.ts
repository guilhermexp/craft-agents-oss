import { describe, expect, it } from 'bun:test'
import { parseDocument } from 'yaml'

import {
  parseHermesConfigSnapshot,
  resolveDefaultHermesPaths,
  updateHermesConfigMainModel,
} from '../runtime-config.ts'

describe('resolveDefaultHermesPaths', () => {
  it('derives the default Hermes home and config paths from the provided home dir', () => {
    expect(resolveDefaultHermesPaths('/Users/tester')).toEqual({
      hermesHome: '/Users/tester/.hermes',
      configPath: '/Users/tester/.hermes/config.yaml',
      envPath: '/Users/tester/.hermes/.env',
    })
  })
})

describe('parseHermesConfigSnapshot', () => {
  it('extracts configured providers, default model, fallback model, and custom providers', () => {
    const snapshot = parseHermesConfigSnapshot(`
model:
  default: openai/gpt-5
fallback_model: anthropic/claude-sonnet-4-6
providers:
  - openai
  - anthropic
custom_providers:
  - name: nous
    base_url: https://api.nous.example
  - name: internal-labs
    model: labs/dev-model
`)

    expect(snapshot.defaultModel).toBe('openai/gpt-5')
    expect(snapshot.fallbackModel).toBe('anthropic/claude-sonnet-4-6')
    expect(snapshot.providers).toEqual(['openai', 'anthropic', 'nous', 'internal-labs'])
    expect(snapshot.customProviders).toEqual([
      {
        name: 'nous',
        baseUrl: 'https://api.nous.example',
        model: undefined,
        models: [],
        keyEnv: undefined,
      },
      {
        name: 'internal-labs',
        baseUrl: undefined,
        model: 'labs/dev-model',
        models: [],
        keyEnv: undefined,
      },
    ])
  })

  it('extracts new-style provider maps with model lists and key env names', () => {
    const snapshot = parseHermesConfigSnapshot(`
providers:
  cliproxy:
    base_url: http://127.0.0.1:8317/v1
    key_env: CLIPROXY_API_KEY
    default_model: claude-sonnet-4-6
    models:
      claude-sonnet-4-6: {}
      gemini-2.5-pro: {}
`)

    expect(snapshot.providers).toEqual(['cliproxy'])
    expect(snapshot.customProviders).toEqual([{
      name: 'cliproxy',
      baseUrl: 'http://127.0.0.1:8317/v1',
      model: 'claude-sonnet-4-6',
      models: ['claude-sonnet-4-6', 'gemini-2.5-pro'],
      keyEnv: 'CLIPROXY_API_KEY',
    }])
  })

  it('normalizes string-form model config and de-duplicates providers', () => {
    const snapshot = parseHermesConfigSnapshot(`
model: google/gemini-2.5-pro
providers:
  default: google
custom_providers:
  - name: google
`)

    expect(snapshot.defaultModel).toBe('google/gemini-2.5-pro')
    expect(snapshot.fallbackModel).toBeUndefined()
    expect(snapshot.providers).toEqual(['google'])
  })

  it('returns an empty snapshot for invalid yaml', () => {
    expect(parseHermesConfigSnapshot('model: [broken')).toEqual({
      defaultModel: undefined,
      defaultProvider: undefined,
      fallbackModel: undefined,
      fallbackProviders: [],
      providers: [],
      customProviders: [],
    })
  })

  it('parses fallback_providers and model.provider', () => {
    const snapshot = parseHermesConfigSnapshot([
      'model:',
      '  provider: anthropic',
      '  default: claude-opus-4-7',
      'providers:',
      '  - anthropic',
      'fallback_providers:',
      '  - openai-codex',
      '  - google',
    ].join('\n'))

    expect(snapshot.defaultProvider).toBe('anthropic')
    expect(snapshot.defaultModel).toBe('claude-opus-4-7')
    expect(snapshot.fallbackProviders).toEqual(['openai-codex', 'google'])
  })
})

describe('updateHermesConfigMainModel', () => {
  it('preserves existing model subkeys while setting provider, model, and base URL', () => {
    const updated = updateHermesConfigMainModel(`
model:
  provider: custom
  default: old-model
  api_mode: chat_completions
fallback_providers:
  - openai-codex
`, {
      provider: 'cliproxy',
      model: 'claude-sonnet-4-6',
      baseUrl: ' http://127.0.0.1:8317/v1 ',
    })

    const parsed = parseDocument(updated).toJSON() as Record<string, unknown>
    expect(parsed).toEqual({
      model: {
        provider: 'cliproxy',
        default: 'claude-sonnet-4-6',
        api_mode: 'chat_completions',
        base_url: 'http://127.0.0.1:8317/v1',
      },
      fallback_providers: ['openai-codex'],
    })
  })
})
