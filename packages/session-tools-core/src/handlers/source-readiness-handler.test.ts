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
import type { SessionSourceReadiness } from './source-readiness.ts'
import type { SourceConfig } from '../types.ts'
import { handleSourceTest } from './source-test.ts'

const tempDirs: string[] = []
const expectedTools = [
  { name: 'issues_list', apiVersion: 'v1' },
  { name: 'issues_create', apiVersion: 'v1' },
]

afterEach(() => {
  for (const path of tempDirs.splice(0)) rmSync(path, { recursive: true, force: true })
})

interface HarnessOptions {
  observedTools: typeof expectedTools
  activate?: SessionSourceReadiness['activateSource']
  persistSourceConfig?: SessionSourceReadiness['persistSourceConfig']
}

function createHarness(options: HarnessOptions): {
  ctx: SessionToolContext
  configPath: string
  events: string[]
} {
  const workspacePath = mkdtempSync(join(tmpdir(), 'source-readiness-handler-'))
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
    mcp: { transport: 'stdio', command: 'linear-mcp' },
  }))
  writeFileSync(
    join(sourcePath, 'guide.md'),
    '# Linear\n\nThis guide intentionally contains enough words to avoid unrelated completeness warnings while the test verifies the source connection readiness probe and its session-visible tool evidence.',
  )

  const events: string[] = []

  const sessionSourceReadiness: SessionSourceReadiness = {
    backend: 'claude',
    probeSourceTools: async (sourceSlug) => {
      events.push(`inject:${sourceSlug}`)
      events.push('observe:probe-1')
      events.push('cleanup:probe-1')
      return { ok: true, observedTools: options.observedTools }
    },
    activateSource: options.activate ?? (async (sourceSlug, persistReady) => {
      events.push(`activate:${sourceSlug}`)
      persistReady()
      return { ok: true }
    }),
    persistSourceConfig: options.persistSourceConfig
      ?? ((source) => writeFileSync(configPath, JSON.stringify(source))),
  }

  const ctx = {
    sessionId: 'session-1',
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
    validateStdioMcpConnection: async () => ({
      success: true,
      toolCount: expectedTools.length,
      toolNames: expectedTools.map((tool) => tool.name),
    }),
    sessionSourceReadiness,
  } as unknown as SessionToolContext

  return { ctx, configPath, events }
}

describe('source_test Composio readiness wiring', () => {
  test('persists ready and enables exposure only after observing every expected tool in session', async () => {
    const harness = createHarness({ observedTools: expectedTools })

    await handleSourceTest(harness.ctx, { sourceSlug: 'composio-linear' })

    const persisted = JSON.parse(readFileSync(harness.configPath, 'utf8'))
    expect(harness.events).toEqual([
      'inject:composio-linear',
      'observe:probe-1',
      'cleanup:probe-1',
      'activate:composio-linear',
    ])
    expect(persisted.enabled).toBe(true)
    expect(persisted.connectionStatus).toBe('connected')
    expect(persisted.readiness).toMatchObject({
      status: 'ready',
      observedTools: expectedTools,
    })
  })

  test('persists unhealthy, remains disabled, and does not expose when a session tool is missing', async () => {
    const harness = createHarness({ observedTools: [expectedTools[0]!] })

    const result = await handleSourceTest(harness.ctx, { sourceSlug: 'composio-linear' })

    const persisted = JSON.parse(readFileSync(harness.configPath, 'utf8'))
    expect(harness.events).toEqual([
      'inject:composio-linear',
      'observe:probe-1',
      'cleanup:probe-1',
    ])
    expect(persisted.enabled).toBe(false)
    expect(persisted.connectionStatus).toBe('unhealthy')
    expect(persisted.readiness).toMatchObject({
      status: 'unhealthy',
      reason: 'missing-tools',
      observedTools: [expectedTools[0]],
    })
    expect(result.isError).toBe(true)
  })

  test('keeps the staged unhealthy config when final session exposure fails', async () => {
    const harness = createHarness({
      observedTools: expectedTools,
      activate: async (sourceSlug) => {
        harness.events.push(`activate:${sourceSlug}`)
        return { ok: false, reason: 'commit-failed' }
      },
    })

    const result = await handleSourceTest(harness.ctx, { sourceSlug: 'composio-linear' })

    const persisted = JSON.parse(readFileSync(harness.configPath, 'utf8'))
    expect(persisted.enabled).toBe(false)
    expect(persisted.connectionStatus).toBe('unhealthy')
    expect(persisted.readiness).toMatchObject({
      status: 'unhealthy',
      reason: 'backend-injection-failed',
    })
    expect(result.isError).toBe(true)
  })

  test('does not expose when readiness state cannot be persisted', async () => {
    const harness = createHarness({
      observedTools: expectedTools,
      persistSourceConfig: () => {
        throw new Error('disk failed credential-sentinel')
      },
    })

    const result = await handleSourceTest(harness.ctx, { sourceSlug: 'composio-linear' })

    expect(harness.events).toEqual([
      'inject:composio-linear',
      'observe:probe-1',
      'cleanup:probe-1',
    ])
    expect(result.isError).toBe(true)
    expect(JSON.stringify(result)).not.toContain('sentinel')
  })
})
