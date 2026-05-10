import { parseDocument, stringify } from 'yaml'

export { resolveDefaultHermesPaths } from './acp-config.ts'

export interface HermesCustomProviderSnapshot {
  name: string
  baseUrl?: string
  model?: string
  models?: string[]
  keyEnv?: string
}

export interface HermesConfigSnapshot {
  defaultModel?: string
  /** Hermes default provider for the main model (e.g. 'anthropic', 'openai-codex'). */
  defaultProvider?: string
  fallbackModel?: string
  /**
   * Ordered list of provider names Hermes will try when the main provider
   * fails (mirrors `fallback_providers:` in config.yaml). Drives auto-fallback;
   * Craft surfaces this so users can see what runtime might switch to.
   */
  fallbackProviders: string[]
  providers: string[]
  customProviders: HermesCustomProviderSnapshot[]
}

export interface HermesMainModelUpdate {
  provider: string
  model: string
  baseUrl?: string
}

function trimString(value: unknown): string | undefined {
  return typeof value === 'string' && value.trim() ? value.trim() : undefined
}

function normalizeProviderValue(value: unknown): string[] {
  if (typeof value === 'string' && value.trim()) return [value.trim()]
  if (Array.isArray(value)) {
    return value
      .map(entry => trimString(entry))
      .filter((entry): entry is string => Boolean(entry))
  }
  if (value && typeof value === 'object') {
    return Object.values(value)
      .flatMap(entry => normalizeProviderValue(entry))
  }
  return []
}

function readModelValue(value: unknown): string | undefined {
  if (typeof value === 'string') return trimString(value)
  if (!value || typeof value !== 'object') return undefined

  const record = value as Record<string, unknown>
  return trimString(record.default) ?? trimString(record.id) ?? trimString(record.model)
}

function readModelProvider(value: unknown): string | undefined {
  if (!value || typeof value !== 'object') return undefined
  const record = value as Record<string, unknown>
  return trimString(record.provider)
}

function readProviderModels(value: unknown): string[] {
  if (!value) return []
  if (Array.isArray(value)) {
    return value.map(entry => trimString(entry)).filter((entry): entry is string => Boolean(entry))
  }
  if (typeof value === 'object') {
    return Object.keys(value as Record<string, unknown>).filter(Boolean)
  }
  return []
}

export function parseHermesConfigSnapshot(rawConfig: string): HermesConfigSnapshot {
  try {
    const parsed = parseDocument(rawConfig).toJSON() as Record<string, unknown> | null
    if (!parsed || typeof parsed !== 'object') {
      return {
        defaultModel: undefined,
        defaultProvider: undefined,
        fallbackModel: undefined,
        fallbackProviders: [],
        providers: [],
        customProviders: [],
      }
    }

    const customProviders: HermesCustomProviderSnapshot[] = []

    if (parsed.providers && typeof parsed.providers === 'object' && !Array.isArray(parsed.providers)) {
      for (const [name, value] of Object.entries(parsed.providers as Record<string, unknown>)) {
        const providerName = trimString(name)
        if (!providerName || !value || typeof value !== 'object') continue

        const record = value as Record<string, unknown>
        customProviders.push({
          name: providerName,
          baseUrl: trimString(record.base_url) ?? trimString(record.baseUrl),
          model: trimString(record.default_model) ?? trimString(record.defaultModel) ?? readModelValue(record.model),
          models: readProviderModels(record.models),
          keyEnv: trimString(record.key_env) ?? trimString(record.keyEnv),
        })
      }
    }

    if (Array.isArray(parsed.custom_providers)) {
      for (const entry of parsed.custom_providers) {
        if (!entry || typeof entry !== 'object') continue

        const record = entry as Record<string, unknown>
        const name = trimString(record.name)
        if (!name) continue

        customProviders.push({
          name,
          baseUrl: trimString(record.base_url) ?? trimString(record.baseUrl),
          model: readModelValue(record.model),
          models: readProviderModels(record.models),
          keyEnv: trimString(record.key_env) ?? trimString(record.keyEnv),
        })
      }
    }

    const builtInProviders = parsed.providers && typeof parsed.providers === 'object' && !Array.isArray(parsed.providers)
      ? []
      : normalizeProviderValue(parsed.providers)

    const providers = Array.from(
      new Set([
        ...builtInProviders,
        ...customProviders.map(provider => provider.name),
      ]),
    )

    return {
      defaultModel: readModelValue(parsed.model),
      defaultProvider: readModelProvider(parsed.model),
      fallbackModel: readModelValue(parsed.fallback_model),
      fallbackProviders: normalizeProviderValue(parsed.fallback_providers),
      providers,
      customProviders,
    }
  } catch {
    return {
      defaultModel: undefined,
      defaultProvider: undefined,
      fallbackModel: undefined,
      fallbackProviders: [],
      providers: [],
      customProviders: [],
    }
  }
}

export function updateHermesConfigMainModel(rawConfig: string, update: HermesMainModelUpdate): string {
  let parsed: Record<string, unknown> = {}
  try {
    const value = parseDocument(rawConfig).toJSON()
    if (value && typeof value === 'object' && !Array.isArray(value)) {
      parsed = { ...(value as Record<string, unknown>) }
    }
  } catch {
    parsed = {}
  }

  const existingModel = parsed.model && typeof parsed.model === 'object' && !Array.isArray(parsed.model)
    ? { ...(parsed.model as Record<string, unknown>) }
    : {}

  const baseUrl = update.baseUrl?.trim()
  parsed.model = {
    ...existingModel,
    provider: update.provider,
    default: update.model,
    ...(baseUrl ? { base_url: baseUrl } : {}),
  }

  return stringify(parsed)
}
