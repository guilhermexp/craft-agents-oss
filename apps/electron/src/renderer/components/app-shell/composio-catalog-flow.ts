import type { ComposioCatalogItem, PublicSourceDto } from '../../../shared/types'

export interface ComposioCatalogRendererApi {
  getComposioCatalogCapability(): Promise<{ available: boolean }>
  discoverComposioCatalog(workspaceId: string, query: string): Promise<ComposioCatalogItem[]>
  materializeComposioCatalogSource(
    workspaceId: string,
    item: ComposioCatalogItem,
  ): Promise<PublicSourceDto>
}

export function getComposioCatalogCapability(
  api: ComposioCatalogRendererApi,
): Promise<{ available: boolean }> {
  return api.getComposioCatalogCapability()
}

export function discoverComposioCatalog(
  api: ComposioCatalogRendererApi,
  workspaceId: string,
  query: string,
): Promise<ComposioCatalogItem[]> {
  return api.discoverComposioCatalog(workspaceId, query.trim())
}

export function materializeComposioCatalogSelection(
  api: ComposioCatalogRendererApi,
  workspaceId: string,
  item: ComposioCatalogItem,
): Promise<PublicSourceDto> {
  return api.materializeComposioCatalogSource(workspaceId, item)
}
