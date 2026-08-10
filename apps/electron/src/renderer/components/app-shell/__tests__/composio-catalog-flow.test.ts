import { describe, expect, test } from 'bun:test'
import { join } from 'node:path'

import {
  discoverComposioCatalog,
  getComposioCatalogCapability,
  materializeComposioCatalogSelection,
} from '../composio-catalog-flow'

describe('Composio catalog renderer flow', () => {
  test('discovers and materializes through typed RPC without renderer credentials', async () => {
    const calls: unknown[][] = []
    const api = {
      getComposioCatalogCapability: async () => ({ available: true }),
      discoverComposioCatalog: async (...args: unknown[]) => {
        calls.push(['discover', ...args])
        return [{ providerId: 'linear', name: 'Linear' }]
      },
      materializeComposioCatalogSource: async (...args: unknown[]) => {
        calls.push(['materialize', ...args])
        return {
          config: {
            id: 'linear-id',
            name: 'Linear',
            slug: 'linear',
            enabled: false,
            provider: 'linear',
            type: 'mcp' as const,
            connectionStatus: 'unhealthy' as const,
          },
          guide: null,
          folderPath: '/workspace/sources/linear',
          workspaceRootPath: '/workspace',
          workspaceId: 'workspace-1',
        }
      },
    }

    expect(await getComposioCatalogCapability(api)).toEqual({ available: true })
    const catalog = await discoverComposioCatalog(api, 'workspace-1', '  linear  ')
    const source = await materializeComposioCatalogSelection(api, 'workspace-1', catalog[0]!)

    expect(calls).toEqual([
      ['discover', 'workspace-1', 'linear'],
      ['materialize', 'workspace-1', catalog[0]],
    ])
    expect(source.config.enabled).toBe(false)
    expect(source.config.connectionStatus).toBe('unhealthy')
  })

  test('keeps the RPC consumer wired into the source list and OAuth/test continuation', async () => {
    const sourceList = await Bun.file(join(import.meta.dir, '..', 'SourcesListPanel.tsx')).text()
    const sourceInfo = await Bun.file(join(import.meta.dir, '..', '..', '..', 'pages', 'SourceInfoPage.tsx')).text()

    expect(sourceList).toContain('discoverComposioCatalog(')
    expect(sourceList).toContain('materializeComposioCatalogSelection(')
    expect(sourceList).toContain('getComposioCatalogCapability(')
    expect(sourceList).toContain('catalogAvailable ?')
    expect(sourceInfo).toContain('performOAuth(')
    expect(sourceInfo).toContain('sourceInfo.readinessFailed')
  })
})
