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
import type { SourceConfig } from '../types.ts'
import { handleSourceTest } from './source-test.ts'

const tempDirs: string[] = []
const expectedTools = [{ name: 'issues_list', apiVersion: 'v1' }]

afterEach(() => {
  for (const path of tempDirs.splice(0)) rmSync(path, { recursive: true, force: true })
})

function createReadinessHarness(options: {
  failSaveAt?: number
  failPreparation?: boolean
  failCommit?: boolean
} = {}): {
  ctx: SessionToolContext
  configPath: string
  events: string[]
  saveCount(): number
} {
  const workspacePath = mkdtempSync(join(tmpdir(), 'source-readiness-lifecycle-'))
  tempDirs.push(workspacePath)
  const sourcePath = join(workspacePath, 'sources', 'composio-linear')
  mkdirSync(sourcePath, { recursive: true })
  const configPath = join(sourcePath, 'config.json')
  const initial: SourceConfig = {
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
  }
  writeFileSync(configPath, JSON.stringify(initial))
  writeFileSync(
    join(sourcePath, 'guide.md'),
    '# Linear\n\nThis guide intentionally contains enough words to avoid unrelated completeness warnings while the test verifies transactional readiness activation without exposing a source before its final configuration can be persisted safely.',
  )

  const events: string[] = []
  let saves = 0
  const ctx = {
    sessionId: 'session-1',
    workspacePath,
    sourceProbeBackend: 'claude',
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
    saveSourceConfig: (source: SourceConfig) => {
      saves += 1
      if (saves === options.failSaveAt) throw new Error('disk failed credential-sentinel')
      writeFileSync(configPath, JSON.stringify(source))
    },
    validateStdioMcpConnection: async () => ({
      success: true,
      toolCount: expectedTools.length,
      toolNames: expectedTools.map((tool) => tool.name),
    }),
    injectSourceForProbe: async () => ({ probeId: 'observation-probe' }),
    observeSourceToolsForProbe: async () => expectedTools,
    removeSourceProbe: async () => {},
    prepareSourceReadinessActivation: async (sourceSlug: string) => {
      events.push(`prepare:${sourceSlug}`)
      if (options.failPreparation) throw new Error('activation failed provider-token-sentinel')
      return { activationId: 'activation-1' }
    },
    commitSourceReadinessActivation: (activationId: string) => {
      events.push(`commit:${activationId}`)
      if (options.failCommit) throw new Error('commit failed provider-token-sentinel')
    },
    rollbackSourceReadinessActivation: async (activationId: string) => {
      events.push(`rollback:${activationId}`)
    },
    activateSourceInSession: async (sourceSlug: string) => {
      events.push(`legacy-activate:${sourceSlug}`)
      return { ok: false, reason: 'readiness must not use legacy activation' }
    },
  } as unknown as SessionToolContext

  return { ctx, configPath, events, saveCount: () => saves }
}

describe('source_test readiness activation lifecycle', () => {
  test('keeps the staged config unhealthy when final activation fails without relying on a rollback save', async () => {
    const harness = createReadinessHarness({ failPreparation: true, failSaveAt: 2 })

    const result = await handleSourceTest(harness.ctx, { sourceSlug: 'composio-linear' })

    const persisted = JSON.parse(readFileSync(harness.configPath, 'utf8')) as SourceConfig
    expect(harness.events).toEqual(['prepare:composio-linear'])
    expect(harness.saveCount()).toBe(1)
    expect(persisted.enabled).toBe(false)
    expect(persisted.readiness).toMatchObject({
      status: 'unhealthy',
      reason: 'backend-injection-failed',
    })
    expect(result.isError).toBe(true)
    expect(JSON.stringify(result)).not.toContain('sentinel')
  })

  test('rolls back live exposure when persisting final ready state fails', async () => {
    const harness = createReadinessHarness({ failSaveAt: 2 })

    const result = await handleSourceTest(harness.ctx, { sourceSlug: 'composio-linear' })

    const persisted = JSON.parse(readFileSync(harness.configPath, 'utf8')) as SourceConfig
    expect(harness.events).toEqual([
      'prepare:composio-linear',
      'rollback:activation-1',
    ])
    expect(persisted.enabled).toBe(false)
    expect(persisted.readiness?.status).toBe('unhealthy')
    expect(result.isError).toBe(true)
    expect(JSON.stringify(result)).not.toContain('sentinel')
  })

  test('commits exposure only after the final ready config is persisted', async () => {
    const harness = createReadinessHarness()

    const result = await handleSourceTest(harness.ctx, { sourceSlug: 'composio-linear' })

    const persisted = JSON.parse(readFileSync(harness.configPath, 'utf8')) as SourceConfig
    expect(harness.events).toEqual([
      'prepare:composio-linear',
      'commit:activation-1',
    ])
    expect(harness.saveCount()).toBe(2)
    expect(persisted.enabled).toBe(true)
    expect(persisted.readiness?.status).toBe('ready')
    expect(result.isError).toBe(false)
  })

  test('rolls back exposure and ready config when the activation commit throws', async () => {
    const harness = createReadinessHarness({ failCommit: true })

    const result = await handleSourceTest(harness.ctx, { sourceSlug: 'composio-linear' })

    const persisted = JSON.parse(readFileSync(harness.configPath, 'utf8')) as SourceConfig
    expect(harness.events).toEqual([
      'prepare:composio-linear',
      'commit:activation-1',
      'rollback:activation-1',
    ])
    expect(persisted.enabled).toBe(false)
    expect(persisted.readiness?.status).toBe('unhealthy')
    expect(result.isError).toBe(true)
    expect(JSON.stringify(result)).not.toContain('sentinel')
  })
})

describe('source_test legacy save failures', () => {
  test('reports a warning and skips activation when non-readiness metadata cannot be saved', async () => {
    const harness = createReadinessHarness({ failSaveAt: 1 })
    const config = JSON.parse(readFileSync(harness.configPath, 'utf8')) as SourceConfig
    delete config.expectedTools
    delete config.readiness
    writeFileSync(harness.configPath, JSON.stringify(config))

    const result = await handleSourceTest(harness.ctx, { sourceSlug: 'composio-linear' })
    const text = result.content[0]?.text ?? ''

    expect(harness.events).toEqual([])
    expect(text).toContain('Config could not be updated')
    expect(text).toContain('Validation passed with warnings')
    expect(text).not.toContain('Result: ✓ Validation passed')
    expect(result.isError).toBeFalsy()
  })
})
