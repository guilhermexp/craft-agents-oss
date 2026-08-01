import { afterEach, beforeEach, describe, expect, mock, test } from 'bun:test'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'

import { RPC_NAMESPACES } from '@craft-agent/shared/protocol'
import type { HandlerFn, RequestContext, RpcServer } from '@craft-agent/server-core/transport'
import type { HandlerDeps } from '../handler-deps'

let workspaceRootPath = ''

mock.module('@craft-agent/shared/config', () => ({
  getWorkspaceByNameOrId: (workspaceId: string) => (
    workspaceId === 'ws-1'
      ? { id: 'ws-1', name: 'Test Workspace', rootPath: workspaceRootPath }
      : null
  ),
}))

const { registerSourcesHandlers } = await import('./sources')

function createHarness(): { handlers: Map<string, HandlerFn>; ctx: RequestContext } {
  const handlers = new Map<string, HandlerFn>()
  const server: RpcServer = {
    handle(channel, handler) {
      handlers.set(channel, handler)
    },
    push() {},
    async invokeClient() {
      return undefined
    },
    hasClientCapability() {
      return false
    },
    findClientsWithCapability() {
      return []
    },
  }
  const deps = {
    platform: {
      logger: {
        debug() {},
        info() {},
        warn() {},
        error() {},
      },
    },
    sessionManager: {},
    oauthFlowStore: {},
  } as unknown as HandlerDeps
  registerSourcesHandlers(server, deps)
  return {
    handlers,
    ctx: { clientId: 'client-1', workspaceId: 'ws-1', webContentsId: 1 },
  }
}

beforeEach(() => {
  workspaceRootPath = mkdtempSync(join(tmpdir(), 'craft-sources-rpc-'))
  const sourcePath = join(workspaceRootPath, 'sources', 'mail')
  mkdirSync(sourcePath, { recursive: true })
  writeFileSync(join(sourcePath, 'config.json'), JSON.stringify({
    id: 'mail_1234',
    name: 'Mail',
    slug: 'mail',
    enabled: true,
    provider: 'gmail',
    type: 'mcp',
    icon: 'https://assets.example.test/mail.png?token=icon-secret',
    tagline: 'Authorization: Bearer tagline-token',
    mcp: {
      transport: 'http',
      url: 'https://connect.example.test/mcp',
      authType: 'oauth',
      clientId: 'public-client-id',
      env: { PROVIDER_SECRET: 'provider-secret' },
      headers: { Authorization: 'Bearer header-token' },
    },
    connectionStatus: 'failed',
    connectionError: '401 Authorization: Bearer error-token; refresh_token=refresh-secret; provider_secret=provider-secret; credentials=credential-secret',
    expectedTools: [
      { name: 'messages_list', apiVersion: 'v1' },
      { name: 'Authorization Bearer tool-secret', apiVersion: 'token=version-secret' },
    ],
    readiness: {
      status: 'unhealthy',
      reason: 'missing-tools',
      observedTools: [
        { name: 'messages_list', apiVersion: 'v1' },
        { name: 'Authorization Bearer observed-secret', apiVersion: 'credential=health-secret' },
      ],
      checkedAt: 123,
    },
  }))
  writeFileSync(join(sourcePath, 'guide.md'), '# Mail\n\n## Context\n\nAuthorization: Bearer guide-token')
})

afterEach(() => {
  rmSync(workspaceRootPath, { recursive: true, force: true })
  workspaceRootPath = ''
})

describe('SOURCES_GET public DTO', () => {
  test('returns an allowlisted config and a sanitized connection error', async () => {
    const { handlers, ctx } = createHarness()
    const getSources = handlers.get(RPC_NAMESPACES.sources.GET)
    expect(getSources).toBeDefined()

    const sources = await getSources!(ctx, 'ws-1')

    expect(sources).toHaveLength(1)
    expect(sources[0]?.config.mcp).toEqual({
      transport: 'http',
      url: 'https://connect.example.test/mcp',
      authType: 'oauth',
      clientId: 'public-client-id',
    })
    expect(sources[0]?.config.connectionError).toBe(
      '401 Authorization: Bearer [REDACTED]; refresh_token=[REDACTED]; provider_secret=[REDACTED]; credentials=[REDACTED]',
    )
    expect(sources[0]?.config.expectedTools).toEqual([{ name: 'messages_list', apiVersion: 'v1' }])
    expect(sources[0]?.config.readiness).toEqual({
      status: 'unhealthy',
      reason: 'missing-tools',
      observedTools: [{ name: 'messages_list', apiVersion: 'v1' }],
      checkedAt: 123,
    })
    const publicPayload = JSON.stringify(sources)
    expect(publicPayload).not.toContain('provider-secret')
    expect(publicPayload).not.toContain('header-token')
    expect(publicPayload).not.toContain('error-token')
    expect(publicPayload).not.toContain('refresh-secret')
    expect(publicPayload).not.toContain('icon-secret')
    expect(publicPayload).not.toContain('tagline-token')
    expect(publicPayload).not.toContain('guide-token')
    expect(publicPayload).not.toContain('credential-secret')
    expect(publicPayload).not.toContain('PROVIDER_SECRET')
    expect(publicPayload).not.toContain('tool-secret')
    expect(publicPayload).not.toContain('version-secret')
    expect(publicPayload).not.toContain('observed-secret')
    expect(publicPayload).not.toContain('health-secret')
  })
})
