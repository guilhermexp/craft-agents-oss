import { describe, expect, it } from 'bun:test'

import {
  parseHermesConfigSnapshot,
  resolveDefaultHermesPaths,
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
      },
      {
        name: 'internal-labs',
        baseUrl: undefined,
        model: 'labs/dev-model',
      },
    ])
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
      fallbackModel: undefined,
      providers: [],
      customProviders: [],
    })
  })
})
