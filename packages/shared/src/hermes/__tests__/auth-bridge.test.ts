import { afterEach, beforeEach, describe, expect, it } from 'bun:test'
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import {
  craftConnectionToHermesProvider,
  readHermesCodexTokens,
  seedHermesAuthFromCraft,
  syncHermesMainModel,
  type AuthBridgeCredentialReader,
} from '../auth-bridge.ts'

function makeReader(opts: {
  claudeAccess?: string
  codex?: { accessToken: string; refreshToken?: string; idToken?: string }
  apiKeys?: Record<string, string>
}): AuthBridgeCredentialReader {
  return {
    getClaudeOAuthCredentials: async () =>
      opts.claudeAccess ? { accessToken: opts.claudeAccess } : null,
    getLlmOAuth: async (slug: string) => {
      if (slug !== 'chatgpt-plus') return null
      return opts.codex ?? null
    },
    getLlmApiKey: async (slug: string) => opts.apiKeys?.[slug] ?? null,
  }
}

describe('Hermes auth bridge', () => {
  let hermesHome: string

  beforeEach(() => {
    hermesHome = mkdtempSync(join(tmpdir(), 'hermes-auth-bridge-'))
  })

  afterEach(() => {
    rmSync(hermesHome, { recursive: true, force: true })
  })

  describe('craftConnectionToHermesProvider', () => {
    it('maps claude-max to anthropic', () => {
      expect(craftConnectionToHermesProvider('claude-max')).toBe('anthropic')
    })
    it('maps chatgpt-plus to openai-codex', () => {
      expect(craftConnectionToHermesProvider('chatgpt-plus')).toBe('openai-codex')
    })
    it('maps API-key LLM connections by Craft provider metadata', () => {
      expect(craftConnectionToHermesProvider('or', [{
        slug: 'or',
        name: 'OpenRouter',
        providerType: 'pi',
        authType: 'api_key',
        piAuthProvider: 'openrouter',
        createdAt: Date.now(),
      }])).toBe('openrouter')
      expect(craftConnectionToHermesProvider('anthropic-api', [{
        slug: 'anthropic-api',
        name: 'Anthropic API',
        providerType: 'anthropic',
        authType: 'api_key',
        createdAt: Date.now(),
      }])).toBe('anthropic')
    })
    it('returns null for the multi-provider hermes connection (model decides)', () => {
      expect(craftConnectionToHermesProvider('hermes')).toBeNull()
    })
    it('returns null for unknown slugs', () => {
      expect(craftConnectionToHermesProvider('hermes-local')).toBeNull()
      expect(craftConnectionToHermesProvider(undefined)).toBeNull()
    })
  })

  describe('seedHermesAuthFromCraft', () => {
    it('injects CLAUDE_CODE_OAUTH_TOKEN env when claude_oauth exists', async () => {
      const reader = makeReader({ claudeAccess: 'sk-claude-max-token' })
      const result = await seedHermesAuthFromCraft({
        hermesHome,
        connectionSlug: 'claude-max',
        credentialManager: reader,
      })

      expect(result.env.CLAUDE_CODE_OAUTH_TOKEN).toBe('sk-claude-max-token')
      expect(result.seededProviders).toContain('anthropic')
      expect(result.activeProvider).toBe('anthropic')
    })

    it('writes Codex tokens to <hermesHome>/auth.json with the expected shape', async () => {
      const reader = makeReader({
        codex: {
          accessToken: 'codex-access',
          refreshToken: 'codex-refresh',
          idToken: 'codex-id',
        },
      })
      const result = await seedHermesAuthFromCraft({
        hermesHome,
        connectionSlug: 'chatgpt-plus',
        credentialManager: reader,
      })

      expect(result.seededProviders).toContain('openai-codex')
      expect(result.activeProvider).toBe('openai-codex')

      const authPath = join(hermesHome, 'auth.json')
      expect(existsSync(authPath)).toBe(true)
      const store = JSON.parse(readFileSync(authPath, 'utf-8'))
      expect(store.active_provider).toBe('openai-codex')
      const slot = store.providers['openai-codex']
      expect(slot.tokens.access_token).toBe('codex-access')
      expect(slot.tokens.refresh_token).toBe('codex-refresh')
      expect(slot.tokens.id_token).toBe('codex-id')
      expect(slot.auth_mode).toBe('chatgpt')
      expect(typeof slot.last_refresh).toBe('string')
    })

    it('does not seed Codex without a refresh_token', async () => {
      const reader = makeReader({ codex: { accessToken: 'only-access' } })
      const result = await seedHermesAuthFromCraft({
        hermesHome,
        connectionSlug: 'chatgpt-plus',
        credentialManager: reader,
      })

      expect(result.seededProviders).not.toContain('openai-codex')
      expect(existsSync(join(hermesHome, 'auth.json'))).toBe(false)
    })

    it('injects Craft API-key credentials as Hermes provider env vars', async () => {
      const reader = makeReader({
        apiKeys: {
          'anthropic-api': 'anthropic-key',
          'openrouter-api': 'openrouter-key',
          'google-api': 'google-key',
        },
      })
      const result = await seedHermesAuthFromCraft({
        hermesHome,
        connectionSlug: 'openrouter-api',
        credentialManager: reader,
        connections: [
          {
            slug: 'anthropic-api',
            name: 'Anthropic API',
            providerType: 'anthropic',
            authType: 'api_key',
            createdAt: Date.now(),
          },
          {
            slug: 'openrouter-api',
            name: 'OpenRouter',
            providerType: 'pi',
            authType: 'api_key',
            piAuthProvider: 'openrouter',
            createdAt: Date.now(),
          },
          {
            slug: 'google-api',
            name: 'Google AI Studio',
            providerType: 'pi',
            authType: 'api_key',
            piAuthProvider: 'google',
            createdAt: Date.now(),
          },
        ],
      })

      expect(result.env.ANTHROPIC_API_KEY).toBe('anthropic-key')
      expect(result.env.OPENROUTER_API_KEY).toBe('openrouter-key')
      expect(result.env.GOOGLE_API_KEY).toBe('google-key')
      expect(result.env.GEMINI_API_KEY).toBe('google-key')
      expect(result.seededProviders).toEqual(expect.arrayContaining(['anthropic', 'openrouter', 'google']))
      expect(result.activeProvider).toBe('openrouter')
      const store = JSON.parse(readFileSync(join(hermesHome, 'auth.json'), 'utf-8'))
      expect(store.active_provider).toBe('openrouter')
    })

    it('preserves existing providers when seeding only one', async () => {
      const authPath = join(hermesHome, 'auth.json')
      writeFileSync(
        authPath,
        JSON.stringify({
          version: 1,
          active_provider: 'nous',
          providers: { nous: { tokens: { access_token: 'nous-keep' } } },
        }),
      )

      const reader = makeReader({ claudeAccess: 'claude-tok' })
      await seedHermesAuthFromCraft({
        hermesHome,
        connectionSlug: 'claude-max',
        credentialManager: reader,
      })

      const store = JSON.parse(readFileSync(authPath, 'utf-8'))
      expect(store.providers.nous.tokens.access_token).toBe('nous-keep')
      expect(store.active_provider).toBe('anthropic')
    })

    it('returns empty result when no Craft credentials are configured', async () => {
      const reader = makeReader({})
      const result = await seedHermesAuthFromCraft({
        hermesHome,
        connectionSlug: 'hermes',
        credentialManager: reader,
      })

      expect(result.env).toEqual({})
      expect(result.seededProviders).toEqual([])
      expect(result.activeProvider).toBeNull()
      expect(existsSync(join(hermesHome, 'auth.json'))).toBe(false)
    })

    it('infers active_provider from model id when slug is the multi-provider hermes connection', async () => {
      const reader = makeReader({
        codex: { accessToken: 'codex-access', refreshToken: 'codex-refresh' },
        claudeAccess: 'claude-tok',
      })
      const result = await seedHermesAuthFromCraft({
        hermesHome,
        connectionSlug: 'hermes',
        model: 'gpt-5.5',
        credentialManager: reader,
      })

      expect(result.activeProvider).toBe('openai-codex')
      expect(result.seededProviders).toEqual(expect.arrayContaining(['openai-codex', 'anthropic']))

      const store = JSON.parse(readFileSync(join(hermesHome, 'auth.json'), 'utf-8'))
      expect(store.active_provider).toBe('openai-codex')
    })
  })

  describe('syncHermesMainModel', () => {
    it('creates config.yaml with model block when missing', () => {
      syncHermesMainModel(hermesHome, 'gpt-5.5', 'openai-codex')
      const text = readFileSync(join(hermesHome, 'config.yaml'), 'utf-8')
      expect(text).toContain('model:')
      expect(text).toContain('  provider: openai-codex')
      expect(text).toContain('  default: gpt-5.5')
    })

    it('strips pi/ prefix from model id', () => {
      syncHermesMainModel(hermesHome, 'pi/gpt-5.4-mini', 'openai-codex')
      const text = readFileSync(join(hermesHome, 'config.yaml'), 'utf-8')
      expect(text).toContain('  default: gpt-5.4-mini')
      expect(text).not.toContain('default: pi/')
    })

    it('rewrites only the model block, preserving the rest of config.yaml', () => {
      const original = [
        'model:',
        '  provider: anthropic',
        '  default: claude-opus-4-6',
        'providers: {}',
        'toolsets:',
        '- hermes-cli',
        'agent:',
        '  max_turns: 90',
        '',
      ].join('\n')
      writeFileSync(join(hermesHome, 'config.yaml'), original)

      syncHermesMainModel(hermesHome, 'gpt-5.5', 'openai-codex')

      const text = readFileSync(join(hermesHome, 'config.yaml'), 'utf-8')
      expect(text).toContain('  provider: openai-codex')
      expect(text).toContain('  default: gpt-5.5')
      expect(text).toContain('toolsets:')
      expect(text).toContain('  max_turns: 90')
      expect(text).not.toContain('claude-opus-4-6')
    })

    it('is a no-op when model or provider is missing', () => {
      syncHermesMainModel(hermesHome, undefined, 'openai-codex')
      syncHermesMainModel(hermesHome, 'gpt-5.5', null)
      expect(existsSync(join(hermesHome, 'config.yaml'))).toBe(false)
    })
  })

  describe('readHermesCodexTokens', () => {
    it('returns null when auth.json does not exist', () => {
      expect(readHermesCodexTokens(hermesHome)).toBeNull()
    })

    it('returns parsed tokens when present', () => {
      writeFileSync(
        join(hermesHome, 'auth.json'),
        JSON.stringify({
          providers: {
            'openai-codex': {
              tokens: {
                access_token: 'a',
                refresh_token: 'r',
                id_token: 'i',
              },
              last_refresh: '2026-04-30T16:00:00Z',
            },
          },
        }),
      )

      const tokens = readHermesCodexTokens(hermesHome)
      expect(tokens).toEqual({
        accessToken: 'a',
        refreshToken: 'r',
        idToken: 'i',
        lastRefresh: '2026-04-30T16:00:00Z',
      })
    })

    it('returns null when refresh_token is missing', () => {
      writeFileSync(
        join(hermesHome, 'auth.json'),
        JSON.stringify({
          providers: {
            'openai-codex': { tokens: { access_token: 'a' } },
          },
        }),
      )
      expect(readHermesCodexTokens(hermesHome)).toBeNull()
    })
  })
})
