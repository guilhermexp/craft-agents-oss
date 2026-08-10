/**
 * Registry config-write preservation — regression for PR #348 review item
 * "Block #2: supergroup pairing wipes the owners/accessMode it just seeded".
 *
 * Every Telegram config write must spread existing fields rather than
 * replace the platform object. The bugs in the original PR landed
 * `bindWorkspaceSupergroup`, `unbindWorkspaceSupergroup`, and
 * `saveTelegramToken` writing `{ enabled, supergroup }` /
 * `{ enabled: true }`, which silently dropped owners + accessMode.
 *
 * These tests pin the new helper-driven behaviour: owners + accessMode
 * survive every flow that writes platform config.
 */

import { afterEach, beforeEach, describe, expect, it } from 'bun:test'
import { mkdtempSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import type { CredentialManager } from '@craft-agent/shared/credentials'
import type { ISessionManager } from '@craft-agent/server-core/handlers'
import { MessagingGatewayRegistry } from '../registry'
import { resolveOwnerSeed } from '../access-control'
import type { MessagingConfig, PlatformAdapter, PlatformOwner, PlatformType } from '../types'

let dir: string

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'reg-cfg-'))
})

afterEach(() => {
  rmSync(dir, { recursive: true, force: true })
})

function stubSessionManager(): ISessionManager {
  return { setAutomationBinder: () => {} } as unknown as ISessionManager
}

function stubCredentialManager(): CredentialManager {
  return {
    get: async () => null,
    set: async () => {},
    delete: async () => {},
  } as unknown as CredentialManager
}

function makeRegistry() {
  const registry = new MessagingGatewayRegistry({
    sessionManager: stubSessionManager(),
    credentialManager: stubCredentialManager(),
    getMessagingDir: (workspaceId: string) =>
      join(dir, 'workspaces', workspaceId, 'messaging'),
    whatsapp: { workerEntry: '/dev/null' },
  })
  return { registry, workspaceId: 'ws-test' }
}

function makeFakeTelegramAdapter(): PlatformAdapter {
  return {
    platform: 'telegram',
    capabilities: {} as PlatformAdapter['capabilities'],
    initialize: async () => {},
    destroy: async () => {},
    isConnected: () => true,
    onMessage: () => {},
    onButtonPress: () => {},
    sendText: async () => ({ messageId: '1' }),
    editMessage: async () => {},
    sendButtons: async () => ({ messageId: '1' }),
    sendTyping: async () => {},
    sendFile: async () => ({ messageId: '1' }),
    getChatInfo: async () => ({
      type: 'supergroup' as const,
      isForum: true,
      title: 'Test SG',
    }),
    setAcceptedSupergroupChatId: () => {},
  } as unknown as PlatformAdapter
}

/**
 * `seedFirstOwner` is the private `/pair`-redeem bootstrap hook (wired into the
 * gateway as `seedOwnerOnFirstPair`). A typed cast is the test seam that lets
 * us drive it directly and assert against the public owner/access-mode readers.
 */
function seedFirstOwner(
  registry: MessagingGatewayRegistry,
  workspaceId: string,
  platform: PlatformType,
  candidate: PlatformOwner,
): Promise<PlatformOwner[]> {
  // Test seam: the private hook has no public accessor, so name the cast.
  const internal = registry as unknown as {
    seedFirstOwner: (
      workspaceId: string,
      platform: PlatformType,
      candidate: PlatformOwner,
    ) => Promise<PlatformOwner[]>
  }
  return internal.seedFirstOwner(workspaceId, platform, candidate)
}

describe('MessagingGatewayRegistry — config preservation across writes', () => {
  it('owners survive bindWorkspaceSupergroup', async () => {
    const { registry, workspaceId } = makeRegistry()
    // Set up an owner via the public method.
    registry.setPlatformOwners(workspaceId, 'telegram', [
      { userId: 'first-owner', addedAt: Date.now() },
    ])

    // Inject an adapter and bind a supergroup.
    registry.getGateway(workspaceId).registerAdapter(makeFakeTelegramAdapter())
    await registry.bindWorkspaceSupergroup(workspaceId, 'telegram', '-100123', 'My SG')

    const owners = registry.getPlatformOwners(workspaceId, 'telegram')
    expect(owners).toHaveLength(1)
    expect(owners[0]!.userId).toBe('first-owner')

    const supergroup = registry.getWorkspaceSupergroup(workspaceId)
    expect(supergroup?.chatId).toBe('-100123')
  })

  it('owners survive unbindWorkspaceSupergroup', async () => {
    const { registry, workspaceId } = makeRegistry()
    registry.setPlatformOwners(workspaceId, 'telegram', [
      { userId: 'first-owner', addedAt: Date.now() },
    ])
    registry.getGateway(workspaceId).registerAdapter(makeFakeTelegramAdapter())
    await registry.bindWorkspaceSupergroup(workspaceId, 'telegram', '-100123', 'My SG')

    await registry.unbindWorkspaceSupergroup(workspaceId)

    const owners = registry.getPlatformOwners(workspaceId, 'telegram')
    expect(owners).toHaveLength(1)
    expect(owners[0]!.userId).toBe('first-owner')
    expect(registry.getWorkspaceSupergroup(workspaceId)).toBeNull()
  })

  it('owners + accessMode survive setPlatformAccessMode', () => {
    const { registry, workspaceId } = makeRegistry()
    registry.setPlatformOwners(workspaceId, 'telegram', [
      { userId: 'owner-1', addedAt: Date.now() },
    ])
    registry.setPlatformAccessMode(workspaceId, 'telegram', 'owner-only')
    const owners = registry.getPlatformOwners(workspaceId, 'telegram')
    expect(owners).toHaveLength(1)
    expect(registry.getPlatformAccessMode(workspaceId, 'telegram')).toBe('owner-only')
  })

  it('resolveOwnerSeed is a no-op when owners already exist', () => {
    const config: MessagingConfig = {
      enabled: true,
      platforms: {
        telegram: { enabled: true, owners: [{ userId: 'first', addedAt: Date.now() }] },
      },
    }
    const seed = resolveOwnerSeed(config, 'telegram', { userId: 'second', addedAt: Date.now() })
    expect(seed.changed).toBe(false)
    expect(seed.owners).toHaveLength(1)
    expect(seed.owners[0]!.userId).toBe('first')
  })

  it('seedFirstOwner is a no-op when owners already exist', async () => {
    const { registry, workspaceId } = makeRegistry()
    registry.setPlatformOwners(workspaceId, 'telegram', [
      { userId: 'first', addedAt: Date.now() },
    ])
    const seeded = await seedFirstOwner(registry, workspaceId, 'telegram', {
      userId: 'second',
      addedAt: Date.now(),
    })
    // Returns the existing owner untouched...
    expect(seeded).toHaveLength(1)
    expect(seeded[0]!.userId).toBe('first')
    // ...and nothing was persisted over the existing list.
    const owners = registry.getPlatformOwners(workspaceId, 'telegram')
    expect(owners).toHaveLength(1)
    expect(owners[0]!.userId).toBe('first')
  })

  it('seedFirstOwner bootstraps the first owner and locks the workspace down', async () => {
    const { registry, workspaceId } = makeRegistry()
    const seeded = await seedFirstOwner(registry, workspaceId, 'telegram', {
      userId: 'boot',
      displayName: 'Boot',
      addedAt: Date.now(),
    })
    expect(seeded).toHaveLength(1)
    expect(seeded[0]!.userId).toBe('boot')
    // Persisted via patchPlatform: owners + owner-only access mode both land.
    expect(registry.getPlatformOwners(workspaceId, 'telegram')).toHaveLength(1)
    expect(registry.getPlatformAccessMode(workspaceId, 'telegram')).toBe('owner-only')
  })

  it('seedFirstOwner is a no-op for platforms without access control', async () => {
    const { registry, workspaceId } = makeRegistry()
    const seeded = await seedFirstOwner(registry, workspaceId, 'whatsapp', {
      userId: 'wa-user',
      addedAt: Date.now(),
    })
    expect(seeded).toHaveLength(0)
    expect(registry.getPlatformOwners(workspaceId, 'whatsapp')).toHaveLength(0)
  })
})

describe('MessagingGatewayRegistry — lock-down migrates open bindings', () => {
  it('setPlatformAccessMode("owner-only") flips legacy open bindings to inherit', () => {
    const { registry, workspaceId } = makeRegistry()
    const store = registry.getGateway(workspaceId).getBindingStore()
    // Persist a binding in legacy 'open' mode (mimics migration).
    const b = store.bind('ws-test', 'sess-A', 'telegram', 'chat-1', undefined, {
      accessMode: 'open',
    })
    expect(b.config.accessMode).toBe('open')

    registry.setPlatformAccessMode(workspaceId, 'telegram', 'owner-only')

    const reloaded = store.getAll().find((x: { id: string }) => x.id === b.id)
    expect(reloaded.config.accessMode).toBe('inherit')
    // Binding ID and createdAt must have survived the migration (no rotation).
    expect(reloaded.id).toBe(b.id)
    expect(reloaded.createdAt).toBe(b.createdAt)
  })

  it('non-telegram bindings are not touched by the lock-down', () => {
    const { registry, workspaceId } = makeRegistry()
    const store = registry.getGateway(workspaceId).getBindingStore()
    const wa = store.bind('ws-test', 'sess-A', 'whatsapp', 'chan-A', undefined, {
      accessMode: 'open',
    })

    registry.setPlatformAccessMode(workspaceId, 'telegram', 'owner-only')

    const reloaded = store.getAll().find((x: { id: string }) => x.id === wa.id)
    expect(reloaded.config.accessMode).toBe('open')
  })
})
