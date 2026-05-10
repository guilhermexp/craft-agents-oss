export function resolveHermesProfileSelection(hermesProfile?: string | null, activeProfile?: string | null): string | null {
  return hermesProfile?.trim() || activeProfile?.trim() || null
}

export function getHermesProfileSelectorLabel(
  providerType?: string | null,
  hermesProfile?: string | null,
  activeProfile?: string | null,
  isLoading = false,
): string | null {
  if (providerType !== 'hermes') return null

  const profile = resolveHermesProfileSelection(hermesProfile, activeProfile)
  if (profile) return `Hermes: ${profile}`
  return isLoading ? 'Hermes: …' : 'Hermes: default'
}

export function getHermesProfileBadgeLabel(providerType?: string | null, hermesProfile?: string | null): string | null {
  return getHermesProfileSelectorLabel(providerType, hermesProfile)
}

export interface HermesProfileModelInfo {
  name: string
  model?: string | null
}

type ModelEntry = string | { id: string }

function getModelEntryId(model: ModelEntry): string {
  return typeof model === 'string' ? model : model.id
}

export function getHermesProfileModel(
  profiles: HermesProfileModelInfo[],
  profileName?: string | null,
): string | null {
  const normalizedName = profileName?.trim()
  if (!normalizedName) return null
  const model = profiles.find(profile => profile.name === normalizedName)?.model?.trim()
  return model || null
}

export function mergeHermesProfileModels<T extends ModelEntry>(
  baseModels: T[],
  profiles: HermesProfileModelInfo[],
): Array<T | string> {
  const merged: Array<T | string> = [...baseModels]
  const seen = new Set(baseModels.map(getModelEntryId))

  for (const profile of profiles) {
    const model = profile.model?.trim()
    if (!model || seen.has(model)) continue
    seen.add(model)
    merged.push(model)
  }

  return merged
}
