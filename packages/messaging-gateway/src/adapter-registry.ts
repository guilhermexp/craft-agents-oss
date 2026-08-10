/**
 * MessageAdapterRegistry owns gateway-local adapter factories and lifecycle.
 *
 * It is intentionally scoped below MessagingGatewayRegistry: the workspace
 * registry still owns persisted config and credentials, while this registry
 * owns channel adapter discovery, construction, central initialize/unregister
 * dispatch, and runtime/capability visibility.
 */

import { MessagingGateway } from './gateway'
import type {
  AdapterCapabilities,
  MessagingPlatformRuntimeInfo,
  PlatformAdapter,
  PlatformConfig,
  PlatformType,
  CredentialCodec,
} from './types'

export type MessageAdapterFactory = () => PlatformAdapter

interface ActiveAdapter {
  adapter: PlatformAdapter
  gateway: MessagingGateway
}

export class MessageAdapterRegistry {
  private readonly factories = new Map<PlatformType, MessageAdapterFactory>()
  private readonly active = new Map<string, ActiveAdapter>()
  private readonly credentials = new Map<PlatformType, CredentialCodec>()
  private readonly staticCaps = new Map<PlatformType, AdapterCapabilities>()

  registerFactory(
    platform: PlatformType,
    factory: MessageAdapterFactory,
    credentials?: CredentialCodec,
  ): void {
    if (this.factories.has(platform)) {
      throw new Error(`Adapter factory already registered for platform: ${platform}`)
    }
    this.factories.set(platform, factory)
    if (credentials) this.credentials.set(platform, credentials)
  }

  hasFactory(platform: PlatformType): boolean {
    return this.factories.has(platform)
  }

  getRegisteredPlatforms(): PlatformType[] {
    return Array.from(this.factories.keys())
  }

  /** Credential codec for a platform, when it is credential-based. */
  getCredentialCodec(platform: PlatformType): CredentialCodec | undefined {
    return this.credentials.get(platform)
  }

  /**
   * Static capabilities for a platform, read from a throwaway adapter instance
   * (adapter constructors are side-effect-free) and cached. Undefined when no
   * factory is registered. Lets callers gate capability-dependent operations
   * before any workspace adapter is connected.
   */
  getStaticCapabilities(platform: PlatformType): AdapterCapabilities | undefined {
    const cached = this.staticCaps.get(platform)
    if (cached) return cached
    const factory = this.factories.get(platform)
    if (!factory) return undefined
    const caps = factory().capabilities
    this.staticCaps.set(platform, caps)
    return caps
  }

  async initializeAdapter(options: {
    workspaceId: string
    gateway: MessagingGateway
    platform: PlatformType
    config: PlatformConfig
    replace?: boolean
    beforeInitialize?: (adapter: PlatformAdapter) => void
  }): Promise<PlatformAdapter> {
    const key = this.key(options.workspaceId, options.platform)
    const existing = this.active.get(key)
    if (existing && !options.replace) {
      throw new Error(`Adapter already active for workspace/platform: ${options.workspaceId}/${options.platform}`)
    }
    if (existing) {
      await this.unregisterAdapter(options.workspaceId, options.gateway, options.platform)
    }

    const factory = this.factories.get(options.platform)
    if (!factory) {
      throw new Error(`No adapter factory registered for platform: ${options.platform}`)
    }

    const adapter = factory()
    if (adapter.platform !== options.platform) {
      throw new Error(`Adapter factory mismatch: expected ${options.platform}, got ${adapter.platform}`)
    }

    try {
      options.beforeInitialize?.(adapter)
      await adapter.initialize(options.config)
      options.gateway.registerAdapter(adapter)
      this.active.set(key, { adapter, gateway: options.gateway })
      return adapter
    } catch (err) {
      await adapter.destroy().catch(() => {})
      throw err
    }
  }

  async unregisterAdapter(
    workspaceId: string,
    gateway: MessagingGateway,
    platform: PlatformType,
  ): Promise<void> {
    const key = this.key(workspaceId, platform)
    this.active.delete(key)
    await gateway.unregisterAdapter(platform)
  }

  async unregisterWorkspace(workspaceId: string): Promise<void> {
    const entries = Array.from(this.active.entries())
      .filter(([key]) => key.startsWith(`${workspaceId}:`))

    await Promise.all(entries.map(async ([key, entry]) => {
      this.active.delete(key)
      await entry.gateway.unregisterAdapter(entry.adapter.platform)
    }))
  }

  getAdapter(workspaceId: string, platform: PlatformType): PlatformAdapter | undefined {
    return this.active.get(this.key(workspaceId, platform))?.adapter
  }

  getCapabilities(
    workspaceId: string,
    platform: PlatformType,
  ): AdapterCapabilities | undefined {
    return this.getAdapter(workspaceId, platform)?.capabilities
  }

  getRuntime(
    workspaceId: string,
    platform: PlatformType,
    configured: boolean,
  ): MessagingPlatformRuntimeInfo {
    const adapter = this.getAdapter(workspaceId, platform)
    const connected = adapter?.isConnected() ?? false
    return {
      platform,
      configured,
      connected,
      state: connected ? 'connected' : configured ? 'disconnected' : 'disconnected',
      updatedAt: Date.now(),
    }
  }

  private key(workspaceId: string, platform: PlatformType): string {
    return `${workspaceId}:${platform}`
  }
}
