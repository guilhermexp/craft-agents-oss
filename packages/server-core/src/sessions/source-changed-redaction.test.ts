import { describe, expect, test } from 'bun:test'

import type { LoadedSource } from '@craft-agent/shared/sources/types'
import { RPC_NAMESPACES } from '@craft-agent/shared/protocol'
import {
  SessionWorkspaceRuntimeManager,
  type SessionWorkspaceRuntimeManagerDeps,
} from './session-workspace-runtime-manager'

describe('sources:changed public boundary', () => {
  test('config watcher broadcasts map every source through the public DTO', () => {
    const calls: unknown[][] = []
    const manager = new SessionWorkspaceRuntimeManager({
      getEventSink: () => ((...args: unknown[]) => calls.push(args)),
      getSession: () => undefined,
      getAllSessions: function* () {},
      createSession: async () => { throw new Error('not used') },
      sendMessage: async () => {},
      sendEvent: () => {},
      persistSession: () => {},
    } as SessionWorkspaceRuntimeManagerDeps)
    const source: LoadedSource = {
      config: {
        id: 'source-id',
        name: 'Source',
        slug: 'source',
        enabled: true,
        provider: 'provider',
        type: 'mcp',
        mcp: {
          transport: 'http',
          url: 'https://mcp.example.test/source',
          headers: { Authorization: 'Bearer watcher-secret' },
        },
      },
      guide: null,
      folderPath: '/workspace/sources/source',
      workspaceRootPath: '/workspace',
      workspaceId: 'workspace-1',
    }

    manager.broadcastSourcesChanged('workspace-1', [source])
    const evidence = JSON.stringify(calls)

    expect(calls[0]?.[0]).toBe(RPC_NAMESPACES.sources.CHANGED)
    expect(evidence).not.toContain('watcher-secret')
    expect(evidence).not.toContain('Authorization')
  })

  test('OAuth, headless callback, and SessionManager producers call the collection mapper', async () => {
    const roots = [
      '../handlers/rpc/oauth.ts',
      '../../../server/src/index.ts',
      './SessionManager.ts',
    ]

    for (const relativePath of roots) {
      const source = await Bun.file(new URL(relativePath, import.meta.url)).text()
      expect(source).toContain('toPublicSourceDtos(')
    }
  })
})
