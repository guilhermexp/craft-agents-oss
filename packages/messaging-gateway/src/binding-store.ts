/**
 * BindingStore — workspace-scoped persistence for channel bindings.
 *
 * Stores bindings in an explicit storage directory (passed by the caller).
 * In Electron this is `~/.craft-agent/workspaces/{wsId}/messaging/`, but tests
 * can point it at any directory.
 *
 * One-shot migration: if a legacy path is provided and contains a bindings.json
 * that the new path does not, the legacy file is copied forward on construction.
 */

import {
  readFileSync,
  writeFileSync,
  mkdirSync,
  existsSync,
  copyFileSync,
} from 'node:fs'
import { join } from 'node:path'
import { randomUUID } from 'node:crypto'
import type { ExternalMessagingChannelBinding, MessagingLogger, PlatformType } from './types'
import { messagingChannelId, normalizeBindingConfig } from './types'

const NOOP_LOGGER: MessagingLogger = {
  info: () => {},
  warn: () => {},
  error: () => {},
  child: () => NOOP_LOGGER,
}

export class BindingStore {
  private bindings: ExternalMessagingChannelBinding[] = []
  private readonly filePath: string
  private readonly dirPath: string
  private readonly log: MessagingLogger
  private changeListener?: () => void

  /**
   * @param storageDir  Absolute path to the directory where bindings.json is stored.
   * @param legacyDir   Optional legacy directory. If its bindings.json exists and
   *                    the new location does not, the file is copied forward once.
   */
  constructor(storageDir: string, legacyDir?: string, logger: MessagingLogger = NOOP_LOGGER) {
    this.dirPath = storageDir
    this.filePath = join(storageDir, 'bindings.json')
    this.log = logger
    this.migrateLegacy(legacyDir)
    this.load()
  }

  /** Register a callback fired after any mutation is persisted. */
  onChange(fn: () => void): void {
    this.changeListener = fn
  }

  // -------------------------------------------------------------------------
  // Query
  // -------------------------------------------------------------------------

  findByMessagingChannel(platform: PlatformType, channelId: string): ExternalMessagingChannelBinding | undefined {
    const targetChannelId = messagingChannelId(channelId)
    return this.bindings.find(
      (b) => b.platform === platform && b.messagingChannelId === targetChannelId && b.enabled,
    )
  }

  findBySession(sessionId: string): ExternalMessagingChannelBinding[] {
    return this.bindings.filter((b) => b.sessionId === sessionId && b.enabled)
  }

  getAll(): ExternalMessagingChannelBinding[] {
    return [...this.bindings]
  }

  // -------------------------------------------------------------------------
  // Mutation
  // -------------------------------------------------------------------------

  bind(
    workspaceId: string,
    sessionId: string,
    platform: PlatformType,
    channelId: string,
    channelName?: string,
    config?: Partial<ExternalMessagingChannelBinding['config']>,
  ): ExternalMessagingChannelBinding {
    // One channel → one session: evict any existing binding for the channel.
    this.bindings = this.bindings.filter(
      (b) => !(b.platform === platform && b.messagingChannelId === channelId),
    )

    const binding: ExternalMessagingChannelBinding = {
      id: randomUUID(),
      workspaceId,
      sessionId,
      platform,
      messagingChannelId: messagingChannelId(channelId),
      channelName,
      enabled: true,
      createdAt: Date.now(),
      config: normalizeBindingConfig(platform, config),
    }

    this.bindings.push(binding)
    this.save()
    this.log.info('binding created', {
      event: 'binding_created',
      workspaceId,
      sessionId,
      platform,
      messagingChannelId: messagingChannelId(channelId),
      bindingId: binding.id,
      channelName,
    })
    return binding
  }

  unbind(platform: PlatformType, channelId: string): boolean {
    const before = this.bindings.length
    this.bindings = this.bindings.filter(
      (b) => !(b.platform === platform && b.messagingChannelId === channelId),
    )
    if (this.bindings.length !== before) {
      this.save()
      this.log.info('binding removed by channel', {
        event: 'binding_removed',
        platform,
        messagingChannelId: messagingChannelId(channelId),
      })
      return true
    }
    return false
  }

  unbindById(bindingId: string): boolean {
    const binding = this.bindings.find((b) => b.id === bindingId)
    if (!binding) return false
    this.bindings = this.bindings.filter((b) => b.id !== bindingId)
    this.save()
    this.log.info('binding removed by id', {
      event: 'binding_removed',
      bindingId,
      workspaceId: binding.workspaceId,
      sessionId: binding.sessionId,
      platform: binding.platform,
      messagingChannelId: binding.messagingChannelId,
    })
    return true
  }

  unbindSession(sessionId: string, platform?: PlatformType): number {
    const removedBindings = this.bindings.filter((b) => {
      if (b.sessionId !== sessionId) return false
      if (platform && b.platform !== platform) return false
      return true
    })
    if (removedBindings.length === 0) return 0

    this.bindings = this.bindings.filter((b) => !removedBindings.includes(b))
    this.save()
    this.log.info('bindings removed by session', {
      event: 'binding_removed',
      sessionId,
      platform,
      removedCount: removedBindings.length,
      bindingIds: removedBindings.map((b) => b.id),
    })
    return removedBindings.length
  }

  // -------------------------------------------------------------------------
  // Persistence
  // -------------------------------------------------------------------------

  private migrateLegacy(legacyDir?: string): void {
    if (!legacyDir) return
    const legacyFile = join(legacyDir, 'bindings.json')
    if (existsSync(this.filePath)) return
    if (!existsSync(legacyFile)) return
    try {
      if (!existsSync(this.dirPath)) {
        mkdirSync(this.dirPath, { recursive: true })
      }
      copyFileSync(legacyFile, this.filePath)
      this.log.info('bindings migrated from legacy location', {
        event: 'bindings_migrated',
        legacyFile,
        filePath: this.filePath,
      })
    } catch (err) {
      this.log.error('binding migration failed', {
        event: 'bindings_migration_failed',
        legacyFile,
        filePath: this.filePath,
        error: err,
      })
    }
  }

  private load(): void {
    try {
      if (existsSync(this.filePath)) {
        const raw = readFileSync(this.filePath, 'utf-8')
        const parsed = JSON.parse(raw)
        if (Array.isArray(parsed)) {
          this.bindings = parsed.map(normalizeBinding)
        }
      }
    } catch (err) {
      this.log.error('failed to load bindings store; resetting to empty', {
        event: 'bindings_load_failed',
        filePath: this.filePath,
        error: err,
      })
      this.bindings = []
    }
  }

  private save(): void {
    try {
      if (!existsSync(this.dirPath)) {
        mkdirSync(this.dirPath, { recursive: true })
      }
      writeFileSync(this.filePath, JSON.stringify(this.bindings, null, 2), 'utf-8')
      // Fire the listener only after the write succeeds — otherwise the UI
      // shows a "binding added" event for state that will disappear on
      // restart.
      this.changeListener?.()
    } catch (err) {
      this.log.error('failed to save bindings store', {
        event: 'bindings_save_failed',
        filePath: this.filePath,
        error: err,
      })
    }
  }
}

// ---------------------------------------------------------------------------
// Migration helpers
// ---------------------------------------------------------------------------

type PersistedExternalMessagingBinding = ExternalMessagingChannelBinding & {
  channelId?: string
  config?: Partial<ExternalMessagingChannelBinding['config']> & {
    approvalChannel?: ExternalMessagingChannelBinding['config']['approvalSurface']
  }
}

function normalizeBinding(raw: PersistedExternalMessagingBinding): ExternalMessagingChannelBinding {
  const legacyConfig = raw.config?.approvalChannel !== undefined
    ? { ...raw.config, approvalSurface: raw.config.approvalChannel }
    : raw.config
  const channelId = raw.messagingChannelId ?? raw.channelId ?? ''
  return {
    ...raw,
    messagingChannelId: messagingChannelId(channelId),
    config: normalizeBindingConfig(raw.platform, legacyConfig ?? {}),
  }
}
