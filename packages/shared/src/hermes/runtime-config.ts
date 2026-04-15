import { join } from 'node:path'
import { parseDocument } from 'yaml'

export interface HermesCustomProviderSnapshot {
  name: string
  baseUrl?: string
  model?: string
}

export interface HermesConfigSnapshot {
  defaultModel?: string
  fallbackModel?: string
  providers: string[]
  customProviders: HermesCustomProviderSnapshot[]
}

export function resolveDefaultHermesPaths(homeDir: string): {
  hermesHome: string
  configPath: string
  envPath: string
} {
  const hermesHome = join(homeDir, '.hermes')
  return {
    hermesHome,
    configPath: join(hermesHome, 'config.yaml'),
    envPath: join(hermesHome, '.env'),
  }
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

export function parseHermesConfigSnapshot(rawConfig: string): HermesConfigSnapshot {
  try {
    const parsed = parseDocument(rawConfig).toJSON() as Record<string, unknown> | null
    if (!parsed || typeof parsed !== 'object') {
      return {
        defaultModel: undefined,
        fallbackModel: undefined,
        providers: [],
        customProviders: [],
      }
    }

    const customProviders: HermesCustomProviderSnapshot[] = []

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
        })
      }
    }

    const providers = Array.from(
      new Set([
        ...normalizeProviderValue(parsed.providers),
        ...customProviders.map(provider => provider.name),
      ]),
    )

    return {
      defaultModel: readModelValue(parsed.model),
      fallbackModel: readModelValue(parsed.fallback_model),
      providers,
      customProviders,
    }
  } catch {
    return {
      defaultModel: undefined,
      fallbackModel: undefined,
      providers: [],
      customProviders: [],
    }
  }
}
