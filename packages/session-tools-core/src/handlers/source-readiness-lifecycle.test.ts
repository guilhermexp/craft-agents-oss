import { afterEach, describe, expect, test } from 'bun:test'
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import type { SessionToolContext } from '../context.ts'
import type { SessionSourceReadiness, SourceActivationReason } from './source-readiness.ts'
import type { SourceConfig } from '../types.ts'
import { handleSourceTest } from './source-test.ts'

const tempDirs: string[] = []
const expectedTools = [{ name: 'issues_list', apiVersion: 'v1' }]

afterEach(() => {
  for (const path of tempDirs.splice(0)) rmSync(path, { recursive: true, force: true })
})

function createWorkspace(config: Partial<SourceConfig> = {}): { workspacePath: string; configPath: string } {
  const workspacePath = mkdtempSync(join(tmpdir(), 'source-readiness-lifecycle-'))
  tempDirs.push(workspacePath)
  const sourcePath = join(workspacePath, 'sources', 'composio-linear')
  mkdirSync(sourcePath, { recursive: true })
  const configPath = join(sourcePath, 'config.json')
  writeFileSync(configPath, JSON.stringify({
    id: 'composio-linear-id',
    name: 'Linear',
    slug: 'composio-linear',
    enabled: false,
    provider: 'linear',
    type: 'mcp',
    tagline: 'Linear through Composio',
    icon: '🧰',
    connectionStatus: 'unhealthy',
    expectedTools,
    readiness: { status: 'unhealthy', reason: 'missing-tools', checkedAt: 1 },
    mcp: { transport: 'stdio', command: 'linear-mcp' },
    ...config,
  }))
  writeFileSync(
    join(sourcePath, 'guide.md'),
    '# Linear\n\nThis guide intentionally contains enough words to avoid unrelated completeness warnings while the test verifies transactional readiness activation without exposing a source before its final configuration can be persisted safely.',
  )
  return { workspacePath, configPath }
}

function createCtx(
  workspacePath: string,
  configPath: string,
  sessionSourceReadiness: SessionSourceReadiness,
  sessionId = 'session-1',
): SessionToolContext {
  return {
    sessionId,
    workspacePath,
    get sourcesPath() { return join(workspacePath, 'sources') },
    get skillsPath() { return join(workspacePath, 'skills') },
    plansFolderPath: join(workspacePath, 'plans'),
    callbacks: { onPlanSubmitted() {}, onAuthRequest() {} },
    fs: {
      exists: existsSync,
      readFile: (path: string) => readFileSync(path, 'utf8'),
      readFileBuffer: (path: string) => readFileSync(path),
      writeFile: (path: string, content: string) => writeFileSync(path, content),
      isDirectory: (path: string) => statSync(path).isDirectory(),
      readdir: readdirSync,
      stat: (path: string) => {
        const stat = statSync(path)
        return { size: stat.size, isDirectory: () => stat.isDirectory() }
      },
    },
    loadSourceConfig: () => JSON.parse(readFileSync(configPath, 'utf8')) as SourceConfig,
    saveSourceConfig: (source: SourceConfig) => writeFileSync(configPath, JSON.stringify(source)),
    validateStdioMcpConnection: async () => ({
      success: true,
      toolCount: expectedTools.length,
      toolNames: expectedTools.map((tool) => tool.name),
    }),
    sessionSourceReadiness,
  } as unknown as SessionToolContext
}

describe('source_test readiness activation lifecycle', () => {
  test('persists staged-unhealthy before exposure and ready only after the activation commit', async () => {
    const { workspacePath, configPath } = createWorkspace()
    const order: string[] = []
    const session: SessionSourceReadiness = {
      backend: 'claude',
      probeSourceTools: async () => {
        order.push('probe')
        return { ok: true, observedTools: expectedTools }
      },
      activateSource: async (_sourceSlug, persistReady) => {
        order.push('commit')
        persistReady()
        return { ok: true }
      },
      persistSourceConfig: (source) => {
        order.push(`persist:${source.readiness?.status ?? 'unknown'}`)
        writeFileSync(configPath, JSON.stringify(source))
      },
    }

    const result = await handleSourceTest(createCtx(workspacePath, configPath, session), { sourceSlug: 'composio-linear' })

    expect(order).toEqual(['probe', 'persist:unhealthy', 'commit', 'persist:ready'])
    const persisted = JSON.parse(readFileSync(configPath, 'utf8')) as SourceConfig
    expect(persisted.enabled).toBe(true)
    expect(persisted.readiness?.status).toBe('ready')
    expect(result.isError).toBe(false)
  })

  test('keeps the staged config unhealthy and never persists ready when activation fails', async () => {
    const { workspacePath, configPath } = createWorkspace()
    const statuses: string[] = []
    const session: SessionSourceReadiness = {
      backend: 'claude',
      probeSourceTools: async () => ({ ok: true, observedTools: expectedTools }),
      activateSource: async () => ({ ok: false, reason: 'commit-failed' }),
      persistSourceConfig: (source) => {
        statuses.push(source.readiness?.status ?? 'unknown')
        writeFileSync(configPath, JSON.stringify(source))
      },
    }

    const result = await handleSourceTest(createCtx(workspacePath, configPath, session), { sourceSlug: 'composio-linear' })

    expect(statuses).toEqual(['unhealthy'])
    const persisted = JSON.parse(readFileSync(configPath, 'utf8')) as SourceConfig
    expect(persisted.enabled).toBe(false)
    expect(persisted.readiness).toMatchObject({ status: 'unhealthy', reason: 'backend-injection-failed' })
    expect(result.isError).toBe(true)
    expect(JSON.stringify(result)).not.toContain('sentinel')
  })
})

describe('source_test legacy save failures', () => {
  test('reports a warning and skips activation when non-readiness metadata cannot be saved', async () => {
    const { workspacePath, configPath } = createWorkspace()
    const config = JSON.parse(readFileSync(configPath, 'utf8')) as SourceConfig
    delete config.expectedTools
    delete config.readiness
    writeFileSync(configPath, JSON.stringify(config))

    const activateCalls: string[] = []
    const ctx = {
      ...createCtx(workspacePath, configPath, {
        backend: 'claude',
        probeSourceTools: async () => ({ ok: true, observedTools: expectedTools }),
        activateSource: async () => ({ ok: true }),
        persistSourceConfig: () => {},
      }),
      saveSourceConfig: () => { throw new Error('disk failed credential-sentinel') },
      activateSourceInSession: async (sourceSlug: string) => {
        activateCalls.push(sourceSlug)
        return { ok: true, availability: 'next-turn' as const }
      },
    } as unknown as SessionToolContext

    const result = await handleSourceTest(ctx, { sourceSlug: 'composio-linear' })
    const text = result.content[0]?.text ?? ''

    expect(activateCalls).toEqual([])
    expect(text).toContain('Config could not be updated')
    expect(text).toContain('Validation passed with warnings')
    expect(text).not.toContain('Result: ✓ Validation passed')
    expect(result.isError).toBeFalsy()
  })
})

describe('source_test readiness without a bound seam', () => {
  test('demotes a previously enabled/ready source to disabled/unhealthy unsupported-backend via saveSourceConfig', async () => {
    const { workspacePath, configPath } = createWorkspace({
      enabled: true,
      connectionStatus: 'connected',
      readiness: { status: 'ready', observedTools: expectedTools, checkedAt: 1 },
    })

    const base = createCtx(workspacePath, configPath, {} as unknown as SessionSourceReadiness)
    const ctx = { ...base, sessionSourceReadiness: undefined } as unknown as SessionToolContext

    const result = await handleSourceTest(ctx, { sourceSlug: 'composio-linear' })

    const persisted = JSON.parse(readFileSync(configPath, 'utf8')) as SourceConfig
    expect(persisted.enabled).toBe(false)
    expect(persisted.connectionStatus).toBe('unhealthy')
    expect(persisted.readiness).toMatchObject({ status: 'unhealthy', reason: 'unsupported-backend' })
    expect(result.isError).toBe(true)
  })

  test('does not claim success when the fallback persist itself fails', async () => {
    const { workspacePath, configPath } = createWorkspace({
      enabled: true,
      connectionStatus: 'connected',
      readiness: { status: 'ready', observedTools: expectedTools, checkedAt: 1 },
    })

    const base = createCtx(workspacePath, configPath, {} as unknown as SessionSourceReadiness)
    const ctx = {
      ...base,
      sessionSourceReadiness: undefined,
      saveSourceConfig: () => { throw new Error('disk failed credential-sentinel') },
    } as unknown as SessionToolContext

    const result = await handleSourceTest(ctx, { sourceSlug: 'composio-linear' })
    const text = result.content[0]?.text ?? ''

    expect(result.isError).toBe(true)
    expect(text).not.toContain('Result: ✓ Validation passed')
    expect(text).not.toContain('sentinel')
  })
})

describe('source_test activation stage messages', () => {
  const stageMessages = {
    'exposure-failed': 'session exposure could not be established',
    'commit-failed': 'activation commit failed',
    'ready-persist-failed': 'ready state could not be persisted after activation',
  } as const

  for (const [stage, message] of Object.entries(stageMessages)) {
    test(`renders a distinct message for ${stage} while persisting the stable reason`, async () => {
      const { workspacePath, configPath } = createWorkspace()
      const session: SessionSourceReadiness = {
        backend: 'claude',
        probeSourceTools: async () => ({ ok: true, observedTools: expectedTools }),
        activateSource: async () => ({ ok: false, reason: stage as SourceActivationReason }),
        persistSourceConfig: (source) => writeFileSync(configPath, JSON.stringify(source)),
      }

      const result = await handleSourceTest(createCtx(workspacePath, configPath, session), { sourceSlug: 'composio-linear' })
      const text = result.content[0]?.text ?? ''

      expect(text).toContain(`✗ Session tool probe failed: ${message}`)
      const persisted = JSON.parse(readFileSync(configPath, 'utf8')) as SourceConfig
      expect(persisted.readiness).toMatchObject({ status: 'unhealthy', reason: 'backend-injection-failed' })
      expect(result.isError).toBe(true)
    })
  }
})
