import { describe, expect, test } from 'bun:test'
import { MessageAdapterRegistry } from './adapter-registry'
import type { MessagingGateway } from './gateway'
import type {
  AdapterCapabilities,
  ButtonPress,
  IncomingMessage,
  PlatformAdapter,
  PlatformConfig,
  PlatformType,
  SentMessage,
} from './types'

const capabilities: AdapterCapabilities = {
  messageEditing: false,
  inlineButtons: false,
  maxButtons: 0,
  maxMessageLength: 4096,
  markdown: 'whatsapp',
  webhookSupport: false,
}

class FakeAdapter implements PlatformAdapter {
  readonly capabilities = capabilities
  initialized = false
  destroyed = false

  constructor(readonly platform: PlatformType) {}

  async initialize(_config: PlatformConfig): Promise<void> {
    this.initialized = true
  }

  async destroy(): Promise<void> {
    this.destroyed = true
  }

  isConnected(): boolean {
    return this.initialized && !this.destroyed
  }

  onMessage(_handler: (msg: IncomingMessage) => Promise<void>): void {}
  onButtonPress(_handler: (press: ButtonPress) => Promise<void>): void {}

  async sendText(messagingChannelId: string, _text: string): Promise<SentMessage> {
    return { platform: this.platform, messagingChannelId, messageId: 'fake-message' }
  }

  async editMessage(_channelId: string, _messageId: string, _text: string): Promise<void> {}

  async sendButtons(messagingChannelId: string): Promise<SentMessage> {
    return { platform: this.platform, messagingChannelId, messageId: 'fake-buttons' }
  }

  async sendTyping(_channelId: string): Promise<void> {}

  async sendFile(messagingChannelId: string): Promise<SentMessage> {
    return { platform: this.platform, messagingChannelId, messageId: 'fake-file' }
  }
}

function makeGateway() {
  const registered: PlatformAdapter[] = []
  const unregistered: PlatformType[] = []
  return {
    registered,
    unregistered,
    gateway: {
      registerAdapter(adapter: PlatformAdapter): void {
        registered.push(adapter)
      },
      async unregisterAdapter(platform: PlatformType): Promise<void> {
        unregistered.push(platform)
        const adapter = registered.find((candidate) => candidate.platform === platform)
        await adapter?.destroy()
      },
    } as unknown as MessagingGateway,
  }
}

describe('MessageAdapterRegistry', () => {
  test('discovers and registers WhatsApp and Telegram factories', () => {
    const registry = new MessageAdapterRegistry()
    registry.registerFactory('whatsapp', () => new FakeAdapter('whatsapp'))
    registry.registerFactory('telegram', () => new FakeAdapter('telegram'))

    expect(registry.hasFactory('whatsapp')).toBe(true)
    expect(registry.hasFactory('telegram')).toBe(true)
    expect(registry.getRegisteredPlatforms().sort()).toEqual(['telegram', 'whatsapp'])
  })

  test('dispatches initialize and destroy through the registry path', async () => {
    const registry = new MessageAdapterRegistry()
    const created = new FakeAdapter('whatsapp')
    const { gateway, registered, unregistered } = makeGateway()
    registry.registerFactory('whatsapp', () => created)

    const adapter = await registry.initializeAdapter({
      workspaceId: 'workspace-1',
      gateway,
      platform: 'whatsapp',
      config: {},
    })

    expect(adapter).toBe(created)
    expect(created.initialized).toBe(true)
    expect(registered).toEqual([created])

    await registry.unregisterAdapter('workspace-1', gateway, 'whatsapp')
    expect(unregistered).toEqual(['whatsapp'])
    expect(created.destroyed).toBe(true)
  })

  test('prevents duplicate active adapters per workspace and platform', async () => {
    const registry = new MessageAdapterRegistry()
    const { gateway } = makeGateway()
    registry.registerFactory('telegram', () => new FakeAdapter('telegram'))

    await registry.initializeAdapter({
      workspaceId: 'workspace-1',
      gateway,
      platform: 'telegram',
      config: {},
    })

    await expect(registry.initializeAdapter({
      workspaceId: 'workspace-1',
      gateway,
      platform: 'telegram',
      config: {},
    })).rejects.toThrow('Adapter already active')
  })

  test('exposes capabilities and runtime for active adapters', async () => {
    const registry = new MessageAdapterRegistry()
    const { gateway } = makeGateway()
    registry.registerFactory('telegram', () => new FakeAdapter('telegram'))

    await registry.initializeAdapter({
      workspaceId: 'workspace-1',
      gateway,
      platform: 'telegram',
      config: {},
    })

    expect(registry.getCapabilities('workspace-1', 'telegram')).toEqual(capabilities)
    expect(registry.getRuntime('workspace-1', 'telegram', true)).toMatchObject({
      platform: 'telegram',
      configured: true,
      connected: true,
      state: 'connected',
    })
  })
})
