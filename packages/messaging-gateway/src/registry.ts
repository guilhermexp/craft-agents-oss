/**
 * MessagingGatewayRegistry — owns per-workspace MessagingGateway instances.
 *
 * Responsibilities:
 *   - Satisfies IMessagingGatewayRegistry for the RPC handlers in server-core.
 *   - Acts as a single EventSink consumer fanning session events to the right gateway.
 *   - Owns the in-memory pairing code manager (shared across workspaces; codes are workspace-scoped).
 *   - Owns per-workspace MessagingConfig (messaging/config.json).
 *   - Owns platform adapter lifecycle (initialize/swap/destroy) via CredentialManager.
 *
 * The registry is constructed once, wired into HandlerDeps, then populated with
 * gateways via initializeWorkspace() for every workspace that has messaging enabled.
 */

import { existsSync, readdirSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { RPC_NAMESPACES } from '@craft-agent/shared/protocol'
import type { PushTarget } from '@craft-agent/shared/protocol'
import type { CredentialManager } from '@craft-agent/shared/credentials'
import type {
  ISessionManager,
  IMessagingGatewayRegistry,
  MessagingBindingInfo,
  MessagingConfigInfo,
} from '@craft-agent/server-core/handlers'

import { MessagingGateway } from './gateway'
import { ConfigStore } from './config-store'
import { PairingCodeManager } from './pairing'
import { TelegramAdapter, telegramCredentialCodec } from './adapters/telegram/index'
import { WhatsAppAdapter, type WhatsAppEvent } from './adapters/whatsapp/index'
import { LarkAdapter, larkCredentialCodec } from './adapters/lark/index'
import { MessageAdapterRegistry } from './adapter-registry'
import { TopicRegistry } from './topic-registry'
import {
  dedupeOwners,
  readPlatformAccessMode,
  readPlatformOwners,
  resolveOwnerSeed,
  resolvePendingPromotion,
} from './access-control'
import type { SessionEvent } from './renderer'
import type { EventSinkFn } from './event-fanout'
import type {
  BindingAccessMode,
  ChannelBinding,
  MessagingConfig,
  MessagingLogger,
  MessagingPlatformRuntimeInfo,
  PendingSender,
  PlatformAccessMode,
  PlatformOwner,
  PlatformType,
} from './types'
import { messagingChannelId } from './types'

const consoleLogger: MessagingLogger = {
  info: (message, meta) => console.log('[MessagingRegistry]', message, meta ?? ''),
  warn: (message, meta) => console.warn('[MessagingRegistry]', message, meta ?? ''),
  error: (message, meta) => console.error('[MessagingRegistry]', message, meta ?? ''),
  child(context) {
    return {
      info: (message, meta) => console.log('[MessagingRegistry]', context, message, meta ?? ''),
      warn: (message, meta) => console.warn('[MessagingRegistry]', context, message, meta ?? ''),
      error: (message, meta) => console.error('[MessagingRegistry]', context, message, meta ?? ''),
      child: (next) => consoleLogger.child({ ...context, ...next }),
    }
  },
}

export interface MessagingGatewayRegistryOptions {
  sessionManager: ISessionManager
  credentialManager: CredentialManager
  /** Absolute path to the messaging storage directory for the given workspace. */
  getMessagingDir: (workspaceId: string) => string
  /** Optional legacy messaging dir (pre-relocation) for one-shot migration. */
  getLegacyMessagingDir?: (workspaceId: string) => string | undefined
  /** Broadcasts an RPC push event to UI clients. No-op if undefined. */
  publishEvent?: (channel: string, target: PushTarget, ...args: unknown[]) => void
  /** Optional WhatsApp worker config — required to enable the WhatsApp adapter. */
  whatsapp?: {
    /** Absolute path to the worker entry (packaged/unpacked from @craft-agent/messaging-whatsapp-worker). */
    workerEntry: string
    /** Node binary override (defaults to process.execPath with ELECTRON_RUN_AS_NODE). */
    nodeBin?: string
    /** Pairing flow: 'qr' or 'code'. Defaults to 'code' (phone-number based). */
    pairingMode?: 'qr' | 'code'
  }
  /** Optional logger — shared with the gateway and adapters. */
  logger?: MessagingLogger
}

interface WorkspaceState {
  gateway: MessagingGateway
  configStore: ConfigStore
  topicRegistry: TopicRegistry
  botUsernames: Partial<Record<PlatformType, string>>
  whatsapp: WhatsAppAdapter | null
  whatsappOffEvent?: () => void
  runtime: Record<PlatformType, MessagingPlatformRuntimeInfo>
}

export class MessagingGatewayRegistry implements IMessagingGatewayRegistry {
  private readonly workspaces = new Map<string, WorkspaceState>()
  private readonly pairing = new PairingCodeManager()
  private readonly adapterRegistry = new MessageAdapterRegistry()
  private readonly log: MessagingLogger

  constructor(private readonly opts: MessagingGatewayRegistryOptions) {
    this.log = (opts.logger ?? consoleLogger).child({ component: 'registry' })
    this.adapterRegistry.registerFactory('telegram', () => new TelegramAdapter(), telegramCredentialCodec)
    this.adapterRegistry.registerFactory('whatsapp', () => new WhatsAppAdapter())
    this.adapterRegistry.registerFactory('lark', () => new LarkAdapter(), larkCredentialCodec)

    // Install the automation→topic binder hook on the SessionManager so
    // executePromptAutomation can route topic-bound sessions without the
    // SessionManager needing to import this package (avoids a package-level
    // circular dependency).
    opts.sessionManager.setAutomationBinder?.(async (input) => {
      const result = await this.bindAutomationSession(input)
      if (!result.ok) {
        this.log.info('automation topic bind skipped', {
          event: 'automation_topic_bind_skipped',
          workspaceId: input.workspaceId,
          sessionId: input.sessionId,
          topicName: input.topicName,
          reason: result.reason,
          error: result.error,
        })
      }
    })
  }

  // -------------------------------------------------------------------------
  // Public registry lifecycle (called by the app bootstrap)
  // -------------------------------------------------------------------------

  async initializeWorkspace(workspaceId: string): Promise<void> {
    if (this.workspaces.has(workspaceId)) return

    const state = this.bootstrapWorkspace(workspaceId)
    const config = state.configStore.get()
    if (!config.enabled) return

    await state.gateway.start()
    this.log.info('gateway started for workspace', {
      event: 'gateway_started',
      workspaceId,
    })

    for (const platform of this.adapterRegistry.getRegisteredPlatforms()) {
      if (!isPlatformConfigured(config, platform)) continue

      if (this.adapterRegistry.getCredentialCodec(platform)) {
        this.setPlatformRuntime(workspaceId, state, platform, {
          configured: true,
          connected: false,
          state: 'connecting',
          lastError: undefined,
        })
        void this.connectCredentialAdapter(workspaceId, state, platform).catch((err) => {
          this.log.error('background connect failed', {
            event: 'platform_connect_failed',
            workspaceId,
            platform,
            error: err,
          })
        })
        continue
      }

      if (platform === 'whatsapp') {
        if (this.hasWhatsAppAuthState(workspaceId)) {
          this.setPlatformRuntime(workspaceId, state, 'whatsapp', {
            configured: true,
            connected: false,
            state: 'connecting',
            lastError: undefined,
          })
          void this.startWhatsAppAdapter(workspaceId, state, { persistConfig: false, reason: 'restore' }).catch((err) => {
            this.log.error('background WhatsApp restore failed', {
              event: 'whatsapp_restore_failed',
              workspaceId,
              error: err,
            })
            this.setPlatformRuntime(workspaceId, state, 'whatsapp', {
              configured: true,
              connected: false,
              state: 'error',
              lastError: err instanceof Error ? err.message : String(err),
            })
          })
        } else {
          this.setPlatformRuntime(workspaceId, state, 'whatsapp', {
            configured: true,
            connected: false,
            state: 'reconnect_required',
            lastError: 'WhatsApp needs to be linked again.',
          })
        }
      }
    }
  }

  async removeWorkspace(workspaceId: string): Promise<void> {
    const state = this.workspaces.get(workspaceId)
    if (!state) return
    await this.adapterRegistry.unregisterWorkspace(workspaceId)
    await state.gateway.stop()
    this.pairing.clearWorkspace(workspaceId)
    this.workspaces.delete(workspaceId)
  }

  async stopAll(): Promise<void> {
    const stops = Array.from(this.workspaces.entries()).map(async ([workspaceId, state]) => {
      await this.adapterRegistry.unregisterWorkspace(workspaceId).catch(() => {})
      await state.gateway.stop().catch(() => {})
    })
    await Promise.all(stops)
    this.workspaces.clear()
  }

  get size(): number {
    return this.workspaces.size
  }

  // -------------------------------------------------------------------------
  // IMessagingGatewayRegistry — config
  // -------------------------------------------------------------------------

  getConfig(workspaceId: string): MessagingConfigInfo | null {
    const state = this.ensureWorkspaceState(workspaceId)
    const cfg = state.configStore.get()
    return {
      enabled: cfg.enabled,
      platforms: cfg.platforms as MessagingConfigInfo['platforms'],
      runtime: this.buildRuntimeDto(state),
    }
  }

  async updateConfig(
    workspaceId: string,
    partial: Partial<MessagingConfigInfo>,
  ): Promise<void> {
    const state = this.ensureWorkspaceState(workspaceId)
    state.configStore.update({
      enabled: partial.enabled,
      platforms: partial.platforms,
    } as never)

    const cfg = state.configStore.get()
    if (!cfg.enabled) {
      await Promise.all(
        this.adapterRegistry
          .getRegisteredPlatforms()
          .map((platform) =>
            this.adapterRegistry.unregisterAdapter(workspaceId, state.gateway, platform).catch(() => {}),
          ),
      )
      state.whatsappOffEvent?.()
      state.whatsappOffEvent = undefined
      state.whatsapp = null
      for (const platform of this.adapterRegistry.getRegisteredPlatforms()) {
        this.setPlatformRuntime(workspaceId, state, platform, {
          configured: false,
          connected: false,
          state: 'disconnected',
          identity: undefined,
          lastError: undefined,
        })
      }
      return
    }

    for (const platform of this.adapterRegistry.getRegisteredPlatforms()) {
      const configured = isPlatformConfigured(cfg, platform)
      if (!configured && state.gateway.getAdapter(platform)) {
        await this.adapterRegistry.unregisterAdapter(workspaceId, state.gateway, platform).catch(() => {})
      }
      if (!configured && platform === 'whatsapp') {
        state.whatsappOffEvent?.()
        state.whatsappOffEvent = undefined
        state.whatsapp = null
      }
      if (!configured) {
        this.setPlatformRuntime(workspaceId, state, platform, {
          configured: false,
          connected: false,
          state: 'disconnected',
          identity: undefined,
          lastError: undefined,
        })
      }
    }
  }

  // -------------------------------------------------------------------------
  // IMessagingGatewayRegistry — bindings
  // -------------------------------------------------------------------------

  getBindings(workspaceId: string): MessagingBindingInfo[] {
    const state = this.workspaces.get(workspaceId)
    if (!state) return []
    return state.gateway.getBindingStore().getAll().map(toBindingInfo)
  }

  unbindSession(workspaceId: string, sessionId: string, platform?: string): void {
    const state = this.workspaces.get(workspaceId)
    if (!state) return
    const removed = state.gateway
      .getBindingStore()
      .unbindSession(sessionId, platform as PlatformType | undefined)
    if (removed > 0) this.emitBindingChanged(workspaceId)
  }

  unbindBinding(workspaceId: string, bindingId: string): boolean {
    const state = this.workspaces.get(workspaceId)
    if (!state) return false
    const removed = state.gateway.getBindingStore().unbindById(bindingId)
    if (removed) this.emitBindingChanged(workspaceId)
    return removed
  }

  // -------------------------------------------------------------------------
  // IMessagingGatewayRegistry — pairing
  // -------------------------------------------------------------------------

  generatePairingCode(
    workspaceId: string,
    sessionId: string,
    platform: string,
  ): { code: string; expiresAt: number; botUsername?: string } {
    if (!this.isKnownPlatform(platform)) {
      throw new Error(`Unknown messaging platform: ${platform}`)
    }
    const state = this.ensureWorkspaceState(workspaceId)
    if (!state.gateway.hasConnectedAdapter(platform)) {
      throw new Error(`${capitalize(platform)} is not connected`)
    }
    const gen = this.pairing.generate(workspaceId, sessionId, platform)
    this.log.info('pairing code generated', {
      event: 'pairing_generated',
      workspaceId,
      sessionId,
      platform,
      expiresAt: gen.expiresAt,
    })
    return {
      code: gen.code,
      expiresAt: gen.expiresAt,
      botUsername: state.botUsernames[platform],
    }
  }

  /**
   * Issue a workspace-supergroup pairing code. The user types
   * `/pair <code>` from any topic of the desired Telegram supergroup; the
   * bot captures `chat.id` and persists it as the workspace's accepted
   * supergroup, after which the adapter starts accepting messages from it.
   */
  generateSupergroupPairingCode(
    workspaceId: string,
    platform: string,
  ): { code: string; expiresAt: number; botUsername?: string } {
    if (!this.isKnownPlatform(platform)) {
      throw new Error(`Unknown messaging platform: ${platform}`)
    }
    if (platform !== 'telegram') {
      throw new Error(`${capitalize(platform)} does not support workspace-supergroup pairing.`)
    }
    const state = this.ensureWorkspaceState(workspaceId)
    if (!state.gateway.hasConnectedAdapter(platform)) {
      throw new Error(`${capitalize(platform)} is not connected`)
    }
    const gen = this.pairing.generateForSupergroup(workspaceId, platform)
    this.log.info('supergroup pairing code generated', {
      event: 'pairing_generated',
      kind: 'workspace-supergroup',
      workspaceId,
      platform,
      expiresAt: gen.expiresAt,
    })
    return {
      code: gen.code,
      expiresAt: gen.expiresAt,
      botUsername: state.botUsernames[platform],
    }
  }

  /**
   * Persist a paired supergroup at the workspace level and tell the running
   * adapter to start accepting its messages. Called from the gateway's
   * `pairingConsumer.bindWorkspaceSupergroup` hook after the user types
   * `/pair <code>` in the group, and also reachable directly via RPC for
   * future programmatic flows.
   */
  async bindWorkspaceSupergroup(
    workspaceId: string,
    platform: PlatformType,
    chatId: string,
    fallbackTitle?: string,
  ): Promise<{ title: string }> {
    if (platform !== 'telegram') {
      throw new Error(`${capitalize(platform)} does not support workspace-supergroup pairing.`)
    }
    const state = this.ensureWorkspaceState(workspaceId)
    const adapter = state.gateway.getAdapter('telegram') as TelegramAdapter | undefined
    if (!adapter) {
      throw new Error('Telegram adapter is not running. Connect the bot first.')
    }

    // Validate the chat is actually a forum supergroup before binding.
    // Without this, `/pair` typed in a DM (or a basic group, or a regular
    // supergroup without topics) "succeeds" at command level but breaks
    // downstream when `createForumTopic` runs — Telegram returns
    // `400: Bad Request: the chat is not a forum`.
    const info = await adapter.getChatInfo(chatId)
    if (!info) {
      throw new Error(
        'Cannot pair as supergroup: unable to read chat metadata. ' +
          'The bot may have been removed from the chat or lost permission to read it.',
      )
    }
    if (info.type !== 'supergroup') {
      throw new Error(
        `Cannot pair as supergroup: chat type is "${info.type}" — must be a supergroup. ` +
          'DMs and basic groups cannot host topics.',
      )
    }
    if (!info.isForum) {
      throw new Error(
        'Cannot pair as supergroup: the supergroup does not have topics enabled. ' +
          'In Telegram, open the group → Edit → enable "Topics", then try /pair again.',
      )
    }

    const title = info.title || fallbackTitle || `Group ${chatId}`

    state.configStore.patchPlatform(
      'telegram',
      {
        enabled: true,
        supergroup: { chatId, title, capturedAt: Date.now() },
      },
      { ensureEnabled: true },
    )

    adapter.setAcceptedSupergroupChatId(chatId)
    this.log.info('workspace supergroup bound', {
      event: 'workspace_supergroup_bound',
      workspaceId,
      platform,
      chatId,
      title,
    })
    return { title }
  }

  /**
   * Forget the paired supergroup. Existing topic-bound bindings are kept on
   * disk (they reference chatId only) but stop matching inbound updates
   * because the adapter rejects messages from the chat. Reconnecting the
   * same supergroup later restores routing.
   */
  async unbindWorkspaceSupergroup(workspaceId: string): Promise<void> {
    const state = this.workspaces.get(workspaceId)
    if (!state) return
    const cfg = state.configStore.get()
    const tg = cfg.platforms.telegram
    if (!tg?.supergroup) return

    // Drop the supergroup field but keep owners / accessMode / enabled
    // intact. JSON.stringify drops `undefined` values, so this is
    // effectively a key-deletion.
    state.configStore.patchPlatform('telegram', { supergroup: undefined })

    const adapter = state.gateway.getAdapter('telegram') as TelegramAdapter | undefined
    adapter?.setAcceptedSupergroupChatId(undefined)
    this.log.info('workspace supergroup unbound', {
      event: 'workspace_supergroup_unbound',
      workspaceId,
    })
  }

  /** Read accessor for the current paired supergroup, if any. */
  getWorkspaceSupergroup(workspaceId: string): { chatId: string; title: string; capturedAt: number } | null {
    const state = this.ensureWorkspaceState(workspaceId)
    const sg = state.configStore.get().platforms.telegram?.supergroup
    return sg ? { ...sg } : null
  }

  /**
   * Bind a freshly-spawned automation session to a Telegram forum topic in
   * the workspace's paired supergroup. The topic is created on first use and
   * reused thereafter.
   *
   * Best-effort: returns a discriminated result instead of throwing so the
   * caller (SessionManager) can log + continue without blocking the session.
   */
  async bindAutomationSession(args: {
    workspaceId: string
    sessionId: string
    topicName: string
  }): Promise<
    | { ok: true; chatId: string; threadId: number; reused: boolean }
    | {
        ok: false
        reason: 'invalid-name' | 'no-supergroup' | 'no-adapter' | 'topic-create-failed'
        error?: string
      }
  > {
    const trimmed = args.topicName?.trim() ?? ''
    if (trimmed.length === 0 || trimmed.length > 128) {
      return { ok: false, reason: 'invalid-name' }
    }

    const state = this.ensureWorkspaceState(args.workspaceId)
    const supergroup = state.configStore.get().platforms.telegram?.supergroup
    if (!supergroup?.chatId) return { ok: false, reason: 'no-supergroup' }

    const adapter = state.gateway.getAdapter('telegram') as TelegramAdapter | undefined
    if (!adapter) return { ok: false, reason: 'no-adapter' }

    const beforeCacheHit = state.topicRegistry.get(trimmed)

    try {
      const entry = await state.topicRegistry.findOrCreate({
        topicName: trimmed,
        chatId: supergroup.chatId,
        createTopic: (name) => adapter.createForumTopic(supergroup.chatId, name),
      })

      state.gateway.getBindingStore().bind(
        args.workspaceId,
        args.sessionId,
        'telegram',
        messagingChannelId(entry.chatId),
        trimmed,
        undefined,
        entry.threadId,
      )
      this.emitBindingChanged(args.workspaceId)

      return {
        ok: true,
        chatId: entry.chatId,
        threadId: entry.threadId,
        reused: Boolean(beforeCacheHit),
      }
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err)
      this.log.warn('automation topic bind failed', {
        event: 'automation_topic_bind_failed',
        workspaceId: args.workspaceId,
        sessionId: args.sessionId,
        topicName: trimmed,
        error: message,
      })
      return { ok: false, reason: 'topic-create-failed', error: message }
    }
  }

  /**
   * Drop a cached topic entry. Does NOT delete the topic in Telegram (the
   * bot has no signal that the user wants the history gone). Useful when
   * an automation is renamed/removed and the user wants the next use of
   * a topic name to create a fresh topic instead of reusing the cached one.
   */
  async removeAutomationTopic(workspaceId: string, topicName: string): Promise<void> {
    const state = this.workspaces.get(workspaceId)
    if (!state) return
    await state.topicRegistry.remove(topicName.trim())
  }

  // -------------------------------------------------------------------------
  // IMessagingGatewayRegistry — platform lifecycle
  // -------------------------------------------------------------------------

  async testCredential(
    platform: string,
    credential: string,
  ): Promise<{ success: boolean; botName?: string; botUsername?: string; error?: string }> {
    if (!this.isKnownPlatform(platform)) {
      return { success: false, error: `Unknown messaging platform: ${platform}` }
    }
    const codec = this.adapterRegistry.getCredentialCodec(platform)
    if (!codec) {
      return { success: false, error: `${capitalize(platform)} does not accept a stored credential.` }
    }
    return codec.test(credential)
  }

  /**
   * Connect a platform for a workspace. Credential-based platforms (Telegram,
   * Lark) validate + persist the supplied `credential` and initialise the
   * adapter; interactive platforms (WhatsApp) ignore `credential` and start
   * their link flow. Single lifecycle entry point so a new platform costs an
   * adapter directory + a factory registration — nothing here.
   */
  async connectPlatform(
    workspaceId: string,
    platform: string,
    credential?: string,
  ): Promise<void> {
    if (!this.isKnownPlatform(platform)) {
      throw new Error(`Unknown messaging platform: ${platform}`)
    }
    const state = this.ensureWorkspaceState(workspaceId)
    const codec = this.adapterRegistry.getCredentialCodec(platform)

    if (codec) {
      if (credential === undefined) {
        throw new Error(`${capitalize(platform)} requires a credential to connect.`)
      }
      const value = codec.normalize(credential)
      const test = await codec.test(credential)
      if (!test.success) throw new Error(test.error ?? 'Invalid credentials')

      await this.opts.credentialManager.set(
        { type: 'messaging_bearer', workspaceId, name: platform },
        { value },
      )
      // Enable the platform without clobbering owners / accessMode / supergroup.
      state.configStore.patchPlatform(platform, { enabled: true }, { ensureEnabled: true })
      this.setPlatformRuntime(workspaceId, state, platform, {
        configured: true,
        connected: false,
        state: 'connecting',
        lastError: undefined,
      })
      await this.connectCredentialAdapter(workspaceId, state, platform)
      await state.gateway.start()
      return
    }

    if (platform === 'whatsapp') {
      if (!this.opts.whatsapp) {
        throw new Error('WhatsApp support is not configured on this server')
      }
      this.setPlatformRuntime(workspaceId, state, 'whatsapp', {
        configured: true,
        connected: false,
        state: 'connecting',
        lastError: undefined,
      })
      await this.startWhatsAppAdapter(workspaceId, state, { persistConfig: true, reason: 'user_connect' })
      return
    }

    throw new Error(`${capitalize(platform)} has no connect flow.`)
  }

  async disconnectPlatform(workspaceId: string, platform: string): Promise<void> {
    if (!this.isKnownPlatform(platform)) return
    const state = this.workspaces.get(workspaceId)
    if (!state) return

    if (platform === 'whatsapp') {
      state.whatsappOffEvent?.()
      state.whatsappOffEvent = undefined
      if (state.whatsapp) {
        await state.whatsapp.destroy().catch(() => {})
        state.whatsapp = null
      }
    }

    await this.adapterRegistry.unregisterAdapter(workspaceId, state.gateway, platform).catch(() => {})
    state.botUsernames[platform] = undefined
    this.pairing.clearWorkspace(workspaceId)

    // Preserve per-platform fields (owners / accessMode / supergroup for
    // telegram, selfChatMode for whatsapp, domain for lark) so reconnecting
    // doesn't surprise the operator with a reset to public. Use
    // `forgetPlatform` for the full wipe.
    const currentConfig = state.configStore.get()
    const currentPlatformConfig = currentConfig.platforms[platform] ?? { enabled: true }
    const nextPlatforms = {
      ...currentConfig.platforms,
      [platform]: { ...currentPlatformConfig, enabled: false },
    }
    const anyPlatformEnabled = Object.values(nextPlatforms).some((entry) => entry?.enabled)
    state.configStore.update({
      enabled: anyPlatformEnabled,
      platforms: nextPlatforms,
    })

    if (platform !== 'whatsapp') {
      await this.opts.credentialManager
        .delete({ type: 'messaging_bearer', workspaceId, name: platform })
        .catch(() => {})
    }

    this.setPlatformRuntime(workspaceId, state, platform, {
      configured: false,
      connected: false,
      state: 'disconnected',
      identity: undefined,
      lastError: undefined,
    })
  }

  async forgetPlatform(workspaceId: string, platform: string): Promise<void> {
    if (!this.isKnownPlatform(platform)) return
    await this.disconnectPlatform(workspaceId, platform)
    if (platform === 'whatsapp') {
      const authDir = this.getWhatsAppAuthStateDir(workspaceId)
      try {
        rmSync(authDir, { recursive: true, force: true })
        this.log.info('forgot WhatsApp auth state', {
          event: 'whatsapp_auth_forgotten',
          workspaceId,
          authDir,
        })
      } catch (err) {
        this.log.error('failed to forget WhatsApp auth state', {
          event: 'whatsapp_auth_forget_failed',
          workspaceId,
          authDir,
          error: err,
        })
        throw err
      }
    }
  }

  // -------------------------------------------------------------------------
  // WhatsApp — subprocess lifecycle
  // -------------------------------------------------------------------------

  async submitPairingInput(workspaceId: string, platform: string, input: string): Promise<void> {
    if (platform !== 'whatsapp') {
      throw new Error(`${capitalize(platform)} does not use interactive pairing input.`)
    }
    const state = this.workspaces.get(workspaceId)
    if (!state?.whatsapp) {
      throw new Error('WhatsApp not started — connect it first')
    }
    const cleaned = input.replace(/[^\d]/g, '')
    if (cleaned.length < 8) throw new Error('Phone number looks too short')
    await state.whatsapp.requestPairingCode(cleaned)
  }

  private async startWhatsAppAdapter(
    workspaceId: string,
    state: WorkspaceState,
    options: { persistConfig: boolean; reason: 'restore' | 'user_connect' },
  ): Promise<void> {
    const waConfig = this.opts.whatsapp
    if (!waConfig) {
      throw new Error('WhatsApp support is not configured on this server')
    }

    state.whatsappOffEvent?.()
    state.whatsappOffEvent = undefined
    await this.adapterRegistry.unregisterAdapter(workspaceId, state.gateway, 'whatsapp').catch(() => {})
    state.whatsapp = null

    // selfChatMode: default ON. Persisted to workspace config so it
    // survives restart and can be toggled later if the user wants pure
    // contact-only routing.
    const persistedCfg = state.configStore.get()
    const selfChatMode = persistedCfg.platforms.whatsapp?.selfChatMode ?? true

    let unsubscribeWhatsApp: (() => void) | undefined
    const adapter = await this.adapterRegistry.initializeAdapter({
      workspaceId,
      gateway: state.gateway,
      platform: 'whatsapp',
      replace: true,
      config: {
        workerEntry: waConfig.workerEntry,
        nodeBin: waConfig.nodeBin,
        authStateDir: this.getWhatsAppAuthStateDir(workspaceId),
        pairingMode: waConfig.pairingMode ?? 'code',
        selfChatMode,
        logger: this.log.child({
          component: 'whatsapp-adapter',
          workspaceId,
          platform: 'whatsapp',
        }),
      },
      beforeInitialize: (created) => {
        unsubscribeWhatsApp = (created as WhatsAppAdapter)
          .onEvent((ev) => this.onWhatsAppEvent(workspaceId, ev))
      },
    }) as WhatsAppAdapter
    state.whatsapp = adapter
    state.whatsappOffEvent = unsubscribeWhatsApp

    if (options.persistConfig) {
      state.configStore.patchPlatform('whatsapp', { enabled: true, selfChatMode }, { ensureEnabled: true })
    }
    await state.gateway.start()
    this.log.info('WhatsApp adapter started', {
      event: 'whatsapp_adapter_started',
      workspaceId,
      reason: options.reason,
    })
  }

  private onWhatsAppEvent(workspaceId: string, event: WhatsAppEvent): void {
    const state = this.workspaces.get(workspaceId)
    if (!state) return

    this.opts.publishEvent?.(
      RPC_NAMESPACES.messaging.WA_UI_EVENT,
      { to: 'workspace', workspaceId },
      { workspaceId, event },
    )

    switch (event.type) {
      case 'qr':
        this.setPlatformRuntime(workspaceId, state, 'whatsapp', {
          configured: true,
          connected: false,
          state: 'reconnect_required',
          lastError: 'QR scan required',
        })
        return
      case 'connected':
        this.setPlatformRuntime(workspaceId, state, 'whatsapp', {
          configured: true,
          connected: true,
          state: 'connected',
          identity: event.name ?? event.jid,
          lastError: undefined,
        })
        return
      case 'disconnected':
        this.setPlatformRuntime(workspaceId, state, 'whatsapp', {
          configured: true,
          connected: false,
          state: event.loggedOut ? 'reconnect_required' : 'disconnected',
          lastError: event.reason,
          identity: undefined,
        })
        return
      case 'unavailable':
        this.setPlatformRuntime(workspaceId, state, 'whatsapp', {
          configured: true,
          connected: false,
          state: 'error',
          lastError: event.message,
          identity: undefined,
        })
        return
      case 'error':
        if (!state.runtime.whatsapp.connected) {
          this.setPlatformRuntime(workspaceId, state, 'whatsapp', {
            configured: true,
            connected: false,
            state: 'error',
            lastError: event.message,
          })
        }
        return
      case 'pairing_code':
        return
    }
  }

  // -------------------------------------------------------------------------
  // EventSink-compatible callback
  // -------------------------------------------------------------------------

  onSessionEvent: EventSinkFn = (channel: string, target: PushTarget, ...args: unknown[]) => {
    if (channel !== RPC_NAMESPACES.sessions.EVENT) return

    const event = args[0] as SessionEvent | undefined
    if (!event?.sessionId) return

    const workspaceId =
      'workspaceId' in target ? (target as { workspaceId: string }).workspaceId : undefined
    if (!workspaceId) {
      for (const state of this.workspaces.values()) {
        state.gateway.onSessionEvent(channel, target, ...args)
      }
      return
    }

    const state = this.workspaces.get(workspaceId)
    if (state) state.gateway.onSessionEvent(channel, target, ...args)
  }

  // -------------------------------------------------------------------------
  // Internal helpers
  // -------------------------------------------------------------------------

  private bootstrapWorkspace(workspaceId: string): WorkspaceState {
    const existing = this.workspaces.get(workspaceId)
    if (existing) return existing

    const storageDir = this.opts.getMessagingDir(workspaceId)
    const legacyStorageDir = this.opts.getLegacyMessagingDir?.(workspaceId)
    const baseLog = this.log.child({ workspaceId })
    const configStore = new ConfigStore(
      storageDir,
      legacyStorageDir,
      baseLog.child({ component: 'config-store' }),
    )
    const cfg = configStore.get()
    const gateway = new MessagingGateway({
      sessionManager: this.opts.sessionManager,
      workspaceId,
      storageDir,
      legacyStorageDir,
      logger: baseLog,
      pairingConsumer: {
        canConsume: (platform, senderId) =>
          this.pairing.canConsume(workspaceId, platform, senderId),
        consume: (platform, code) => {
          const entry = this.pairing.consume(workspaceId, platform, code)
          if (!entry) return null
          if (entry.kind === 'workspace-supergroup') {
            return { kind: 'workspace-supergroup', workspaceId: entry.workspaceId }
          }
          // entry.kind === 'session'
          if (!entry.sessionId) return null
          return { kind: 'session', workspaceId: entry.workspaceId, sessionId: entry.sessionId }
        },
        bindWorkspaceSupergroup: async ({ platform, chatId, fallbackTitle }) => {
          if (!this.isKnownPlatform(platform)) {
            throw new Error(`Unknown platform for supergroup pairing: ${platform}`)
          }
          return this.bindWorkspaceSupergroup(workspaceId, platform, chatId, fallbackTitle)
        },
      },
      // Read live config so accessMode/owner toggles take effect immediately.
      getWorkspaceConfig: () => configStore.get(),
      seedOwnerOnFirstPair: async (platform, candidate) =>
        this.seedFirstOwner(workspaceId, platform, candidate),
      onBindingChanged: () => this.emitBindingChanged(workspaceId),
      onPendingChanged: () => this.emitPendingChanged(workspaceId),
    })

    const topicRegistry = new TopicRegistry(
      storageDir,
      baseLog.child({ component: 'topic-registry' }),
    )

    const state: WorkspaceState = {
      gateway,
      configStore,
      topicRegistry,
      botUsernames: {},
      whatsapp: null,
      runtime: this.buildRuntimeRecord(cfg),
    }
    this.workspaces.set(workspaceId, state)
    return state
  }

  /**
   * Connect a credential-based adapter (Telegram, Lark) from its stored
   * credential: validate the stored value, initialise the adapter, capture its
   * identity, and publish runtime status. Shared by the restore path
   * (initializeWorkspace) and the connect path (connectPlatform). Adapter-
   * specific details (Lark's JSON shape, Telegram's supergroup, per-platform
   * identity) live in the codec + adapter, not here.
   */
  private async connectCredentialAdapter(
    workspaceId: string,
    state: WorkspaceState,
    platform: PlatformType,
  ): Promise<void> {
    const cred = await this.opts.credentialManager
      .get({ type: 'messaging_bearer', workspaceId, name: platform })
      .catch(() => null)

    if (!cred?.value) {
      this.setPlatformRuntime(workspaceId, state, platform, {
        configured: true,
        connected: false,
        state: 'error',
        lastError: `${capitalize(platform)} credentials are missing.`,
      })
      return
    }

    // Let the adapter's codec reject a structurally-broken stored credential
    // (e.g. malformed Lark JSON) before we try to connect.
    try {
      this.adapterRegistry.getCredentialCodec(platform)?.normalize(cred.value)
    } catch (err) {
      this.setPlatformRuntime(workspaceId, state, platform, {
        configured: true,
        connected: false,
        state: 'error',
        lastError: err instanceof Error ? err.message : `${capitalize(platform)} credentials are malformed`,
      })
      return
    }

    await this.adapterRegistry.unregisterAdapter(workspaceId, state.gateway, platform).catch((err) => {
      this.log.warn('unregisterAdapter failed (non-fatal)', {
        event: 'adapter_unregister_failed',
        workspaceId,
        platform,
        error: err,
      })
    })

    try {
      const supergroupChatId =
        platform === 'telegram'
          ? state.configStore.get().platforms.telegram?.supergroup?.chatId
          : undefined
      const adapter = await this.adapterRegistry.initializeAdapter({
        workspaceId,
        gateway: state.gateway,
        platform,
        replace: true,
        config: {
          token: cred.value,
          ...(supergroupChatId ? { acceptedSupergroupChatId: supergroupChatId } : {}),
          logger: this.log.child({
            component: `${platform}-adapter`,
            workspaceId,
            platform,
          }),
        },
      })

      let identity: string | undefined
      try {
        identity = await adapter.getIdentity?.()
      } catch {
        // non-fatal: identity is a UI hint, not required to be connected.
      }
      state.botUsernames[platform] = identity

      this.setPlatformRuntime(workspaceId, state, platform, {
        configured: true,
        connected: true,
        state: 'connected',
        identity,
        lastError: undefined,
      })
    } catch (err) {
      this.log.error('failed to connect platform', {
        event: 'platform_connect_failed',
        workspaceId,
        platform,
        error: err,
      })
      this.setPlatformRuntime(workspaceId, state, platform, {
        configured: true,
        connected: false,
        state: 'error',
        lastError: err instanceof Error ? err.message : String(err),
      })
      throw err
    }
  }

  private setPlatformRuntime(
    workspaceId: string,
    state: WorkspaceState,
    platform: PlatformType,
    patch: Partial<MessagingPlatformRuntimeInfo>,
  ): void {
    const previous = state.runtime[platform] ?? createRuntime(platform, false)
    const next: MessagingPlatformRuntimeInfo = {
      ...previous,
      ...patch,
      platform,
      updatedAt: Date.now(),
    }
    state.runtime[platform] = next
    this.emitPlatformStatus(workspaceId, platform, next)
  }

  private emitBindingChanged(workspaceId: string): void {
    this.opts.publishEvent?.(
      RPC_NAMESPACES.messaging.BINDING_CHANGED,
      { to: 'workspace', workspaceId },
      workspaceId,
    )
  }

  private emitPendingChanged(workspaceId: string): void {
    // Channel name kept symmetric with BINDING_CHANGED. Phase 3 wires the
    // RPC channel constant; for now this is a no-op when the constant is
    // absent.
    const channel = (
      RPC_NAMESPACES.messaging as Record<string, string | undefined>
    ).PENDING_CHANGED
    if (!channel) return
    this.opts.publishEvent?.(
      channel,
      { to: 'workspace', workspaceId },
      workspaceId,
    )
  }

  // -------------------------------------------------------------------------
  // Access control — workspace owners + per-binding allow lists
  // -------------------------------------------------------------------------

  /**
   * Seed the first owner for a platform on `/pair` redeem. No-op when the
   * platform doesn't support access control or an owner already exists.
   */
  private async seedFirstOwner(
    workspaceId: string,
    platform: PlatformType,
    candidate: PlatformOwner,
  ): Promise<PlatformOwner[]> {
    if (!this.platformSupportsAccessControl(platform)) return []
    const state = this.ensureWorkspaceState(workspaceId)
    const seed = resolveOwnerSeed(state.configStore.get(), platform, candidate)
    if (!seed.changed) return seed.owners
    state.configStore.patchPlatform(platform, { accessMode: seed.accessMode, owners: seed.owners })
    this.log.info('seeded first owner', {
      event: 'first_owner_seeded',
      workspaceId,
      platform,
      ownerId: candidate.userId,
    })
    return seed.owners
  }

  getPlatformOwners(workspaceId: string, platform: PlatformType): PlatformOwner[] {
    if (!this.platformSupportsAccessControl(platform)) return []
    return readPlatformOwners(this.ensureWorkspaceState(workspaceId).configStore.get(), platform)
  }

  setPlatformOwners(
    workspaceId: string,
    platform: PlatformType,
    owners: PlatformOwner[],
  ): PlatformOwner[] {
    if (!this.platformSupportsAccessControl(platform)) {
      throw new Error(`${capitalize(platform)} does not support owner lists.`)
    }
    const state = this.ensureWorkspaceState(workspaceId)
    state.configStore.patchPlatform(platform, { owners: dedupeOwners(owners) })
    this.emitBindingChanged(workspaceId)
    return readPlatformOwners(state.configStore.get(), platform)
  }

  getPlatformAccessMode(workspaceId: string, platform: PlatformType): PlatformAccessMode {
    if (!this.platformSupportsAccessControl(platform)) return 'open'
    return readPlatformAccessMode(this.ensureWorkspaceState(workspaceId).configStore.get(), platform)
  }

  setPlatformAccessMode(
    workspaceId: string,
    platform: PlatformType,
    mode: PlatformAccessMode,
  ): void {
    if (!this.platformSupportsAccessControl(platform)) {
      throw new Error(`${capitalize(platform)} does not support an access-mode policy.`)
    }
    const state = this.ensureWorkspaceState(workspaceId)
    state.configStore.patchPlatform(platform, { accessMode: mode })

    // Lock-down semantics: switching to `owner-only` must also close any
    // binding still in `open` mode, otherwise the operator locks down but
    // legacy bindings stay public — the false-sense-of-security UX this is
    // meant to prevent.
    if (mode === 'owner-only') {
      this.migrateOpenBindingsToInherit(workspaceId, platform)
    }

    this.emitBindingChanged(workspaceId)
  }

  /**
   * Flip any of a platform's bindings with `accessMode === 'open'` to
   * `'inherit'` (the safe default) when locking the workspace down.
   */
  private migrateOpenBindingsToInherit(workspaceId: string, platform: PlatformType): void {
    const state = this.workspaces.get(workspaceId)
    if (!state) return
    const store = state.gateway.getBindingStore()
    for (const b of store.getAll()) {
      if (b.platform !== platform) continue
      if (b.config.accessMode !== 'open') continue
      store.updateBindingConfig(b.id, { accessMode: 'inherit', allowedSenderIds: [] })
    }
  }

  /** Pending senders surface in Settings → Messaging as "Pending requests". */
  getPendingSenders(workspaceId: string, platform?: PlatformType): PendingSender[] {
    const state = this.workspaces.get(workspaceId)
    if (!state) return []
    return state.gateway.getPendingStore().list(platform)
  }

  dismissPendingSender(
    workspaceId: string,
    platform: PlatformType,
    userId: string,
  ): boolean {
    const state = this.workspaces.get(workspaceId)
    if (!state) return false
    return state.gateway.getPendingStore().dismiss(platform, userId)
  }

  /**
   * Allow a pending sender. Delegates the reason-branching decision (owner
   * promotion vs binding allow-list) to access-control; persists any owner
   * change and emits the binding-changed event here.
   */
  allowPendingSender(
    workspaceId: string,
    platform: PlatformType,
    userId: string,
    entryKey?: { reason?: PendingSender['reason']; bindingId?: string },
  ): { owners: PlatformOwner[]; bindingId?: string } {
    if (!this.platformSupportsAccessControl(platform)) {
      throw new Error(`${capitalize(platform)} does not support owner lists.`)
    }
    const state = this.ensureWorkspaceState(workspaceId)
    const result = resolvePendingPromotion({
      config: state.configStore.get(),
      platform,
      userId,
      entryKey,
      bindingStore: state.gateway.getBindingStore(),
      pendingStore: state.gateway.getPendingStore(),
    })
    if (result.ownersToPersist) {
      state.configStore.patchPlatform(platform, {
        owners: result.ownersToPersist,
        accessMode: result.accessModeToPersist,
      })
    }
    if (result.bindingChanged) this.emitBindingChanged(workspaceId)
    return result.bindingId === undefined
      ? { owners: result.owners }
      : { owners: result.owners, bindingId: result.bindingId }
  }

  /**
   * Update the access policy on a single binding. Uses the in-place
   * `updateBindingConfig` method so the binding's `id` and `createdAt`
   * survive — anything keyed on bindingId (audit logs, deep links, stale
   * renderer closures) keeps working.
   */
  setBindingAccess(
    workspaceId: string,
    bindingId: string,
    access: { mode: BindingAccessMode; allowedSenderIds?: string[] },
  ): void {
    const state = this.workspaces.get(workspaceId)
    if (!state) throw new Error('Workspace not initialised')
    const store = state.gateway.getBindingStore()
    const next = store.updateBindingConfig(bindingId, {
      accessMode: access.mode,
      allowedSenderIds:
        access.mode === 'allow-list' ? [...(access.allowedSenderIds ?? [])] : [],
    })
    if (!next) throw new Error('Binding not found')
    this.emitBindingChanged(workspaceId)
  }

  private emitPlatformStatus(
    workspaceId: string,
    platform: PlatformType,
    status: MessagingPlatformRuntimeInfo,
  ): void {
    this.opts.publishEvent?.(
      RPC_NAMESPACES.messaging.PLATFORM_STATUS,
      { to: 'workspace', workspaceId },
      workspaceId,
      platform,
      cloneRuntime(status),
    )
  }

  private hasWhatsAppAuthState(workspaceId: string): boolean {
    const dir = this.getWhatsAppAuthStateDir(workspaceId)
    if (!existsSync(dir)) return false
    try {
      return readdirSync(dir).some((entry) => !entry.startsWith('.'))
    } catch {
      return false
    }
  }

  private getWhatsAppAuthStateDir(workspaceId: string): string {
    return join(this.opts.getMessagingDir(workspaceId), 'whatsapp-auth')
  }

  // -------------------------------------------------------------------------
  // Workspace state access + platform capability lookup
  // -------------------------------------------------------------------------

  /**
   * Narrow read accessor: the workspace's live gateway, bootstrapping the
   * workspace lazily when it doesn't exist yet. Exposes only the gateway
   * (adapter registration + binding/pending stores) rather than the whole
   * mutable WorkspaceState — the sole external consumers are tests that
   * register fake adapters and seed binding/pending rows.
   */
  getGateway(workspaceId: string): MessagingGateway {
    return this.ensureWorkspaceState(workspaceId).gateway
  }

  /** Return the workspace state, bootstrapping it when it doesn't exist yet. */
  private ensureWorkspaceState(workspaceId: string): WorkspaceState {
    return this.workspaces.get(workspaceId) ?? this.bootstrapWorkspace(workspaceId)
  }

  private isKnownPlatform(platform: string): platform is PlatformType {
    return this.adapterRegistry.hasFactory(platform as PlatformType)
  }

  private platformSupportsAccessControl(platform: PlatformType): boolean {
    return this.adapterRegistry.getStaticCapabilities(platform)?.accessControl === true
  }

  private buildRuntimeRecord(cfg: MessagingConfig): Record<PlatformType, MessagingPlatformRuntimeInfo> {
    const runtime = {} as Record<PlatformType, MessagingPlatformRuntimeInfo>
    for (const platform of this.adapterRegistry.getRegisteredPlatforms()) {
      runtime[platform] = createRuntime(platform, isPlatformConfigured(cfg, platform))
    }
    return runtime
  }

  private buildRuntimeDto(state: WorkspaceState): MessagingConfigInfo['runtime'] {
    const dto: MessagingConfigInfo['runtime'] = {}
    for (const platform of this.adapterRegistry.getRegisteredPlatforms()) {
      const runtime = state.runtime[platform]
      if (runtime) dto[platform] = cloneRuntime(runtime)
    }
    return dto
  }
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function toBindingInfo(b: ChannelBinding): MessagingBindingInfo {
  return {
    id: b.id,
    workspaceId: b.workspaceId,
    sessionId: b.sessionId,
    platform: b.platform,
    messagingChannelId: b.messagingChannelId,
    ...(b.threadId !== undefined ? { threadId: b.threadId } : {}),
    channelName: b.channelName,
    enabled: b.enabled,
    createdAt: b.createdAt,
    accessMode: b.config.accessMode,
    allowedSenderIds: [...b.config.allowedSenderIds],
  }
}

function capitalize(value: string): string {
  return value.length === 0 ? value : value[0]!.toUpperCase() + value.slice(1)
}

function isPlatformConfigured(
  config: { enabled: boolean; platforms: Record<string, { enabled: boolean } | undefined> },
  platform: PlatformType,
): boolean {
  return Boolean(config.enabled && config.platforms[platform]?.enabled)
}

function createRuntime(platform: PlatformType, configured: boolean): MessagingPlatformRuntimeInfo {
  return {
    platform,
    configured,
    connected: false,
    state: 'disconnected',
    updatedAt: Date.now(),
  }
}

function cloneRuntime(runtime: MessagingPlatformRuntimeInfo): MessagingPlatformRuntimeInfo {
  return { ...runtime }
}
