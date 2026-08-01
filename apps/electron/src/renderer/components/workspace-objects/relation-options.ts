import type { WorkspaceObjectAction, WorkspaceObjectServiceResult } from '@craft-agent/shared/workspace-objects/service'
import type { WorkspaceObjectPayload } from '@craft-agent/shared/workspace-objects/types'

type RelationOptionsAction = Extract<WorkspaceObjectAction, { action: 'list-relation-options' }>

export interface LoadedRelationOptions {
  options: Array<{ id: string; label: string }>
  nextCursor: string | null
  revision: number
}

export function collectReferencedRelationEntryIds(
  payload: WorkspaceObjectPayload,
  relationObjectId: string,
): string[] {
  const fieldIds = new Set(payload.fields.flatMap(field => field.relationObjectId === relationObjectId ? [field.id] : []))
  const referencedIds = new Set<string>()
  for (const entry of payload.entries) {
    for (const [fieldId, value] of Object.entries(entry.values)) {
      if (fieldIds.has(fieldId) && typeof value === 'string') referencedIds.add(value)
    }
  }
  return [...referencedIds]
}

export async function loadReferencedRelationOptions(
  relationObjectId: string,
  referencedIds: string[],
  load: (action: RelationOptionsAction) => Promise<WorkspaceObjectServiceResult>,
): Promise<LoadedRelationOptions> {
  const requests: RelationOptionsAction[] = [
    { action: 'list-relation-options', objectId: relationObjectId, limit: 200 },
  ]
  for (let offset = 0; offset < referencedIds.length; offset += 200) {
    requests.push({
      action: 'list-relation-options',
      objectId: relationObjectId,
      limit: 1,
      includeEntryIds: referencedIds.slice(offset, offset + 200),
    })
  }
  const results = await Promise.all(requests.map(load))
  const pages = results.map(result => {
    if (!('relationOptions' in result)) throw new Error(`Invalid relation options response: ${relationObjectId}`)
    return result
  })
  const revision = pages[0]?.revision
  if (revision === undefined || pages.some(page => page.revision !== revision)) {
    throw new Error(`Relation options changed during lookup: ${relationObjectId}`)
  }
  const optionsById = new Map<string, { id: string; label: string }>()
  for (const page of pages) {
    for (const option of page.relationOptions) optionsById.set(option.id, option)
  }
  return {
    options: [...optionsById.values()],
    nextCursor: pages[0]?.nextCursor ?? null,
    revision,
  }
}
