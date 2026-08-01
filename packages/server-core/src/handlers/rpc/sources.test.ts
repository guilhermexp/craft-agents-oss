import { afterEach, beforeEach, describe, expect, mock, test } from 'bun:test'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'

import { RPC_NAMESPACES } from '@craft-agent/shared/protocol'
import type { HandlerFn, RequestContext, RpcServer } from '@craft-agent/server-core/transport'
import type { HandlerDeps } from '../handler-deps'

let workspaceRootPath = ''
let mcpListToolsError: Error | null = null

mock.module('@craft-agent/shared/mcp', () => ({
  CraftMcpClient: class {
    async listTools() {
      if (mcpListToolsError) throw mcpListToolsError
      return []
    }

    async close() {}
  },
}))

mock.module('@craft-agent/shared/config', () => ({
  getWorkspaceByNameOrId: (workspaceId: string) => (
    workspaceId === 'ws-1'
      ? { id: 'ws-1', name: 'Test Workspace', rootPath: workspaceRootPath }
      : null
  ),
}))

const { createComposioCatalogFetcher, registerSourcesHandlers } = await import('./sources')

function createHarness(options?: {
  fetchCatalogPage?: (request: { query: string; cursor?: string }) => Promise<unknown>
}): {
  handlers: Map<string, HandlerFn>
  ctx: RequestContext
  logs: string[]
  pushes: unknown[][]
} {
  const handlers = new Map<string, HandlerFn>()
  const logs: string[] = []
  const pushes: unknown[][] = []
  const server: RpcServer = {
    handle(channel, handler) {
      handlers.set(channel, handler)
    },
    push(...args: unknown[]) { pushes.push(args) },
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
        info(...args: unknown[]) { logs.push(args.map(String).join(' ')) },
        warn() {},
        error(...args: unknown[]) { logs.push(args.map(String).join(' ')) },
      },
    },
    sessionManager: {},
    oauthFlowStore: {},
    composioCatalog: options?.fetchCatalogPage
      ? { fetchPage: options.fetchCatalogPage }
      : undefined,
  } as unknown as HandlerDeps
  registerSourcesHandlers(server, deps)
  return {
    handlers,
    ctx: { clientId: 'client-1', workspaceId: 'ws-1', webContentsId: 1 },
    logs,
    pushes,
  }
}

beforeEach(() => {
  mcpListToolsError = null
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

describe('SOURCES_CREATE public DTO', () => {
  test('returns the same allowlisted DTO boundary as reads', async () => {
    const { handlers, ctx } = createHarness()
    const createSource = handlers.get(RPC_NAMESPACES.sources.CREATE)

    const source = await createSource!(ctx, 'ws-1', {
      name: 'Created',
      slug: 'created',
      provider: 'custom',
      type: 'mcp',
      mcp: {
        transport: 'http',
        url: 'https://mcp.example.test/source',
        authType: 'none',
        headers: { Authorization: 'Bearer create-secret' },
      },
    })
    const payload = JSON.stringify(source)

    expect(source.config.name).toBe('Created')
    expect(source.config.mcp).toEqual({
      transport: 'http',
      url: 'https://mcp.example.test/source',
      authType: 'none',
    })
    expect(payload).not.toContain('create-secret')
    expect(payload).not.toContain('headers')
  })
})

describe('SOURCES_GET_MCP_TOOLS public errors', () => {
  test('redacts persisted connection errors before returning them', async () => {
    const { handlers, ctx } = createHarness()
    const getMcpTools = handlers.get(RPC_NAMESPACES.sources.GET_MCP_TOOLS)

    const result = await getMcpTools!(ctx, 'ws-1', 'mail')
    const payload = JSON.stringify(result)

    expect(result).toEqual({
      success: false,
      error: '401 Authorization: Bearer [REDACTED]; refresh_token=[REDACTED]; provider_secret=[REDACTED]; credentials=[REDACTED]',
    })
    expect(payload).not.toContain('error-token')
    expect(payload).not.toContain('credential-secret')
  })

  test('never logs or returns credentials from MCP URLs and thrown client errors', async () => {
    const sourcePath = join(workspaceRootPath, 'sources', 'mail')
    writeFileSync(join(sourcePath, 'config.json'), JSON.stringify({
      id: 'mail_1234',
      name: 'Mail',
      slug: 'mail',
      enabled: true,
      provider: 'gmail',
      type: 'mcp',
      mcp: {
        transport: 'http',
        url: 'https://mcp.example.test/connect?api-key=url-secret&safe=value',
        authType: 'none',
      },
      connectionStatus: 'connected',
    }))
    mcpListToolsError = new Error(
      'request failed token=thrown-secret at https://mcp.example.test/connect?credential=error-url-secret',
    )
    const { handlers, ctx, logs } = createHarness()
    const getMcpTools = handlers.get(RPC_NAMESPACES.sources.GET_MCP_TOOLS)

    const result = await getMcpTools!(ctx, 'ws-1', 'mail')
    const publicEvidence = JSON.stringify({ result, logs })

    expect(result).toEqual({
      success: false,
      error: 'request failed token=[REDACTED] at https://mcp.example.test/connect?credential=[REDACTED]',
    })
    expect(publicEvidence).not.toContain('url-secret')
    expect(publicEvidence).not.toContain('thrown-secret')
    expect(publicEvidence).not.toContain('error-url-secret')
  })
})

describe('Composio source product RPC', () => {
  test('reports catalog availability from an explicit server capability', async () => {
    const unavailableHarness = createHarness()
    const availableHarness = createHarness({ fetchCatalogPage: async () => ({ items: [] }) })
    const unavailable = unavailableHarness.handlers.get(RPC_NAMESPACES.sources.CATALOG_CAPABILITY)
    const available = availableHarness.handlers.get(RPC_NAMESPACES.sources.CATALOG_CAPABILITY)

    expect(await unavailable!(unavailableHarness.ctx)).toEqual({ available: false })
    expect(await available!(availableHarness.ctx)).toEqual({ available: true })
  })

  test('builds a server-side catalog fetcher without renderer credentials', async () => {
    const requestedUrls: string[] = []
    const fetchPage = createComposioCatalogFetcher(
      'https://catalog.example.test/toolkits',
      async (input) => {
        requestedUrls.push(String(input))
        return new Response(JSON.stringify({ items: [] }), {
          status: 200,
          headers: { 'content-type': 'application/json' },
        })
      },
    )

    const result = await fetchPage({ query: 'linear', cursor: 'page-2' })

    expect(result).toEqual({ items: [] })
    expect(requestedUrls).toEqual([
      'https://catalog.example.test/toolkits?search=linear&cursor=page-2',
    ])
  })

  test('discovers through an injected server-side page fetcher', async () => {
    const requests: Array<{ query: string; cursor?: string }> = []
    const { handlers, ctx } = createHarness({
      fetchCatalogPage: async (request) => {
        requests.push(request)
        return {
          items: [{
            providerId: 'linear',
            name: 'Linear',
            mcp: {
              url: 'https://mcp.composio.dev/550e8400-e29b-41d4-a716-446655440000/mcp',
              authType: 'oauth',
            },
            expectedTools: [{ name: 'issues_list', apiVersion: 'v1' }],
          }],
        }
      },
    })
    const discover = handlers.get(RPC_NAMESPACES.sources.DISCOVER_CATALOG)

    const result = await discover!(ctx, 'ws-1', 'linear')

    expect(requests).toEqual([{ query: 'linear' }])
    expect(result).toHaveLength(1)
    expect(result[0]?.providerId).toBe('linear')
  })

  test('materializes a selected toolkit disabled and broadcasts only public DTOs', async () => {
    const { handlers, ctx, pushes } = createHarness({ fetchCatalogPage: async () => ({ items: [] }) })
    const materialize = handlers.get(RPC_NAMESPACES.sources.MATERIALIZE_CATALOG)

    const result = await materialize!(ctx, 'ws-1', {
      providerId: 'linear',
      name: 'Linear',
      mcp: {
        url: 'https://mcp.composio.dev/550e8400-e29b-41d4-a716-446655440000/mcp',
        authType: 'oauth',
        headers: { Authorization: 'Bearer rpc-materialize-secret' },
      },
      expectedTools: [{ name: 'issues_list', apiVersion: 'v1' }],
      credentials: { token: 'rpc-catalog-secret' },
    })
    const evidence = JSON.stringify({ result, pushes })

    expect(result.config.enabled).toBe(false)
    expect(result.config.connectionStatus).toBe('unhealthy')
    expect(evidence).not.toContain('rpc-materialize-secret')
    expect(evidence).not.toContain('rpc-catalog-secret')
    expect(pushes.some((push) => push.includes(RPC_NAMESPACES.sources.CHANGED))).toBe(true)
  })
})
