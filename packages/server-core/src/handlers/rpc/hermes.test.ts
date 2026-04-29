import { afterEach, beforeEach, describe, expect, it } from 'bun:test'
import { promisify } from 'node:util'
import { execFile as execFileCb } from 'node:child_process'
import { mkdtemp, mkdir, symlink, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'

import { RPC_CHANNELS } from '@craft-agent/shared/protocol'
import type { RpcServer, HandlerFn, RequestContext } from '@craft-agent/server-core/transport'
import type { HandlerDeps } from '../handler-deps'
import { registerHermesHandlers } from './hermes'

const originalEnv = { ...process.env }
const execFile = promisify(execFileCb)

function createHarness(overrides?: Partial<HandlerDeps['platform']>) {
  const handlers = new Map<string, HandlerFn>()
  const openedPaths: string[] = []

  const server: RpcServer = {
    handle(channel, handler) {
      handlers.set(channel, handler)
    },
    push() {},
    async invokeClient() {
      return undefined
    },
  }

  const deps: HandlerDeps = {
    sessionManager: {} as HandlerDeps['sessionManager'],
    oauthFlowStore: {} as HandlerDeps['oauthFlowStore'],
    platform: {
      appRootPath: process.cwd(),
      resourcesPath: process.cwd(),
      isPackaged: false,
      appVersion: '0.0.0-test',
      isDebugMode: true,
      logger: {
        info: () => {},
        warn: () => {},
        error: () => {},
        debug: () => {},
      },
      imageProcessor: {
        getMetadata: async () => null,
        process: async () => Buffer.from(''),
      },
      openPath: async (path: string) => {
        openedPaths.push(path)
      },
      ...overrides,
    },
  }

  registerHermesHandlers(server, deps)

  const ctx: RequestContext = {
    clientId: 'client-1',
    workspaceId: 'ws-1',
    webContentsId: 1,
  }

  return { handlers, ctx, openedPaths }
}

beforeEach(() => {
  process.env = { ...originalEnv }
})

afterEach(() => {
  process.env = { ...originalEnv }
})

describe('registerHermesHandlers local file controls', () => {
  it('lists Hermes home files without exposing secrets or expanding operational directories', async () => {
    const home = await mkdtemp(join(tmpdir(), 'craft-hermes-test-'))
    process.env.CRAFT_HERMES_HOME = home
    await writeFile(join(home, '.env'), 'SECRET=do-not-leak')
    await writeFile(join(home, 'auth.json'), '{"token":"do-not-leak"}')
    await writeFile(join(home, 'auth.lock'), '')
    await writeFile(join(home, '.DS_Store'), '')
    await writeFile(join(home, 'config.yaml'), 'models: {}')
    await mkdir(join(home, 'skills'))
    await mkdir(join(home, 'sessions'))
    await mkdir(join(home, 'logs'))
    await writeFile(join(home, 'sessions', 'session_abc.json'), '{}')
    await writeFile(join(home, 'sessions', 'request_dump_abc_1.json'), '{}')
    await writeFile(join(home, 'logs', 'hermes.log'), 'log')

    const { handlers, ctx } = createHarness()
    const listHomeFiles = handlers.get(RPC_CHANNELS.hermes.LIST_HOME_FILES)
    expect(listHomeFiles).toBeDefined()

    const result = await listHomeFiles!(ctx)
    const names = result.files.map((file: { name: string }) => file.name)
    const sessions = result.files.find((file: { name: string }) => file.name === 'sessions')
    const logs = result.files.find((file: { name: string }) => file.name === 'logs')

    expect(result.success).toBe(true)
    expect(names).toContain('config.yaml')
    expect(names).toContain('sessions')
    expect(names).toContain('logs')
    expect(names).not.toContain('.env')
    expect(names).not.toContain('auth.json')
    expect(names).not.toContain('auth.lock')
    expect(names).not.toContain('.DS_Store')
    expect(sessions?.children ?? []).toHaveLength(0)
    expect(logs?.children ?? []).toHaveLength(0)
  })

  it('blocks Hermes path opening outside HERMES_HOME', async () => {
    const home = await mkdtemp(join(tmpdir(), 'craft-hermes-test-'))
    process.env.CRAFT_HERMES_HOME = home

    const { handlers, ctx, openedPaths } = createHarness()
    const openPath = handlers.get(RPC_CHANNELS.hermes.OPEN_PATH)
    expect(openPath).toBeDefined()

    const result = await openPath!(ctx, '../outside')

    expect(result.success).toBe(false)
    expect(result.error).toContain('Path escapes Hermes home')
    expect(openedPaths).toHaveLength(0)
  })

  it('blocks Hermes symlinks that resolve outside HERMES_HOME', async () => {
    const home = await mkdtemp(join(tmpdir(), 'craft-hermes-test-'))
    const outside = await mkdtemp(join(tmpdir(), 'craft-hermes-outside-'))
    process.env.CRAFT_HERMES_HOME = home
    await symlink(outside, join(home, 'outside-link'))

    const { handlers, ctx, openedPaths } = createHarness()
    const openPath = handlers.get(RPC_CHANNELS.hermes.OPEN_PATH)
    expect(openPath).toBeDefined()

    const result = await openPath!(ctx, 'outside-link')

    expect(result.success).toBe(false)
    expect(result.error).toContain('Path escapes Hermes home')
    expect(openedPaths).toHaveLength(0)
  })

  it('does not mutate bundled Hermes runtime in packaged apps', async () => {
    const home = await mkdtemp(join(tmpdir(), 'craft-hermes-test-'))
    process.env.CRAFT_HERMES_HOME = home

    const { handlers, ctx } = createHarness({ isPackaged: true })
    const updateRuntime = handlers.get(RPC_CHANNELS.hermes.UPDATE_RUNTIME)
    expect(updateRuntime).toBeDefined()

    const result = await updateRuntime!(ctx)

    expect(result.success).toBe(false)
    expect(result.status).toBe('unsupported')
  })

  it('returns Hermes fork/upstream release metadata for the settings page', async () => {
    const home = await mkdtemp(join(tmpdir(), 'craft-hermes-home-'))
    const repo = await mkdtemp(join(tmpdir(), 'craft-hermes-repo-'))
    process.env.CRAFT_HERMES_HOME = home
    process.env.CRAFT_HERMES_COMMAND = process.execPath
    process.env.HERMES_SRC = repo

    await writeFile(join(repo, 'pyproject.toml'), '[project]\nname = "hermes-agent"\nversion = "0.11.0"\n')
    await execFile('git', ['-C', repo, 'init'])
    await execFile('git', ['-C', repo, 'config', 'user.email', 'test@example.com'])
    await execFile('git', ['-C', repo, 'config', 'user.name', 'Test User'])
    await execFile('git', ['-C', repo, 'add', 'pyproject.toml'])
    await execFile('git', ['-C', repo, 'commit', '-m', 'test hermes release'], {
      env: {
        ...process.env,
        GIT_AUTHOR_DATE: '2026-04-23T12:00:00Z',
        GIT_COMMITTER_DATE: '2026-04-23T12:00:00Z',
      },
    })
    await execFile('git', ['-C', repo, 'tag', 'v2026.4.23'])
    await execFile('git', ['-C', repo, 'remote', 'add', 'origin', 'https://github.com/guilhermexp/hermes-agent.git'])
    await execFile('git', ['-C', repo, 'remote', 'add', 'upstream', 'https://github.com/NousResearch/hermes-agent.git'])

    const { handlers, ctx } = createHarness()
    const getRuntimeDetails = handlers.get(RPC_CHANNELS.hermes.GET_RUNTIME_DETAILS)
    expect(getRuntimeDetails).toBeDefined()

    const result = await getRuntimeDetails!(ctx)

    expect(result.sourceRepoRemote).toBe('https://github.com/guilhermexp/hermes-agent.git')
    expect(result.sourceRepoUpstreamRemote).toBe('https://github.com/NousResearch/hermes-agent.git')
    expect(result.sourceRepoReleaseTag).toBe('v2026.4.23')
    expect(result.sourceRepoCommitDate).toBe('2026-04-23')
    expect(result.sourceRepoCommit).toMatch(/^[0-9a-f]{7}$/)
    expect(result.sourceRepoDirty).toBe(false)
  })
})
