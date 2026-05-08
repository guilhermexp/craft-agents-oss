import { afterEach, beforeEach, describe, expect, it, mock } from 'bun:test'
import { mkdtempSync, rmSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'

import { RPC_CHANNELS } from '@craft-agent/shared/protocol'
import { createChannel } from '@craft-agent/shared/channels/crud'
import { listChannelMessages } from '@craft-agent/shared/channels/messages'
import { saveLabelConfig } from '@craft-agent/shared/labels/storage'
import type { HandlerFn, RequestContext, RpcServer } from '@craft-agent/server-core/transport'
import type { HandlerDeps } from '../handler-deps'

let workspaceRoot = ''
let previousCraftHermesHome: string | undefined

mock.module('@craft-agent/shared/config', () => ({
  getWorkspaceByNameOrId: (workspaceId: string) => (
    workspaceId === 'ws-1'
      ? { id: 'ws-1', name: 'Test Workspace', rootPath: workspaceRoot }
      : null
  ),
}))

const { registerChannelsHandlers } = await import('./channels')

function createHarness() {
  const handlers = new Map<string, HandlerFn>()
  const pushed: Array<{ channel: string; args: unknown[] }> = []
  const createdSessions: unknown[] = []
  const sentMessages: Array<{ sessionId: string; message: string }> = []
  const sessionMessages = new Map<string, Array<{ id: string; role: 'user' | 'assistant'; content: string; timestamp: number; isIntermediate?: boolean }>>()
  let nextSession = 1

  const server: RpcServer = {
    handle(channel, handler) {
      handlers.set(channel, handler)
    },
    push(channel, _target, ...args) {
      pushed.push({ channel, args })
    },
    async invokeClient() {
      return undefined
    },
  }

  const deps: HandlerDeps = {
    platform: {} as HandlerDeps['platform'],
    oauthFlowStore: {} as HandlerDeps['oauthFlowStore'],
    sessionManager: {
      async createSession(_workspaceId: string, options) {
        createdSessions.push(options ?? {})
        const id = `session-${nextSession++}`
        sessionMessages.set(id, [])
        return { id } as Awaited<ReturnType<HandlerDeps['sessionManager']['createSession']>>
      },
      async getSession(sessionId: string) {
        return {
          id: sessionId,
          messages: sessionMessages.get(sessionId) ?? [],
        } as Awaited<ReturnType<HandlerDeps['sessionManager']['getSession']>>
      },
      async sendMessage(sessionId: string, message: string) {
        sentMessages.push({ sessionId, message })
        const messages = sessionMessages.get(sessionId) ?? []
        messages.push({
          id: `${sessionId}-assistant-${messages.length + 1}`,
          role: 'assistant',
          content: `assistant response for ${sessionId}`,
          timestamp: Date.now(),
        })
        sessionMessages.set(sessionId, messages)
      },
    } as HandlerDeps['sessionManager'],
  }

  registerChannelsHandlers(server, deps)

  const ctx: RequestContext = {
    clientId: 'client-1',
    workspaceId: 'ws-1',
    webContentsId: 1,
  }

  return { handlers, ctx, pushed, createdSessions, sentMessages }
}

beforeEach(() => {
  previousCraftHermesHome = process.env.CRAFT_HERMES_HOME
  workspaceRoot = mkdtempSync(join(tmpdir(), 'craft-channel-rpc-test-'))
  process.env.CRAFT_HERMES_HOME = join(workspaceRoot, 'hermes-home')
  saveLabelConfig(workspaceRoot, { version: 1, labels: [] })
})

afterEach(() => {
  if (previousCraftHermesHome === undefined) {
    delete process.env.CRAFT_HERMES_HOME
  } else {
    process.env.CRAFT_HERMES_HOME = previousCraftHermesHome
  }
  rmSync(workspaceRoot, { recursive: true, force: true })
  workspaceRoot = ''
})

describe('registerChannelsHandlers messages', () => {
  it('stores a channel message and dispatches mentioned participants through sessions', async () => {
    createChannel(workspaceRoot, {
      name: 'Architecture',
      participants: [
        { id: 'hermes-lead', displayName: 'Hermes Lead', llmConnection: 'hermes', hermesProfile: 'lead' },
        { id: 'pi-reviewer', displayName: 'Pi Reviewer', llmConnection: 'pi-copilot', model: 'auto' },
      ],
    })

    const { handlers, ctx, pushed, createdSessions, sentMessages } = createHarness()
    const send = handlers.get(RPC_CHANNELS.channels.SEND_MESSAGE)
    expect(send).toBeDefined()

    const result = await send!(ctx, 'ws-1', {
      channelId: 'architecture',
      text: '@hermes-lead @pi-reviewer revisem esse plano',
    })

    expect(result.targetedParticipantIds).toEqual(['hermes-lead', 'pi-reviewer'])
    expect(createdSessions).toEqual([
      {
        name: 'Architecture / Hermes Lead',
        labels: ['channel-architecture'],
        llmConnection: 'hermes',
        model: undefined,
        hermesProfile: 'lead',
        enabledSourceSlugs: undefined,
        permissionMode: undefined,
        workingDirectory: undefined,
      },
      {
        name: 'Architecture / Pi Reviewer',
        labels: ['channel-architecture'],
        llmConnection: 'pi-copilot',
        model: 'auto',
        hermesProfile: undefined,
        enabledSourceSlugs: undefined,
        permissionMode: undefined,
        workingDirectory: undefined,
      },
    ])
    expect(sentMessages.map(message => message.sessionId)).toEqual(['session-1', 'session-2'])
    expect(listChannelMessages(workspaceRoot, 'architecture')[0]?.tagged).toEqual(['hermes-lead', 'pi-reviewer'])
    expect(listChannelMessages(workspaceRoot, 'architecture').map(message => message.authorType)).toEqual(['user', 'agent', 'agent'])
    expect(pushed.some(event => event.channel === RPC_CHANNELS.channels.MESSAGES_CHANGED)).toBe(true)
  })

  it('routes untagged channel messages through the configured Hermes orchestrator', async () => {
    createChannel(workspaceRoot, {
      name: 'War Room',
      participants: [
        { id: 'lead', displayName: 'Lead', llmConnection: 'hermes', hermesProfile: 'lead' },
        { id: 'server-ops', displayName: 'Server Ops', llmConnection: 'hermes', hermesProfile: 'server-ops' },
      ],
      routing: {
        mode: 'orchestrator',
        leadParticipantId: 'lead',
        allowAllMention: true,
      },
    })

    const { handlers, ctx, createdSessions, sentMessages } = createHarness()
    const result = await handlers.get(RPC_CHANNELS.channels.SEND_MESSAGE)!(ctx, 'ws-1', {
      channelId: 'war-room',
      text: 'cria plano e pede revisão do server-ops',
    })

    expect(result.targetedParticipantIds).toEqual(['lead'])
    expect(createdSessions).toEqual([
      {
        name: 'War Room / Lead',
        labels: ['channel-war-room'],
        llmConnection: 'hermes',
        model: undefined,
        hermesProfile: 'lead',
        enabledSourceSlugs: undefined,
        permissionMode: undefined,
        workingDirectory: undefined,
      },
    ])
    expect(sentMessages[0]?.message).toContain('<<craft-channel-orchestrator hidden-from-user>>')
    expect(sentMessages[0]?.message).toContain('@server-ops')
    expect(sentMessages[0]?.message).toContain('hermes kanban create')
    expect(listChannelMessages(workspaceRoot, 'war-room').map(message => ({
      authorType: message.authorType,
      authorId: message.authorId,
      text: message.text,
    }))).toEqual([
      { authorType: 'user', authorId: 'human', text: 'cria plano e pede revisão do server-ops' },
      { authorType: 'agent', authorId: 'lead', text: 'assistant response for session-1' },
    ])
  })

  it('lists stored channel messages without dispatching new work', async () => {
    createChannel(workspaceRoot, { name: 'Notes' })
    const { handlers, ctx, createdSessions } = createHarness()
    await handlers.get(RPC_CHANNELS.channels.SEND_MESSAGE)!(ctx, 'ws-1', {
      channelId: 'notes',
      text: 'só uma nota',
    })

    const list = handlers.get(RPC_CHANNELS.channels.LIST_MESSAGES)
    const messages = await list!(ctx, 'ws-1', 'notes')

    expect(messages.map((message: { text: string }) => message.text)).toEqual(['só uma nota'])
    expect(createdSessions).toEqual([])
  })
})
