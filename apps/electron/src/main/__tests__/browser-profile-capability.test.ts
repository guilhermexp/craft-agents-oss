import { describe, expect, it, mock } from 'bun:test'
import type { BrowserProfile } from '@craft-agent/shared/config/types'
import type { BrowserInstance } from '../browser-pane-manager'
import {
  DEFAULT_BROWSER_PROFILE_PARTITION,
  UserOnlyBrowserProfileError,
  getProfilePartition,
  resolveBrowserProfileId,
} from '../browser-profile-resolver'

const fromPartition = mock(() => ({}))

mock.module('electron', () => ({
  app: {
    getName: () => 'Craft Agents',
    isReady: () => false,
    whenReady: async () => {},
  },
  BrowserView: class MockBrowserView {},
  BrowserWindow: class MockBrowserWindow {},
  ipcMain: {
    handle: mock(() => {}),
  },
  nativeTheme: {
    shouldUseDarkColors: false,
  },
  session: {
    defaultSession: {},
    fromPartition,
  },
  shell: {
    openExternal: mock(async () => {}),
  },
  webContents: {
    fromFrame: mock(() => undefined),
    fromId: mock(() => undefined),
    getAllWebContents: mock(() => []),
    getFocusedWebContents: mock(() => undefined),
  },
}))

mock.module('../logger', () => {
  const logger = {
    debug: () => {},
    error: () => {},
    info: () => {},
    warn: () => {},
  }
  return {
    default: logger,
    mainLog: logger,
  }
})

const { BrowserPaneManager } = await import('../browser-pane-manager')

const profiles: BrowserProfile[] = [
  {
    id: 'default',
    name: 'Default',
    color: '#22c55e',
    createdAt: 0,
  },
  {
    id: 'connected',
    name: 'Connected',
    color: '#3b82f6',
    createdAt: 1,
    userOnly: true,
  },
]

describe('browser profile capability', () => {
  it('refuses an agent-owned user-only profile before an instance can be created', () => {
    const manager = new BrowserPaneManager(() => profiles)
    fromPartition.mockClear()

    expect(() => manager.createInstance('agent-connected', {
      ownerType: 'session',
      ownerSessionId: 'session-1',
      profileId: 'connected',
    })).toThrow(UserOnlyBrowserProfileError)

    expect(manager.listInstances()).toHaveLength(0)
    expect(fromPartition).not.toHaveBeenCalled()
  })

  it('keeps the default-profile behavior for an agent request with no profile id', () => {
    expect(resolveBrowserProfileId(profiles, undefined, 'session')).toBe('default')
  })

  it('allows a user-owned request to resolve a user-only profile', () => {
    expect(resolveBrowserProfileId(profiles, 'connected', 'manual')).toBe('connected')
  })

  it('never maps a user-only profile to the legacy default partition', () => {
    const resolved = resolveBrowserProfileId(profiles, 'connected', 'manual')

    expect(getProfilePartition(resolved)).toBe('persist:browser-pane:connected')
    expect(getProfilePartition(resolved)).not.toBe(DEFAULT_BROWSER_PROFILE_PARTITION)
  })

  it('refuses binding an existing user-only manual instance to an agent session', () => {
    const manager = new BrowserPaneManager(() => profiles)
    const instance = {
      id: 'manual-connected',
      profileId: 'connected',
      ownerType: 'manual',
      ownerSessionId: null,
      boundSessionId: null,
    } as unknown as BrowserInstance
    const managerInternals = manager as unknown as {
      instances: Map<string, BrowserInstance>
    }
    managerInternals.instances.set(instance.id, instance)

    expect(() => manager.bindSession(instance.id, 'session-1'))
      .toThrow(UserOnlyBrowserProfileError)
    expect(instance.ownerType).toBe('manual')
    expect(instance.boundSessionId).toBeNull()
  })
})
