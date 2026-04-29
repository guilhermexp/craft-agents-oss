import { afterEach, beforeEach, describe, expect, it } from 'bun:test'
import { mkdtemp, mkdir, symlink, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'

import { RPC_CHANNELS } from '@craft-agent/shared/protocol'
import type { RpcServer, HandlerFn, RequestContext } from '@craft-agent/server-core/transport'
import type { HandlerDeps } from '../handler-deps'
import { registerHermesHandlers } from './hermes'

const originalEnv = { ...process.env }

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
  it('lists Hermes home files without exposing .env', async () => {
    const home = await mkdtemp(join(tmpdir(), 'craft-hermes-test-'))
    process.env.CRAFT_HERMES_HOME = home
    await writeFile(join(home, '.env'), 'SECRET=do-not-leak')
    await writeFile(join(home, 'config.yaml'), 'models: {}')
    await mkdir(join(home, 'skills'))

    const { handlers, ctx } = createHarness()
    const listHomeFiles = handlers.get(RPC_CHANNELS.hermes.LIST_HOME_FILES)
    expect(listHomeFiles).toBeDefined()

    const result = await listHomeFiles!(ctx)

    expect(result.success).toBe(true)
    expect(result.files.map((file: { name: string }) => file.name)).toContain('config.yaml')
    expect(result.files.map((file: { name: string }) => file.name)).not.toContain('.env')
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
})
