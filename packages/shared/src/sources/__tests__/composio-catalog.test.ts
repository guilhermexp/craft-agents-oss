import { afterEach, describe, expect, test } from 'bun:test'
import { mkdtempSync, readFileSync, rmSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'

import {
  collectComposioCatalog,
  createComposioSourceMaterializer,
  materializeComposioSource,
  toPortableComposioSourceInput,
} from '../composio-catalog'
import { FolderSourceConfigSchema } from '../../config/validators'
import type { FolderSourceConfig, LoadedSource } from '../types'
import { getSourcePath, isSourceUsable, loadWorkspaceSources } from '../storage'

const temporaryWorkspaces: string[] = []

afterEach(() => {
  for (const workspaceRootPath of temporaryWorkspaces.splice(0)) {
    rmSync(workspaceRootPath, { recursive: true, force: true })
  }
})

describe('collectComposioCatalog', () => {
  test('paginates search results and deduplicates repeated toolkits by stable provider identity', async () => {
    const requestedCursors: Array<string | undefined> = []
    const result = await collectComposioCatalog({
      query: 'mail',
      fetchPage: async ({ cursor, query }) => {
        requestedCursors.push(cursor)
        expect(query).toBe('mail')
        return cursor === undefined
          ? {
              items: [
                { providerId: 'gmail', name: 'Gmail', description: 'Mail by Google' },
                { providerId: 'outlook', name: 'Outlook', description: 'Mail by Microsoft' },
              ],
              nextCursor: 'page-2',
            }
          : {
              items: [
                { providerId: 'gmail', name: 'Gmail duplicate', description: 'Repeated page item' },
              ],
            }
      },
    })

    expect(requestedCursors).toEqual([undefined, 'page-2'])
    expect(result.map((item) => item.providerId)).toEqual(['gmail', 'outlook'])
    expect(result[0]?.name).toBe('Gmail')
  })

  test.each([0, 101, 1.5, Number.NaN, Number.POSITIVE_INFINITY])(
    'rejects non-finite, fractional, or out-of-range maxPages: %p',
    async (maxPages) => {
      await expect(collectComposioCatalog({
        maxPages,
        fetchPage: async () => ({ items: [] }),
      })).rejects.toThrow('maxPages')
    },
  )

  test('materializes only portable connection metadata and cannot carry provider secrets', () => {
    const sourceInput = toPortableComposioSourceInput({
      providerId: 'GMAIL',
      name: 'Gmail',
      description: 'Google mail',
      icon: '📬',
      mcp: {
        url: 'https://connect.example.test/gmail/mcp',
        authType: 'oauth',
        clientId: 'public-client-id',
        headers: { Authorization: 'Bearer catalog-token' },
        token: 'catalog-token',
      },
      expectedTools: [
        { name: 'messages_list', apiVersion: 'v1' },
        { name: 'messages_send', apiVersion: 'v1' },
      ],
      credentials: { accessToken: 'catalog-token' },
      providerSecret: 'provider-secret',
    })

    expect(sourceInput).toEqual({
      name: 'Gmail',
      provider: 'gmail',
      type: 'mcp',
      enabled: false,
      connectionStatus: 'unhealthy',
      expectedTools: [
        { name: 'messages_list', apiVersion: 'v1' },
        { name: 'messages_send', apiVersion: 'v1' },
      ],
      icon: '📬',
      mcp: {
        transport: 'http',
        url: 'https://connect.example.test/gmail/mcp',
        authType: 'oauth',
        clientId: 'public-client-id',
      },
    })
    expect(JSON.stringify(sourceInput)).not.toContain('catalog-token')
    expect(JSON.stringify(sourceInput)).not.toContain('provider-secret')
    expect(JSON.stringify(sourceInput).toLowerCase()).not.toContain('authorization')
  })

  test('rejects credential-bearing URLs before source materialization', () => {
    expect(() => toPortableComposioSourceInput({
      providerId: 'gmail',
      name: 'Gmail',
      icon: 'https://assets.example.test/gmail.png?access_token=icon-secret',
      mcp: {
        url: 'https://connect.example.test/gmail/mcp',
        authType: 'oauth',
      },
      expectedTools: [{ name: 'messages_list', apiVersion: 'v1' }],
    })).toThrow('credential parameters')

    expect(() => toPortableComposioSourceInput({
      providerId: 'gmail',
      name: 'Gmail',
      icon: '📬',
      mcp: {
        url: 'https://provider-secret:password@connect.example.test/gmail/mcp',
        authType: 'oauth',
      },
      expectedTools: [{ name: 'messages_list', apiVersion: 'v1' }],
    })).toThrow('embedded credentials')

    expect(() => toPortableComposioSourceInput({
      providerId: 'gmail',
      name: 'Gmail',
      mcp: { url: 'https://connect.example.test/gmail/mcp', authType: 'oauth' },
      expectedTools: [{ name: 'Authorization: Bearer tool-secret', apiVersion: 'v1' }],
    })).toThrow()
  })

  test.each([
    'https://mcp.example.test/connect?key=query-secret',
    'https://mcp.example.test/connect?api-key=query-secret',
    'https://mcp.example.test/connect?token=query-secret',
    'https://mcp.example.test/connect?credential=query-secret',
    'https://mcp.example.test/connect?X-Amz-Signature=query-secret',
    'https://mcp.example.test/connect?X-Amz-Credential=query-secret',
    'https://mcp.example.test/connect?X-Amz-Security-Token=query-secret',
    'https://mcp.example.test/connect#token=fragment-secret',
    'https://mcp.example.test/connect#safe=value&credential=nested-fragment-secret',
    'https://mcp.example.test/token/path-secret',
    'https://mcp.example.test/api-key/path-secret',
    'https://mcp.example.test/credential/path-secret',
    'https://mcp.example.test/clientSecret/path-secret',
    'https://mcp.example.test/connect?client_secret=query-secret',
    'https://mcp.example.test/connect?privateKey=query-secret',
    'https://mcp.example.test/connect?consumer-secret=query-secret',
    'https://mcp.example.test/connect?signature=query-secret',
    'https://mcp.example.test/connect#securityToken=fragment-secret',
    'https://mcp.example.test/connect?signed-url=query-secret',
  ])('rejects explicit credential material in catalog URLs: %s', (url) => {
    expect(() => toPortableComposioSourceInput({
      providerId: 'linear',
      name: 'Linear',
      mcp: { url, authType: 'oauth' },
      expectedTools: [{ name: 'issues_list', apiVersion: 'v1' }],
    })).toThrow('credential')
  })

  test('preserves an ordinary Composio MCP UUID path', () => {
    const url = 'https://mcp.composio.dev/550e8400-e29b-41d4-a716-446655440000/mcp'
    expect(toPortableComposioSourceInput({
      providerId: 'linear',
      name: 'Linear',
      mcp: { url, authType: 'oauth' },
      expectedTools: [{ name: 'issues_list', apiVersion: 'v1' }],
    }).mcp?.url).toBe(url)
  })

  test('never returns credentials embedded in public catalog metadata', async () => {
    await expect(collectComposioCatalog({
      fetchPage: async () => ({
        items: [{
          providerId: 'https://catalog.example.test/provider?token=provider-secret',
          name: 'Unsafe provider identity',
        }],
      }),
    })).rejects.toThrow('provider')

    await expect(collectComposioCatalog({
      fetchPage: async () => ({
        items: [{
          providerId: 'gmail',
          name: 'Gmail',
          description: 'Authorization: Bearer description-token',
          icon: '📬',
          mcp: {
            url: 'https://connect.example.test/gmail/mcp?access_token=url-token',
            authType: 'oauth',
          },
        }],
      }),
    })).rejects.toThrow('credential parameters')

    const result = await collectComposioCatalog({
      fetchPage: async () => ({
        items: [{
          providerId: 'gmail',
          name: 'Docs https://catalog.example.test/name?token=name-token',
          description: 'See https://catalog.example.test/description#access_token=description-token',
          icon: '📬',
        }],
      }),
    })
    expect(JSON.stringify(result)).not.toContain('name-token')
    expect(JSON.stringify(result)).not.toContain('description-token')
  })

  test('reuses a local source with the same stable provider identity', async () => {
    const workspaceRootPath = mkdtempSync(join(tmpdir(), 'craft-composio-source-'))
    temporaryWorkspaces.push(workspaceRootPath)
    const toolkit = {
      providerId: 'gmail',
      name: 'Gmail',
      icon: '📬',
      mcp: {
        url: 'https://connect.example.test/gmail/mcp',
        authType: 'oauth' as const,
      },
      expectedTools: [{ name: 'messages_list', apiVersion: 'v1' }],
    }

    const first = await materializeComposioSource(workspaceRootPath, toolkit)
    const second = await materializeComposioSource(workspaceRootPath, {
      ...toolkit,
      providerId: ' GMAIL ',
      name: 'Renamed catalog label',
    })

    expect(second.id).toBe(first.id)
    expect(loadWorkspaceSources(workspaceRootPath)).toHaveLength(1)
    const persisted = readFileSync(join(getSourcePath(workspaceRootPath, first.slug), 'config.json'), 'utf8')
    expect(persisted).not.toContain('token')
    expect(persisted).not.toContain('credential')
    expect(persisted.toLowerCase()).not.toContain('authorization')
  })

  test('serializes concurrent materialization and rechecks identity inside the lock', async () => {
    const stored: FolderSourceConfig[] = []
    let creates = 0
    const materialize = createComposioSourceMaterializer({
      loadSources: () => stored.map((config) => ({ config })),
      createSource: async (_workspaceRootPath, sourceInput) => {
        creates += 1
        await Promise.resolve()
        const config = {
          ...sourceInput,
          id: `source-${creates}`,
          slug: 'linear',
        } as FolderSourceConfig
        stored.push(config)
        return config
      },
    })
    const toolkit = {
      providerId: 'linear',
      name: 'Linear',
      mcp: { url: 'https://mcp.composio.dev/550e8400-e29b-41d4-a716-446655440000/mcp' },
      expectedTools: [{ name: 'issues_list', apiVersion: 'v1' }],
    }

    const results = await Promise.all(Array.from({ length: 8 }, () => materialize('/workspace', toolkit)))

    expect(new Set(results.map((source) => source.id))).toEqual(new Set(['source-1']))
    expect(creates).toBe(1)
  })

  test('never exposes expected-tool sources before readiness is healthy', () => {
    const loaded: LoadedSource = {
      config: {
        id: 'linear-id',
        name: 'Linear',
        slug: 'linear',
        enabled: true,
        provider: 'linear',
        type: 'mcp',
        isAuthenticated: true,
        mcp: { transport: 'http', url: 'https://linear.example.test/mcp', authType: 'oauth' },
        expectedTools: [{ name: 'issues_list', apiVersion: 'v1' }],
        readiness: { status: 'unhealthy', reason: 'missing-tools', checkedAt: 1 },
      },
      guide: null,
      folderPath: '/workspace/sources/linear',
      workspaceRootPath: '/workspace',
      workspaceId: 'workspace',
    }

    expect(isSourceUsable(loaded)).toBe(false)
    loaded.config.readiness = { status: 'ready', checkedAt: 2 }
    expect(isSourceUsable(loaded)).toBe(true)
  })

  test('rejects U7 expected tools without a real explicit API version', () => {
    expect(() => toPortableComposioSourceInput({
      providerId: 'linear',
      name: 'Linear',
      mcp: { url: 'https://linear.example.test/mcp' },
      expectedTools: [{ name: 'issues_list', apiVersion: 'unversioned' }],
    })).toThrow()
  })

  test('treats expectedTools empty as the explicit legacy no-readiness contract', () => {
    const parsed = FolderSourceConfigSchema.parse({
      id: 'legacy-id',
      name: 'Legacy',
      slug: 'legacy',
      enabled: true,
      provider: 'legacy',
      type: 'mcp',
      mcp: { transport: 'http', url: 'https://legacy.example.test/mcp', authType: 'none' },
      expectedTools: [],
    })
    const loaded: LoadedSource = {
      config: parsed as FolderSourceConfig,
      guide: null,
      folderPath: '/workspace/sources/legacy',
      workspaceRootPath: '/workspace',
      workspaceId: 'workspace',
    }

    expect(isSourceUsable(loaded)).toBe(true)
  })
})
