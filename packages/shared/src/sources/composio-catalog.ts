import { z } from 'zod'
import { resolve } from 'node:path'

import { sanitizePublicSourceError } from './public-source-dto.ts'
import { hasExplicitCredentialMaterial } from './public-url.ts'
import { createSource, loadWorkspaceSources } from './storage.ts'
import type { CreateSourceInput, FolderSourceConfig, LoadedSource } from './types.ts'

const sourceToolIdentityPartSchema = z.string().regex(
  /^[A-Za-z0-9][A-Za-z0-9_.:-]{0,199}$/,
  'Tool identity must use portable name/version characters',
)
const providerIdentitySchema = z.string().trim().regex(
  /^[A-Za-z0-9][A-Za-z0-9_.:-]{0,199}$/,
  'Composio provider identity must use portable characters',
)

const composioMcpSchema = z.object({
  url: z.url(),
  authType: z.enum(['oauth', 'none']).optional(),
  clientId: z.string().trim().min(1).optional(),
})

const composioCatalogItemSchema = z.object({
  providerId: providerIdentitySchema,
  name: z.string().trim().min(1),
  description: z.string().trim().min(1).optional(),
  icon: z.string().trim().min(1).optional(),
  mcp: composioMcpSchema.optional(),
  expectedTools: z.array(z.object({
    name: sourceToolIdentityPartSchema,
    apiVersion: sourceToolIdentityPartSchema,
  })).min(1).optional(),
})

const materializableComposioItemSchema = composioCatalogItemSchema.extend({
  mcp: composioMcpSchema,
  expectedTools: z.array(z.object({
    name: sourceToolIdentityPartSchema,
    apiVersion: sourceToolIdentityPartSchema,
  })).min(1),
})

const composioCatalogPageSchema = z.object({
  items: z.array(composioCatalogItemSchema),
  nextCursor: z.string().trim().min(1).optional(),
})

export interface ComposioCatalogItem {
  providerId: string
  name: string
  description?: string
  icon?: string
  mcp?: {
    url: string
    authType?: 'oauth' | 'none'
    clientId?: string
  }
  expectedTools?: Array<{ name: string; apiVersion: string }>
}

export interface ComposioCatalogPageRequest {
  query: string
  cursor?: string
}

export interface CollectComposioCatalogOptions {
  query?: string
  fetchPage: (request: ComposioCatalogPageRequest) => Promise<unknown>
  maxPages?: number
}

export function normalizeComposioProviderIdentity(providerId: string): string {
  return providerId.trim().toLowerCase()
}

function assertPortableUrl(value: string): string {
  const url = new URL(value)
  if (url.username || url.password) {
    throw new Error('Composio source URL must not contain embedded credentials')
  }
  if (hasExplicitCredentialMaterial(url)) {
    throw new Error('Composio source URL must not contain credential parameters or path material')
  }
  return value
}

function assertPortableIcon(value: string): string {
  if (!/^https?:\/\//i.test(value)) return value
  return assertPortableUrl(value)
}

function toPublicCatalogItem(item: ComposioCatalogItem): ComposioCatalogItem {
  return {
    providerId: normalizeComposioProviderIdentity(item.providerId),
    name: sanitizePublicSourceError(item.name),
    ...(item.description === undefined
      ? {}
      : { description: sanitizePublicSourceError(item.description) }),
    ...(item.icon === undefined ? {} : { icon: assertPortableIcon(item.icon) }),
    ...(item.mcp === undefined
      ? {}
      : {
          mcp: {
            url: assertPortableUrl(item.mcp.url),
            ...(item.mcp.authType === undefined ? {} : { authType: item.mcp.authType }),
            ...(item.mcp.clientId === undefined ? {} : { clientId: item.mcp.clientId }),
          },
        }),
    ...(item.expectedTools === undefined
      ? {}
      : { expectedTools: item.expectedTools.map((tool) => ({ ...tool })) }),
  }
}

export async function collectComposioCatalog(
  options: CollectComposioCatalogOptions,
): Promise<ComposioCatalogItem[]> {
  const query = options.query?.trim() ?? ''
  const maxPages = options.maxPages ?? 50
  if (!Number.isFinite(maxPages) || !Number.isInteger(maxPages) || maxPages < 1 || maxPages > 100) {
    throw new Error('maxPages must be a finite integer from 1 to 100')
  }
  const itemsByProvider = new Map<string, ComposioCatalogItem>()
  const seenCursors = new Set<string>()
  let cursor: string | undefined

  for (let pageNumber = 0; pageNumber < maxPages; pageNumber += 1) {
    const page = composioCatalogPageSchema.parse(
      await options.fetchPage({ query, ...(cursor === undefined ? {} : { cursor }) }),
    )
    for (const item of page.items) {
      const providerId = normalizeComposioProviderIdentity(item.providerId)
      if (!itemsByProvider.has(providerId)) {
        itemsByProvider.set(providerId, toPublicCatalogItem(item))
      }
    }

    const nextCursor = page.nextCursor
    if (!nextCursor || seenCursors.has(nextCursor)) break
    seenCursors.add(nextCursor)
    cursor = nextCursor
  }

  return [...itemsByProvider.values()]
}

export function toPortableComposioSourceInput(input: unknown): CreateSourceInput {
  const item = toPublicCatalogItem(materializableComposioItemSchema.parse(input))
  if (item.mcp === undefined) {
    throw new Error('Composio source metadata is missing an MCP connection')
  }
  return {
    name: item.name,
    provider: normalizeComposioProviderIdentity(item.providerId),
    type: 'mcp',
    enabled: false,
    connectionStatus: 'unhealthy',
    expectedTools: item.expectedTools!.map((tool) => ({ ...tool })),
    ...(item.icon === undefined ? {} : { icon: assertPortableIcon(item.icon) }),
    mcp: {
      transport: 'http',
      url: assertPortableUrl(item.mcp.url),
      authType: item.mcp.authType ?? 'oauth',
      ...(item.mcp.clientId === undefined ? {} : { clientId: item.mcp.clientId }),
    },
  }
}

export interface ComposioSourceMaterializerDependencies {
  loadSources(workspaceRootPath: string): Array<Pick<LoadedSource, 'config'>>
  createSource(
    workspaceRootPath: string,
    input: CreateSourceInput,
  ): FolderSourceConfig | Promise<FolderSourceConfig>
}

export function createComposioSourceMaterializer(
  dependencies: ComposioSourceMaterializerDependencies,
): (workspaceRootPath: string, input: unknown) => Promise<FolderSourceConfig> {
  const locks = new Map<string, Promise<void>>()

  return async (workspaceRootPath, input) => {
    const sourceInput = toPortableComposioSourceInput(input)
    const lockKey = `${resolve(workspaceRootPath)}\0${sourceInput.provider}`
    const previousLock = locks.get(lockKey)
    let releaseLock: () => void = () => {}
    const currentLock = new Promise<void>((resolveLock) => {
      releaseLock = resolveLock
    })
    locks.set(lockKey, currentLock)

    if (previousLock) await previousLock
    try {
      const existing = dependencies.loadSources(workspaceRootPath).find(
        (source) => normalizeComposioProviderIdentity(source.config.provider) === sourceInput.provider,
      )
      if (existing) return existing.config
      return await dependencies.createSource(workspaceRootPath, sourceInput)
    } finally {
      releaseLock()
      if (locks.get(lockKey) === currentLock) locks.delete(lockKey)
    }
  }
}

export const materializeComposioSource = createComposioSourceMaterializer({
  loadSources: loadWorkspaceSources,
  createSource,
})
