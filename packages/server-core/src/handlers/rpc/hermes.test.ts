import { afterEach, beforeEach, describe, expect, it, spyOn } from 'bun:test'
import http from 'node:http'
import { promisify } from 'node:util'
import { execFile as execFileCb } from 'node:child_process'
import { chmod, mkdtemp, mkdir, symlink, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'

import type { HandlerDeps } from '../handler-deps'
import { HermesRuntimeManager } from '../../hermes/hermes-runtime-manager'
import { registerHermesHandlers } from './hermes'
import { RPC_NAMESPACES } from '@craft-agent/shared/protocol'
import type { HandlerFn, RequestContext, RpcServer } from '@craft-agent/server-core/transport'

const originalEnv = { ...process.env }
const execFile = promisify(execFileCb)

function createDeps(overrides?: Partial<HandlerDeps['platform']>) {
  const openedPaths: string[] = []
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
  return { deps, openedPaths }
}

beforeEach(() => {
  process.env = { ...originalEnv }
})

afterEach(() => {
  process.env = { ...originalEnv }
})

describe('HermesRuntimeManager dashboard lifecycle', () => {
  it('authenticates internal dashboard API calls with the extracted Hermes session token', async () => {
    const home = await mkdtemp(join(tmpdir(), 'craft-hermes-home-'))
    const binDir = await mkdtemp(join(tmpdir(), 'craft-hermes-bin-'))
    const fakeHermes = join(binDir, 'fake-hermes-dashboard.js')
    process.env.CRAFT_HERMES_HOME = home
    process.env.CRAFT_HERMES_COMMAND = fakeHermes
    delete process.env.CRAFT_HERMES_PYTHON
    delete process.env.CRAFT_HERMES_ARGS
    delete process.env.CRAFT_HERMES_BUNDLED_REQUIRED

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
    return
  }
  res.statusCode = 404
  res.end('not found')
})
server.listen(port, '127.0.0.1')
`)
    await chmod(fakeHermes, 0o755)

    const { deps } = createDeps()
    const manager = new HermesRuntimeManager(deps)
    try {
      const configResult = await manager.getApiConfig()
      const modelsResult = await manager.getProviderModels('openai-codex')
      const profilesResult = await manager.listProfiles()

      if (!configResult.success) throw new Error(configResult.error)
      if (!modelsResult.success) throw new Error(modelsResult.error)

      expect(configResult.data.activeProvider).toBe('openai-codex')
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
        isActive: true,
      }])
    } finally {
      await manager.shutdownDashboard(100)
    }
  })
})

describe('HermesRuntimeManager provider/model config', () => {
  it('resolves activeProvider through the config/options fallback chain', async () => {
    const { deps } = createDeps()

    const viaConfig = new HermesRuntimeManager(deps, {
      fetchDashboardJson: async (path) => {
        if (path === '/api/model/info') return {}
        if (path === '/api/config') return { active_provider: 'from-config', model: 'from-config-model' }
        if (path === '/api/model/options') return { providers: [{ slug: 'first-option' }] }
        throw new Error(`unexpected dashboard path: ${path}`)
      },
    })
    const viaConfigResult = await viaConfig.getApiConfig()
    if (!viaConfigResult.success) throw new Error(viaConfigResult.error)
    // config.active_provider wins over the modelOptions fallback.
    expect(viaConfigResult.data.activeProvider).toBe('from-config')
    expect(viaConfigResult.data.activeModel).toBe('from-config-model')

    const viaOptions = new HermesRuntimeManager(deps, {
      fetchDashboardJson: async (path) => {
        if (path === '/api/model/info') return {}
        if (path === '/api/config') return {}
        if (path === '/api/model/options') return { providers: [{ slug: 'only-option' }] }
        throw new Error(`unexpected dashboard path: ${path}`)
      },
    })
    const viaOptionsResult = await viaOptions.getApiConfig()
    if (!viaOptionsResult.success) throw new Error(viaOptionsResult.error)
    // Deepest fallback: first provider slug from /api/model/options.
    expect(viaOptionsResult.data.activeProvider).toBe('only-option')
    expect(viaOptionsResult.data.activeModel).toBeUndefined()
    expect(viaOptionsResult.data.providers).toEqual([{ id: 'only-option', configured: true }])
  })

  it('falls back to app-scoped custom provider config when Hermes returns no models', async () => {
    const modelServer = http.createServer((req, res) => {
      if (req.url === '/v1/models') {
        expect(req.headers.authorization).toBe('Bearer custom-provider-secret')
        res.setHeader('content-type', 'application/json')
        res.end(JSON.stringify({ data: [{ id: 'claude-sonnet-4-6' }, { id: 'gemini-2.5-pro' }] }))
        return
      }
      res.statusCode = 404
      res.end('not found')
    })
    await new Promise<void>((resolve) => modelServer.listen(0, '127.0.0.1', resolve))
    const modelAddress = modelServer.address()
    if (!modelAddress || typeof modelAddress === 'string') throw new Error('model server did not bind')

    const home = await mkdtemp(join(tmpdir(), 'craft-hermes-home-'))
    process.env.CRAFT_HERMES_HOME = home
    await writeFile(join(home, 'config.yaml'), [
      'providers:',
      '  custom-openai:',
      `    base_url: http://127.0.0.1:${modelAddress.port}/v1`,
      '    key_env: CUSTOM_OPENAI_API_KEY',
      '    models:',
      '      configured-fallback: {}',
    ].join('\n'))
    await writeFile(join(home, '.env'), 'CUSTOM_OPENAI_API_KEY=custom-provider-secret\n')

    try {
      const { deps } = createDeps()
      const manager = new HermesRuntimeManager(deps, {
        fetchDashboardJson: async (path) => {
          if (path === '/api/model/options') return { providers: [{ slug: 'custom-openai', models: [] }] }
          throw new Error(`unexpected dashboard path: ${path}`)
        },
      })

      const result = await manager.getProviderModels('custom-openai')

      if (!result.success) throw new Error(result.error)
      expect(result.data.models).toEqual([{ id: 'claude-sonnet-4-6' }, { id: 'gemini-2.5-pro' }])
    } finally {
      await new Promise<void>((resolve) => modelServer.close(() => resolve()))
    }
  })

  it('preserves custom provider base URL when saving the main Hermes model', async () => {
    const { deps } = createDeps()
    let capturedPut: { yaml_text: string } | null = null

    const manager = new HermesRuntimeManager(deps, {
      fetchDashboardJson: async (path, init) => {
        if (path === '/api/model/set') return { ok: true }
        if (path === '/api/config/raw') {
          if (init?.method === 'PUT') {
            capturedPut = JSON.parse(String(init.body)) as { yaml_text: string }
            return { ok: true }
          }
          return { yaml: 'model:\n  provider: custom\n  default: old-model\n  api_mode: chat_completions\n' }
        }
        throw new Error(`unexpected dashboard path: ${path} ${init?.method ?? 'GET'}`)
      },
    })

    const result = await manager.patchApiConfig({
      config: {
        provider: 'custom-openai',
        model: 'claude-sonnet-4-6',
        base_url: 'https://custom-provider.example/v1',
      },
    })

    expect(result.success).toBe(true)
    expect(capturedPut).not.toBeNull()
    const captured = capturedPut as unknown as { yaml_text: string }
    expect(captured.yaml_text).toContain('provider: custom-openai')
    expect(captured.yaml_text).toContain('default: claude-sonnet-4-6')
    expect(captured.yaml_text).toContain('api_mode: chat_completions')
    expect(captured.yaml_text).toContain('base_url: https://custom-provider.example/v1')
  })
})

describe('HermesRuntimeManager env merge', () => {
  it('merges dashboard env with disk gateway keys, redacting secrets and sorting', async () => {
    const home = await mkdtemp(join(tmpdir(), 'craft-hermes-home-'))
    process.env.CRAFT_HERMES_HOME = home
    await writeFile(join(home, '.env'), [
      'SLACK_BOT_TOKEN=disk-should-be-ignored',
      'TELEGRAM_BOT_TOKEN=secret-telegram-token-value',
      'NOT_A_GATEWAY_KEY=ignored',
    ].join('\n'))

    const { deps } = createDeps()
    const manager = new HermesRuntimeManager(deps, {
      fetchDashboardJson: async (path) => {
        if (path === '/api/env') return {
          SLACK_BOT_TOKEN: { is_set: true, redacted_value: 'xoxb-****', category: 'messaging', is_password: true },
        }
        throw new Error(`unexpected dashboard path: ${path}`)
      },
    })

    const result = await manager.listEnv()

    if (!result.success) throw new Error(result.error)
    const vars = result.vars ?? []
    // Dashboard key first, then the disk-only gateway key; sorted; non-gateway
    // disk key dropped; dashboard key not overridden by disk.
    expect(vars.map(v => v.key)).toEqual(['SLACK_BOT_TOKEN', 'TELEGRAM_BOT_TOKEN'])

    const slack = vars.find(v => v.key === 'SLACK_BOT_TOKEN')
    expect(slack?.redactedValue).toBe('xoxb-****')

    const telegram = vars.find(v => v.key === 'TELEGRAM_BOT_TOKEN')
    expect(telegram?.isSet).toBe(true)
    expect(telegram?.isPassword).toBe(true)
    expect(telegram?.category).toBe('messaging')
    expect(telegram?.redactedValue).toBe('secr...alue')
  })
})

describe('HermesRuntimeManager path-safe browsing', () => {
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

    const { deps } = createDeps()
    const manager = new HermesRuntimeManager(deps)

    const result = await manager.listHomeFiles()
    const names = result.files.map(file => file.name)
    const sessions = result.files.find(file => file.name === 'sessions')
    const logs = result.files.find(file => file.name === 'logs')

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

    const { deps, openedPaths } = createDeps()
    const manager = new HermesRuntimeManager(deps)

    const result = await manager.openPath('../outside')

    expect(result.success).toBe(false)
    expect(result.error).toContain('Path escapes Hermes home')
    expect(openedPaths).toHaveLength(0)
  })

  it('blocks Hermes symlinks that resolve outside HERMES_HOME', async () => {
    const home = await mkdtemp(join(tmpdir(), 'craft-hermes-test-'))
    const outside = await mkdtemp(join(tmpdir(), 'craft-hermes-outside-'))
    process.env.CRAFT_HERMES_HOME = home
    await symlink(outside, join(home, 'outside-link'))

    const { deps, openedPaths } = createDeps()
    const manager = new HermesRuntimeManager(deps)

    const result = await manager.openPath('outside-link')

    expect(result.success).toBe(false)
    expect(result.error).toContain('Path escapes Hermes home')
    expect(openedPaths).toHaveLength(0)
  })
})

describe('HermesRuntimeManager dev update', () => {
  it('does not mutate bundled Hermes runtime in packaged apps', async () => {
    const home = await mkdtemp(join(tmpdir(), 'craft-hermes-test-'))
    process.env.CRAFT_HERMES_HOME = home

    const { deps } = createDeps({ isPackaged: true })
    const manager = new HermesRuntimeManager(deps)

    const result = await manager.updateRuntime()

    expect(result.success).toBe(false)
    expect(result.status).toBe('unsupported')
  })
})

describe('HermesRuntimeManager runtime details', () => {
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

    const { deps } = createDeps()
    const manager = new HermesRuntimeManager(deps)

    const result = await manager.getRuntimeDetails()

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

    const { deps } = createDeps({ appRootPath: appRoot })
    const manager = new HermesRuntimeManager(deps)

    const result = await manager.getRuntimeDetails()

    expect(result.sourceRepoPath).toBe(cacheRepo)
    expect(result.sourceRepoRemote).toBe('https://github.com/NousResearch/hermes-agent.git')
    expect(result.hermesPin).toBe('upstream/main')
    expect(result.hermesPinPath).toBe(join(appRoot, 'scripts', 'hermes-version.txt'))
  })
})

describe('registerHermesHandlers protocol adapter', () => {
  function createServerHarness() {
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
    return { server, handlers }
  }

  it('registers every hermes channel and delegates to the manager with argument order preserved', () => {
    const { server, handlers } = createServerHarness()
    const { deps } = createDeps()

    // Keep the real fs-backed auth.json watcher from starting during the test.
    const watchSpy = spyOn(HermesRuntimeManager.prototype, 'startAuthJsonWatcher').mockImplementation(() => {})
    // Record the wire→method delegation for a representative multi-arg,
    // body-destructured, and single-arg handler.
    const renameSpy = spyOn(HermesRuntimeManager.prototype, 'renameProfile').mockReturnValue(undefined as never)
    const setEnvSpy = spyOn(HermesRuntimeManager.prototype, 'setEnv').mockReturnValue(undefined as never)
    const readLogSpy = spyOn(HermesRuntimeManager.prototype, 'readLog').mockReturnValue(undefined as never)

    try {
      registerHermesHandlers(server, deps)

      const h = RPC_NAMESPACES.hermes
      const expectedChannels = Object.values(h)
      // (a) the full channel surface is wired — a forgotten server.handle fails here.
      expect(expectedChannels).toHaveLength(24)
      for (const channel of expectedChannels) {
        expect(handlers.has(channel)).toBe(true)
      }
      expect(handlers.size).toBe(expectedChannels.length)

      const ctx = {} as RequestContext
      // (b) delegation forwards arguments in the right order — a swapped
      // (name, newName) or an inverted body.key/body.value fails here.
      handlers.get(h.RENAME_PROFILE)!(ctx, 'old-profile', 'new-profile')
      expect(renameSpy).toHaveBeenCalledWith('old-profile', 'new-profile')

      handlers.get(h.SET_ENV)!(ctx, { key: 'HERMES_KEY', value: 'secret-value' })
      expect(setEnvSpy).toHaveBeenCalledWith('HERMES_KEY', 'secret-value')

      handlers.get(h.READ_LOG)!(ctx, 'app.log')
      expect(readLogSpy).toHaveBeenCalledWith('app.log')
    } finally {
      watchSpy.mockRestore()
      renameSpy.mockRestore()
      setEnvSpy.mockRestore()
      readLogSpy.mockRestore()
    }
  })
})
