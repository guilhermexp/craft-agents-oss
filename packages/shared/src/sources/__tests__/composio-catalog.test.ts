import { afterEach, describe, expect, test } from 'bun:test'
import { mkdtempSync, readFileSync, rmSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'

import {
  collectComposioCatalog,
  materializeComposioSource,
  toPortableComposioSourceInput,
} from '../composio-catalog'
import type { LoadedSource } from '../types'
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

  test('never returns credentials embedded in public catalog metadata', async () => {
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
          name: 'Authorization: Bearer name-token',
          description: 'refresh_token=description-token',
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
})
