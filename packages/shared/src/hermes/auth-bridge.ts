/**
 * Auth bridge: Craft credentials → embedded Hermes runtime.
 *
 * Craft's Credential Manager / LLM connections are the source of truth for the
 * embedded Hermes runtime. The bridge mirrors credentials only into the process
 * surface Hermes already understands (environment variables and the Codex
 * OAuth slot in auth.json), so users do not have to configure providers twice.
 *
 *   Craft `claude_oauth`              → env `CLAUDE_CODE_OAUTH_TOKEN`
 *                                       (Hermes provider `anthropic`)
 *   Craft `llm_oauth::chatgpt-plus`   → `<HERMES_HOME>/auth.json` providers
 *                                       slot `openai-codex.tokens.{...}`
 *   Craft `llm_api_key::*`            → provider-specific env vars
 *                                       (`ANTHROPIC_API_KEY`, `OPENAI_API_KEY`,
 *                                       `OPENROUTER_API_KEY`, etc.)
 *
 * The reverse direction (Hermes refresh → Craft sync) lives in
 * `packages/server-core/src/handlers/rpc/hermes.ts` (auth.json watcher).
 */

import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'

import { getCredentialManager } from '../credentials/manager.ts'
import { loadStoredConfig } from '../config/storage.ts'
import type { LlmConnection } from '../config/llm-connections.ts'

/**
 * Minimal credential manager surface the bridge needs. Lets tests inject a
 * stub without dragging in the full singleton.
 */
export interface AuthBridgeCredentialReader {
  getClaudeOAuthCredentials(): Promise<{ accessToken: string } | null>
  getLlmOAuth(connectionSlug: string): Promise<
    { accessToken: string; refreshToken?: string; idToken?: string; expiresAt?: number } | null
  >
  getLlmApiKey(connectionSlug: string): Promise<string | null>
}

export type HermesActiveProvider =
  | 'anthropic'
  | 'openai'
  | 'openai-codex'
  | 'google'
  | 'openrouter'
  | 'groq'
  | 'mistral'
  | 'xai'
  | 'cerebras'
  | 'huggingface'
  | 'deepseek'
  | null

export interface SeedHermesAuthResult {
  /** Env vars to add to the Hermes subprocess environment. */
  env: Record<string, string>
  /** Providers actually seeded into Hermes. */
  seededProviders: Exclude<HermesActiveProvider, null>[]
  /** Active provider written into auth.json/config.yaml (or null if none chosen). */
  activeProvider: HermesActiveProvider
}

const PI_AUTH_PROVIDER_TO_HERMES_PROVIDER: Record<string, Exclude<HermesActiveProvider, null>> = {
  anthropic: 'anthropic',
  openai: 'openai',
  'openai-codex': 'openai-codex',
  google: 'google',
  gemini: 'google',
  openrouter: 'openrouter',
  groq: 'groq',
  mistral: 'mistral',
  xai: 'xai',
  cerebras: 'cerebras',
  huggingface: 'huggingface',
  deepseek: 'deepseek',
}

const HERMES_PROVIDER_ENV_VARS: Record<Exclude<HermesActiveProvider, null>, string[]> = {
  anthropic: ['ANTHROPIC_API_KEY'],
  openai: ['OPENAI_API_KEY'],
  'openai-codex': ['OPENAI_API_KEY'],
  google: ['GOOGLE_API_KEY', 'GEMINI_API_KEY'],
  openrouter: ['OPENROUTER_API_KEY'],
  groq: ['GROQ_API_KEY'],
  mistral: ['MISTRAL_API_KEY'],
  xai: ['XAI_API_KEY'],
  cerebras: ['CEREBRAS_API_KEY'],
  huggingface: ['HUGGINGFACE_API_KEY'],
  deepseek: ['DEEPSEEK_API_KEY'],
}

/**
 * Map a Craft connection slug to its Hermes `active_provider` key.
 *
 * The Hermes connection itself (`slug === 'hermes'`) is intentionally **not**
 * mapped to a single provider — Hermes is multi-provider and the user picks
 * the model at session time. Instead, callers should fall back to inferring
 * the active provider from the session's current model.
 */
export function craftConnectionToHermesProvider(
  connectionSlug: string | undefined,
  connections: LlmConnection[] = loadStoredConfig()?.llmConnections ?? [],
): HermesActiveProvider {
  if (!connectionSlug) return null
  if (connectionSlug === 'claude-max') return 'anthropic'
  if (connectionSlug === 'chatgpt-plus') return 'openai-codex'
  if (connectionSlug === 'hermes') return null

  const connection = connections.find(c => c.slug === connectionSlug)
  return connectionToHermesProvider(connection)
}

function connectionToHermesProvider(connection: LlmConnection | undefined): HermesActiveProvider {
  if (!connection) return null
  if (connection.providerType === 'anthropic') return 'anthropic'
  if (connection.providerType === 'pi' || connection.providerType === 'pi_compat') {
    const key = connection.piAuthProvider?.trim().toLowerCase()
    if (key && PI_AUTH_PROVIDER_TO_HERMES_PROVIDER[key]) return PI_AUTH_PROVIDER_TO_HERMES_PROVIDER[key]

    const baseUrl = connection.baseUrl?.toLowerCase() ?? ''
    if (baseUrl.includes('openrouter.ai')) return 'openrouter'
    if (baseUrl.includes('api.openai.com')) return 'openai'
    if (baseUrl.includes('generativelanguage.googleapis.com') || baseUrl.includes('googleapis.com')) return 'google'
    if (baseUrl.includes('api.x.ai')) return 'xai'
    if (baseUrl.includes('api.groq.com')) return 'groq'
    if (baseUrl.includes('api.mistral.ai')) return 'mistral'
    if (baseUrl.includes('api.cerebras.ai')) return 'cerebras'
    if (baseUrl.includes('huggingface.co')) return 'huggingface'
    if (baseUrl.includes('api.deepseek.com')) return 'deepseek'
  }
  return null
}

/**
 * Infer the active Hermes provider from the model id. Used when the session
 * runs through the multi-provider `hermes` connection so we can still seed
 * `active_provider` correctly in `auth.json`.
 */
export function modelIdToHermesProvider(modelId: string | undefined): HermesActiveProvider {
  if (!modelId) return null
  const trimmed = modelId.trim().toLowerCase()
  if (!trimmed) return null
  const providerPrefix = trimmed.includes('/') ? trimmed.split('/')[0] : undefined
  if (providerPrefix && PI_AUTH_PROVIDER_TO_HERMES_PROVIDER[providerPrefix]) {
    return PI_AUTH_PROVIDER_TO_HERMES_PROVIDER[providerPrefix]
  }
  const bare = trimmed.includes('/') ? trimmed.split('/').pop()! : trimmed
  if (bare.startsWith('claude') || bare.includes('anthropic')) return 'anthropic'
  if (bare.startsWith('gpt-') || bare.startsWith('o1') || bare.includes('codex')) return 'openai-codex'
  if (bare.startsWith('gemini')) return 'google'
  if (bare.includes('grok')) return 'xai'
  if (bare.includes('mistral') || bare.includes('codestral')) return 'mistral'
  if (bare.includes('llama') || bare.includes('qwen') || bare.includes('deepseek')) return 'openrouter'
  return null
}

interface AuthStoreShape {
  version?: number
  active_provider?: string | null
  providers?: Record<string, Record<string, unknown>>
  [key: string]: unknown
}

const AUTH_STORE_VERSION = 1

function readAuthStore(authPath: string): AuthStoreShape {
  if (!existsSync(authPath)) {
    return { version: AUTH_STORE_VERSION, providers: {} }
  }
  try {
    const raw = readFileSync(authPath, 'utf-8')
    const parsed = JSON.parse(raw) as AuthStoreShape
    if (!parsed.providers || typeof parsed.providers !== 'object') {
      parsed.providers = {}
    }
    return parsed
  } catch {
    return { version: AUTH_STORE_VERSION, providers: {} }
  }
}

function writeAuthStore(authPath: string, store: AuthStoreShape): void {
  const dir = dirname(authPath)
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true })
  writeFileSync(authPath, JSON.stringify(store, null, 2), { mode: 0o600 })
}

function addProviderEnv(env: Record<string, string>, provider: Exclude<HermesActiveProvider, null>, apiKey: string): void {
  for (const envName of HERMES_PROVIDER_ENV_VARS[provider] ?? []) {
    env[envName] = apiKey
  }
}

function isApiKeyAuth(authType: LlmConnection['authType']): boolean {
  return authType === 'api_key' || authType === 'api_key_with_endpoint' || authType === 'bearer_token'
}

/**
 * Seed the Hermes auth surface from Craft credentials.
 *
 * - Reads available Craft OAuth tokens (Claude Max, ChatGPT Plus).
 * - Returns env vars Hermes reads at startup (`CLAUDE_CODE_OAUTH_TOKEN`,
 *   provider-specific `*_API_KEY`s).
 * - Writes Codex tokens directly into `<HERMES_HOME>/auth.json` in the
 *   shape Hermes expects (`providers["openai-codex"].tokens`).
 * - Sets `active_provider` based on the current session's connection slug or
 *   model id, but only when credentials for that provider are available.
 *
 * Safe to call repeatedly — overwrites only the relevant Hermes auth surface
 * without touching unrelated providers in auth.json.
 */
export async function seedHermesAuthFromCraft(args: {
  hermesHome: string
  connectionSlug: string | undefined
  /** Optional model id used to infer active_provider when connectionSlug === 'hermes'. */
  model?: string
  credentialManager?: AuthBridgeCredentialReader
  connections?: LlmConnection[]
}): Promise<SeedHermesAuthResult> {
  const env: Record<string, string> = {}
  const seededProviderSet = new Set<Exclude<HermesActiveProvider, null>>()
  const connections = args.connections ?? loadStoredConfig()?.llmConnections ?? []
  const activeProvider =
    craftConnectionToHermesProvider(args.connectionSlug, connections) ?? modelIdToHermesProvider(args.model)

  let credentialManager: AuthBridgeCredentialReader
  try {
    credentialManager = args.credentialManager ?? getCredentialManager()
  } catch {
    return { env, seededProviders: [], activeProvider }
  }

  // 1. Claude Max: env-only path. Hermes anthropic provider reads
  //    CLAUDE_CODE_OAUTH_TOKEN as one of its api_key_env_vars.
  try {
    const claude = await credentialManager.getClaudeOAuthCredentials()
    if (claude?.accessToken) {
      env.CLAUDE_CODE_OAUTH_TOKEN = claude.accessToken
      seededProviderSet.add('anthropic')
    }
  } catch {
    // Credential read failure is non-fatal — Hermes can still start without it.
  }

  // 2. API-key connections: inject into the Hermes subprocess/dashboard env.
  //    This keeps Craft Credential Manager as source of truth and avoids a
  //    duplicate Hermes .env secret store.
  for (const connection of connections) {
    if (!isApiKeyAuth(connection.authType)) continue
    const provider = connectionToHermesProvider(connection)
    if (!provider) continue

    try {
      const apiKey = await credentialManager.getLlmApiKey(connection.slug)
      if (!apiKey) continue
      addProviderEnv(env, provider, apiKey)
      seededProviderSet.add(provider)
    } catch {
      // Keep seeding other providers even if one credential read fails.
    }
  }

  // 3. ChatGPT Plus / Codex: must live in <HERMES_HOME>/auth.json.
  let codexTokens: {
    accessToken: string
    refreshToken?: string
    idToken?: string
    expiresAt?: number
  } | null = null
  try {
    codexTokens = await credentialManager.getLlmOAuth('chatgpt-plus')
  } catch {
    codexTokens = null
  }

  const authPath = join(args.hermesHome, 'auth.json')
  const store = readAuthStore(authPath)
  store.version = store.version ?? AUTH_STORE_VERSION
  store.providers = store.providers ?? {}

  if (codexTokens?.accessToken && codexTokens.refreshToken) {
    const tokens: Record<string, string> = {
      access_token: codexTokens.accessToken,
      refresh_token: codexTokens.refreshToken,
    }
    if (codexTokens.idToken) tokens.id_token = codexTokens.idToken

    const existing = (store.providers['openai-codex'] ?? {}) as Record<string, unknown>
    store.providers['openai-codex'] = {
      ...existing,
      tokens,
      last_refresh: new Date().toISOString().replace(/\.\d+Z$/, 'Z'),
      auth_mode: 'chatgpt',
    }
    seededProviderSet.add('openai-codex')
  }

  const seededProviders = Array.from(seededProviderSet)

  // Only set active_provider if we actually have credentials for it — otherwise
  // we'd point Hermes at an empty slot and immediately fail at first request.
  const shouldSetActive = activeProvider && seededProviderSet.has(activeProvider)
  if (shouldSetActive) {
    store.active_provider = activeProvider
  }

  if (shouldSetActive || (codexTokens?.accessToken && codexTokens.refreshToken)) {
    try {
      writeAuthStore(authPath, store)
    } catch {
      // Disk write failure is non-fatal — Hermes will fall back to its own auth flow.
    }
  }

  // Sync config.yaml when the Craft-picked model belongs to a provider Hermes
  // is not currently configured for. Hermes only resolves model ids whose
  // provider is active in `model.provider` — without this, picking gpt-5.5
  // while Hermes runs anthropic raises "Model … is not available (Current:
  // anthropic:claude-…)".
  //
  // We write provider+model atomically so both stay aligned. The dashboard
  // remains free to change them; Craft just owns the active selection at
  // spawn time.
  try {
    syncHermesMainModel(args.hermesHome, args.model, shouldSetActive ? activeProvider : null)
  } catch {
    // ignore — Hermes will fall back to existing config.yaml state
  }

  return { env, seededProviders, activeProvider }
}

/**
 * Update `<HERMES_HOME>/config.yaml` so the Hermes dashboard's "Main model"
 * line and the runtime fallback default match the model Craft is actually
 * running with for this session.
 *
 * Lightweight YAML rewrite — only the `model.provider` / `model.default`
 * keys are touched. Other config sections are preserved verbatim. If the
 * file does not exist it is created with a minimal `model:` block.
 */
export function syncHermesMainModel(
  hermesHome: string,
  model: string | undefined,
  provider: HermesActiveProvider,
): void {
  if (!model || !provider) return
  const bare = model.startsWith('pi/') ? model.slice(3) : model
  const configPath = join(hermesHome, 'config.yaml')

  let lines: string[]
  try {
    if (existsSync(configPath)) {
      lines = readFileSync(configPath, 'utf-8').split('\n')
    } else {
      lines = ['model:', `  provider: ${provider}`, `  default: ${bare}`, '']
      const dir = dirname(configPath)
      if (!existsSync(dir)) mkdirSync(dir, { recursive: true })
      writeFileSync(configPath, lines.join('\n'), { mode: 0o600 })
      return
    }
  } catch {
    return
  }

  const modelStartIdx = lines.findIndex(l => /^model:\s*$/.test(l))
  if (modelStartIdx < 0) {
    // File exists but no `model:` block — append one.
    if (lines[lines.length - 1] !== '') lines.push('')
    lines.push('model:', `  provider: ${provider}`, `  default: ${bare}`, '')
    try { writeFileSync(configPath, lines.join('\n'), { mode: 0o600 }) } catch { /* swallow */ }
    return
  }

  let providerIdx = -1
  let defaultIdx = -1
  for (let i = modelStartIdx + 1; i < lines.length; i++) {
    const line = lines[i]
    if (/^\S/.test(line ?? '') && line !== '') break // exited the block
    if (/^\s+provider:\s*/.test(line ?? '')) providerIdx = i
    if (/^\s+default:\s*/.test(line ?? '')) defaultIdx = i
  }

  let mutated = false
  if (providerIdx >= 0) {
    const next = `  provider: ${provider}`
    if (lines[providerIdx] !== next) { lines[providerIdx] = next; mutated = true }
  } else {
    lines.splice(modelStartIdx + 1, 0, `  provider: ${provider}`)
    mutated = true
  }
  if (defaultIdx >= 0) {
    const next = `  default: ${bare}`
    const adj = providerIdx < 0 ? defaultIdx + 1 : defaultIdx
    if (lines[adj] !== next) { lines[adj] = next; mutated = true }
  } else {
    lines.splice(modelStartIdx + 2, 0, `  default: ${bare}`)
    mutated = true
  }

  if (mutated) {
    try { writeFileSync(configPath, lines.join('\n'), { mode: 0o600 }) } catch { /* swallow */ }
  }
}

/**
 * Read Codex tokens from `<HERMES_HOME>/auth.json` if present.
 * Returns null when the slot is missing or shape-invalid.
 *
 * Used by the auth.json watcher (server-core) to sync Hermes-refreshed
 * tokens back into Craft's credential store.
 */
export function readHermesCodexTokens(hermesHome: string): {
  accessToken: string
  refreshToken: string
  idToken?: string
  lastRefresh?: string
} | null {
  const authPath = join(hermesHome, 'auth.json')
  if (!existsSync(authPath)) return null
  let store: AuthStoreShape
  try {
    store = JSON.parse(readFileSync(authPath, 'utf-8')) as AuthStoreShape
  } catch {
    return null
  }
  const slot = store.providers?.['openai-codex'] as Record<string, unknown> | undefined
  if (!slot) return null
  const tokens = slot.tokens as Record<string, unknown> | undefined
  if (!tokens) return null
  const accessToken = typeof tokens.access_token === 'string' ? tokens.access_token : null
  const refreshToken = typeof tokens.refresh_token === 'string' ? tokens.refresh_token : null
  if (!accessToken || !refreshToken) return null
  return {
    accessToken,
    refreshToken,
    idToken: typeof tokens.id_token === 'string' ? tokens.id_token : undefined,
    lastRefresh: typeof slot.last_refresh === 'string' ? slot.last_refresh : undefined,
  }
}
