import { afterEach, beforeEach, describe, expect, it } from 'bun:test'
import { promisify } from 'node:util'
import { execFile as execFileCb } from 'node:child_process'
import { chmod, mkdtemp, mkdir, symlink, writeFile } from 'node:fs/promises'
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
  it('authenticates internal dashboard API calls with the injected Hermes session token', async () => {
    const home = await mkdtemp(join(tmpdir(), 'craft-hermes-home-'))
    const binDir = await mkdtemp(join(tmpdir(), 'craft-hermes-bin-'))
    const fakeHermes = join(binDir, 'fake-hermes-dashboard.js')
    process.env.CRAFT_HERMES_HOME = home
    process.env.CRAFT_HERMES_COMMAND = fakeHermes

    await writeFile(fakeHermes, `#!/usr/bin/env node
const http = require('node:http')
const token = 'test-token'
const port = Number(process.argv[process.argv.indexOf('--port') + 1])
const server = http.createServer((req, res) => {
  if (req.url === '/') {
    res.setHeader('content-type', 'text/html')
    res.end('<script>window.__HERMES_SESSION_TOKEN__="test-token";</script>')
    return
  }
  if (!req.headers['x-hermes-session-token'] || req.headers['x-hermes-session-token'] !== token) {
    res.statusCode = 401
    res.setHeader('content-type', 'application/json')
    res.end(JSON.stringify({ detail: 'Unauthorized' }))
    return
  }
  if (req.url === '/api/config') {
    res.setHeader('content-type', 'application/json')
    res.end(JSON.stringify({ model: 'gpt-5.5' }))
    return
  }
  if (req.url === '/api/model/info') {
    res.setHeader('content-type', 'application/json')
    res.end(JSON.stringify({ provider: 'openai-codex', model: 'gpt-5.5' }))
    return
  }
  if (req.url === '/api/model/options') {
    res.setHeader('content-type', 'application/json')
    res.end(JSON.stringify({ providers: [{ slug: 'openai-codex', models: ['gpt-5.5'] }] }))
    return
  }
  if (req.url === '/api/profiles') {
    res.setHeader('content-type', 'application/json')
    res.end(JSON.stringify({ profiles: [{ name: 'default', path: '${home}', is_default: true, model: 'gpt-5.5', provider: 'openai-codex', has_env: true, skill_count: 9 }] }))
    setTimeout(() => server.close(() => process.exit(0)), 100)
    return
  }
  res.statusCode = 404
  res.end('not found')
})
server.listen(port, '127.0.0.1')
`)
    await chmod(fakeHermes, 0o755)

    const { handlers, ctx } = createHarness()
    const getApiConfig = handlers.get(RPC_CHANNELS.hermes.GET_API_CONFIG)
    const getProviderModels = handlers.get(RPC_CHANNELS.hermes.GET_PROVIDER_MODELS)
    const listProfiles = handlers.get(RPC_CHANNELS.hermes.LIST_PROFILES)
    expect(getApiConfig).toBeDefined()
    expect(getProviderModels).toBeDefined()
    expect(listProfiles).toBeDefined()

    const configResult = await getApiConfig!(ctx)
    const modelsResult = await getProviderModels!(ctx, 'openai-codex')
    const profilesResult = await listProfiles!(ctx)

    expect(configResult.success).toBe(true)
    expect(configResult.data.activeProvider).toBe('openai-codex')
    expect(modelsResult.success).toBe(true)
    expect(modelsResult.data.models).toEqual([{ id: 'gpt-5.5' }])
    expect(profilesResult.success).toBe(true)
    expect(profilesResult.profiles).toEqual([{
      name: 'default',
      path: home,
      isDefault: true,
      model: 'gpt-5.5',
      provider: 'openai-codex',
      hasEnv: true,
      skillCount: 9,
    }])
  })

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

  it('reports the pinned Hermes cache instead of auto-binding to a sibling fork', async () => {
    const home = await mkdtemp(join(tmpdir(), 'craft-hermes-home-'))
    const root = await mkdtemp(join(tmpdir(), 'craft-electron-root-'))
    const appRoot = join(root, 'app')
    const cacheRepo = join(appRoot, 'scripts', '.hermes-cache', 'source')
    const siblingFork = join(root, 'hermes-agent')
    process.env.CRAFT_HERMES_HOME = home
    process.env.CRAFT_HERMES_COMMAND = process.execPath
    delete process.env.HERMES_SRC
    delete process.env.HERMES_SOURCE_DIR

    await mkdir(cacheRepo, { recursive: true })
    await writeFile(join(appRoot, 'scripts', 'hermes-version.txt'), '# comment\nupstream/main\n')
    await mkdir(siblingFork, { recursive: true })
    for (const [repo, remote] of [
      [cacheRepo, 'https://github.com/NousResearch/hermes-agent.git'],
      [siblingFork, 'https://github.com/guilhermexp/hermes-agent.git'],
    ] as const) {
      await writeFile(join(repo, 'pyproject.toml'), '[project]\nname = "hermes-agent"\nversion = "0.11.0"\n')
      await execFile('git', ['-C', repo, 'init'])
      await execFile('git', ['-C', repo, 'config', 'user.email', 'test@example.com'])
      await execFile('git', ['-C', repo, 'config', 'user.name', 'Test User'])
      await execFile('git', ['-C', repo, 'add', 'pyproject.toml'])
      await execFile('git', ['-C', repo, 'commit', '-m', 'test hermes source'])
      await execFile('git', ['-C', repo, 'remote', 'add', 'origin', remote])
    }

    const { handlers, ctx } = createHarness({ appRootPath: appRoot })
    const getRuntimeDetails = handlers.get(RPC_CHANNELS.hermes.GET_RUNTIME_DETAILS)
    expect(getRuntimeDetails).toBeDefined()

    const result = await getRuntimeDetails!(ctx)

    expect(result.sourceRepoPath).toBe(cacheRepo)
    expect(result.sourceRepoRemote).toBe('https://github.com/NousResearch/hermes-agent.git')
    expect(result.hermesPin).toBe('upstream/main')
    expect(result.hermesPinPath).toBe(join(appRoot, 'scripts', 'hermes-version.txt'))
  })
})
