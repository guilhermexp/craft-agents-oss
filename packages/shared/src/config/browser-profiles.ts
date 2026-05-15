import {
  DEFAULT_BROWSER_PROFILE_ID,
  type BrowserProfile,
  type BrowserProfileKind,
  type BrowserProfileSettings,
} from './types.ts'

export { DEFAULT_BROWSER_PROFILE_ID } from './types.ts'

const DEFAULT_PROFILE_COLOR = '#22c55e'
const HEX_COLOR_PATTERN = /^#[0-9a-fA-F]{6}$/
const VALID_KINDS: BrowserProfileKind[] = ['personal', 'client', 'bot', 'test']

export const DEFAULT_BROWSER_PROFILE: BrowserProfile = {
  id: DEFAULT_BROWSER_PROFILE_ID,
  name: 'Default',
  color: DEFAULT_PROFILE_COLOR,
  kind: 'personal',
  createdAt: 0,
}

type NowProvider = () => number

export type BrowserProfileInput = {
  name: string
  color?: string
  avatar?: string
  kind?: BrowserProfileKind | string
  clientName?: string
  description?: string
  domainHints?: string[]
}

function cleanOptionalText(value: unknown): string | undefined {
  if (typeof value !== 'string') return undefined
  const trimmed = value.trim()
  return trimmed.length > 0 ? trimmed : undefined
}

function normalizeColor(value: unknown): string {
  return typeof value === 'string' && HEX_COLOR_PATTERN.test(value.trim())
    ? value.trim()
    : DEFAULT_PROFILE_COLOR
}

function normalizeKind(value: unknown): BrowserProfileKind {
  return VALID_KINDS.includes(value as BrowserProfileKind) ? (value as BrowserProfileKind) : 'personal'
}

export function normalizeDomainHint(value: unknown): string | null {
  if (typeof value !== 'string') return null
  const raw = value.trim().toLowerCase()
  if (!raw) return null

  let hostname = raw
  try {
    const withScheme = /^[a-z][a-z0-9+.-]*:\/\//i.test(raw) ? raw : `https://${raw}`
    hostname = new URL(withScheme).hostname
  } catch {
    return null
  }

  hostname = hostname.replace(/^www\./, '')
  if (!hostname || hostname.includes(' ') || !hostname.includes('.')) return null
  if (!/^[a-z0-9.-]+$/.test(hostname)) return null
  return hostname
}

export function normalizeDomainHints(values: unknown): string[] {
  if (!Array.isArray(values)) return []
  const hints: string[] = []
  for (const value of values) {
    const hint = normalizeDomainHint(value)
    if (hint && !hints.includes(hint)) hints.push(hint)
  }
  return hints
}

export function sanitizeBrowserProfileInput(input: BrowserProfileInput): Required<Pick<BrowserProfile, 'name' | 'color' | 'kind'>> & Pick<BrowserProfile, 'avatar' | 'clientName' | 'description' | 'domainHints'> {
  const name = cleanOptionalText(input.name)
  if (!name) throw new Error('Profile name is required')

  const sanitized: Required<Pick<BrowserProfile, 'name' | 'color' | 'kind'>> & Pick<BrowserProfile, 'avatar' | 'clientName' | 'description' | 'domainHints'> = {
    name,
    color: normalizeColor(input.color),
    kind: normalizeKind(input.kind),
  }

  const avatar = cleanOptionalText(input.avatar)
  if (avatar) sanitized.avatar = avatar
  const clientName = cleanOptionalText(input.clientName)
  if (clientName) sanitized.clientName = clientName
  const description = cleanOptionalText(input.description)
  if (description) sanitized.description = description
  const domainHints = normalizeDomainHints(input.domainHints)
  if (domainHints.length > 0) sanitized.domainHints = domainHints

  return sanitized
}

export function normalizeBrowserProfile(profile: Partial<BrowserProfile> | null | undefined, now: NowProvider = Date.now): BrowserProfile {
  if (!profile || typeof profile !== 'object') {
    return { ...DEFAULT_BROWSER_PROFILE, createdAt: now() }
  }

  const id = cleanOptionalText(profile.id) ?? DEFAULT_BROWSER_PROFILE_ID
  const defaultForId = id === DEFAULT_BROWSER_PROFILE_ID
  const name = cleanOptionalText(profile.name) ?? (defaultForId ? DEFAULT_BROWSER_PROFILE.name : 'Browser profile')
  const normalized: BrowserProfile = {
    id,
    name,
    color: normalizeColor(profile.color),
    kind: normalizeKind(profile.kind),
    createdAt: typeof profile.createdAt === 'number' && Number.isFinite(profile.createdAt) ? profile.createdAt : now(),
  }

  const avatar = cleanOptionalText(profile.avatar)
  if (avatar) normalized.avatar = avatar
  const clientName = cleanOptionalText(profile.clientName)
  if (clientName) normalized.clientName = clientName
  const description = cleanOptionalText(profile.description)
  if (description) normalized.description = description
  const domainHints = normalizeDomainHints(profile.domainHints)
  if (domainHints.length > 0) normalized.domainHints = domainHints
  if (typeof profile.lastUsedAt === 'number' && Number.isFinite(profile.lastUsedAt)) {
    normalized.lastUsedAt = profile.lastUsedAt
  }

  return normalized
}

export function normalizeBrowserProfileSettings(settings: Partial<BrowserProfileSettings> | null | undefined, now: NowProvider = Date.now): BrowserProfileSettings {
  const rawProfiles = Array.isArray(settings?.profiles) ? settings.profiles : []
  const profiles: BrowserProfile[] = []
  const seen = new Set<string>()

  for (const rawProfile of rawProfiles) {
    const profile = normalizeBrowserProfile(rawProfile, now)
    if (seen.has(profile.id)) continue
    seen.add(profile.id)
    profiles.push(profile)
  }

  if (!seen.has(DEFAULT_BROWSER_PROFILE_ID)) {
    profiles.unshift({ ...DEFAULT_BROWSER_PROFILE, createdAt: now() })
    seen.add(DEFAULT_BROWSER_PROFILE_ID)
  }

  const requestedLastUsed = cleanOptionalText(settings?.lastUsedProfileId)
  const lastUsedProfileId = requestedLastUsed && seen.has(requestedLastUsed)
    ? requestedLastUsed
    : DEFAULT_BROWSER_PROFILE_ID

  return {
    profiles,
    lastUsedProfileId,
    alwaysAsk: settings?.alwaysAsk === true,
  }
}

function hostnameMatchesHint(hostname: string, hint: string): boolean {
  return hostname === hint || hostname.endsWith(`.${hint}`)
}

export function suggestBrowserProfileIdForUrl(url: string, settings: BrowserProfileSettings): string | null {
  let hostname: string
  try {
    hostname = new URL(url).hostname.toLowerCase().replace(/^www\./, '')
  } catch {
    return null
  }

  let best: { id: string; hintLength: number } | null = null
  for (const profile of normalizeBrowserProfileSettings(settings).profiles) {
    for (const hint of profile.domainHints ?? []) {
      if (!hostnameMatchesHint(hostname, hint)) continue
      if (!best || hint.length > best.hintLength) {
        best = { id: profile.id, hintLength: hint.length }
      }
    }
  }

  return best?.id ?? null
}
