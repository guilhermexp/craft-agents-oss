import { afterEach, beforeEach, describe, expect, it, mock } from 'bun:test'
import { mkdtempSync, rmSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'

import { RPC_NAMESPACES } from '@craft-agent/shared/protocol'
import { createChannel } from '@craft-agent/shared/channels/crud'
import { createChannelDispatch, listChannelDispatches } from '@craft-agent/shared/channels/dispatches'
import { listChannelMessages } from '@craft-agent/shared/channels/messages'
import { getChannelParticipantSession } from '@craft-agent/shared/channels/session-bindings'
import { loadChannelKanbanWatch } from '@craft-agent/shared/channels/kanban-watches'
import { saveLabelConfig } from '@craft-agent/shared/labels/storage'
import { unregisterSessionScopedToolCallbacks } from '@craft-agent/shared/agent'
import { getSessionScopedToolCallbacks } from '@craft-agent/shared/agent/session-scoped-tools'
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

interface MockKanbanTask {
  id: string
  title: string
  assignee: string | null
  status: string
  result: string | null
  createdAt: number
  completedAt: number | null
}

// `node:sqlite` (used by the real hermes-kanban.ts reader) is not available under
// Bun's runtime, so the boot re-arm test drives the Kanban reader through this
// in-memory fake instead of a real database file.
let mockKanbanTasks: MockKanbanTask[] = []

mock.module('../../channels/hermes-kanban', () => ({
  getHermesKanbanHome: () => '/tmp/mock-hermes-home',
  getHermesKanbanDbPath: () => '/tmp/mock-hermes-home/kanban.db',
  listKanbanTasksCreatedSince: (unixSeconds: number) => mockKanbanTasks.filter(task => task.createdAt > unixSeconds),
  listKanbanTasksByIds: (taskIds: string[]) => mockKanbanTasks.filter(task => taskIds.includes(task.id)),
  isTerminalKanbanStatus: (status: string) => status === 'done' || status === 'blocked' || status === 'archived',
}))

const { registerChannelsHandlers } = await import('./channels')

/**
 * Backs `HandlerDeps['sessionManager']` for a harness. Kept separate from
 * `createHarness` so a restart can be simulated by reusing the same session
 * store (representing durable on-disk session state) across two independently
 * constructed `ChannelManager`/`RpcServer` instances.
 */
function createSessionStore() {
  const createdSessions: unknown[] = []
  const sentMessages: Array<{ sessionId: string; message: string }> = []
  const sessionMessages = new Map<string, Array<{ id: string; role: 'user' | 'assistant'; content: string; timestamp: number; isIntermediate?: boolean }>>()
  const deletedSessionIds = new Set<string>()
  let nextSession = 1

  const sessionManager: HandlerDeps['sessionManager'] = {
    async createSession(_workspaceId: string, options) {
      createdSessions.push(options ?? {})
      const id = `session-${nextSession++}`
      sessionMessages.set(id, [])
      return { id } as Awaited<ReturnType<HandlerDeps['sessionManager']['createSession']>>
    },
    async getSession(sessionId: string) {
      if (deletedSessionIds.has(sessionId) || !sessionMessages.has(sessionId)) return null
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
  } as HandlerDeps['sessionManager']

  return { sessionManager, createdSessions, sentMessages, deletedSessionIds }
}

function createHarness(shared: ReturnType<typeof createSessionStore> = createSessionStore()) {
  const handlers = new Map<string, HandlerFn>()
  const pushed: Array<{ channel: string; args: unknown[] }> = []
  const { createdSessions, sentMessages } = shared

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
    hasClientCapability() {
      return false
    },
    findClientsWithCapability() {
      return []
    },
  }

  const deps: HandlerDeps = {
    platform: {} as HandlerDeps['platform'],
    oauthFlowStore: {} as HandlerDeps['oauthFlowStore'],
    sessionManager: shared.sessionManager,
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
  mockKanbanTasks = []
  for (const sessionId of ['session-1', 'session-2', 'session-3']) unregisterSessionScopedToolCallbacks(sessionId)
})

afterEach(() => {
  for (const sessionId of ['session-1', 'session-2', 'session-3']) unregisterSessionScopedToolCallbacks(sessionId)
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
    const send = handlers.get(RPC_NAMESPACES.channels.SEND_MESSAGE)
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
    expect(pushed.some(event => event.channel === RPC_NAMESPACES.channels.MESSAGES_CHANGED)).toBe(true)
    expect(listChannelDispatches(workspaceRoot, 'architecture').map(dispatch => ({
      participantId: dispatch.participantId,
      status: dispatch.status,
      sourceMessageId: dispatch.sourceMessageId,
    }))).toEqual([
      { participantId: 'hermes-lead', status: 'completed', sourceMessageId: result.message.id },
      { participantId: 'pi-reviewer', status: 'completed', sourceMessageId: result.message.id },
    ])

    const listDispatches = handlers.get(RPC_NAMESPACES.channels.LIST_DISPATCHES)
    const dispatches = await listDispatches!(ctx, 'ws-1', 'architecture')
    expect(dispatches.map((dispatch: { participantId: string; status: string }) => ({
      participantId: dispatch.participantId,
      status: dispatch.status,
    }))).toEqual([
      { participantId: 'hermes-lead', status: 'completed' },
      { participantId: 'pi-reviewer', status: 'completed' },
    ])
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
    const result = await handlers.get(RPC_NAMESPACES.channels.SEND_MESSAGE)!(ctx, 'ws-1', {
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

  it('exposes channel_dispatch on channel participant sessions and routes to the requested participant', async () => {
    createChannel(workspaceRoot, {
      name: 'War Room',
      participants: [
        { id: 'lead', displayName: 'Lead', llmConnection: 'hermes', hermesProfile: 'lead' },
        { id: 'pi-reviewer', displayName: 'Pi Reviewer', llmConnection: 'pi-copilot', model: 'auto' },
      ],
      routing: {
        mode: 'orchestrator',
      },
    })

    const { handlers, ctx, sentMessages } = createHarness()
    await handlers.get(RPC_NAMESPACES.channels.SEND_MESSAGE)!(ctx, 'ws-1', {
      channelId: 'war-room',
      text: 'coordene uma revisão',
    })

    const callback = getSessionScopedToolCallbacks('session-1')?.channelDispatchFn
    expect(callback).toBeDefined()
    const result = await callback!({
      participantId: 'pi-reviewer',
      message: 'revise os riscos do plano',
    })

    expect(result.participantId).toBe('pi-reviewer')
    expect(result.status).toBe('completed')
    expect(sentMessages.map(item => item.sessionId)).toEqual(['session-1', 'session-2'])
    expect(sentMessages[1]?.message).toContain('revise os riscos do plano')
    expect(listChannelMessages(workspaceRoot, 'war-room').map(message => ({
      authorType: message.authorType,
      authorId: message.authorId,
      tagged: message.tagged,
    }))).toEqual([
      { authorType: 'user', authorId: 'human', tagged: ['lead'] },
      { authorType: 'agent', authorId: 'lead', tagged: [] },
      { authorType: 'system', authorId: 'channel-dispatch', tagged: ['pi-reviewer'] },
      { authorType: 'agent', authorId: 'pi-reviewer', tagged: [] },
    ])
  })

  it('lists stored channel messages without dispatching new work', async () => {
    createChannel(workspaceRoot, { name: 'Notes' })
    const { handlers, ctx, createdSessions } = createHarness()
    await handlers.get(RPC_NAMESPACES.channels.SEND_MESSAGE)!(ctx, 'ws-1', {
      channelId: 'notes',
      text: 'só uma nota',
    })

    const list = handlers.get(RPC_NAMESPACES.channels.LIST_MESSAGES)
    const messages = await list!(ctx, 'ws-1', 'notes')

    expect(messages.map((message: { text: string }) => message.text)).toEqual(['só uma nota'])
    expect(createdSessions).toEqual([])
  })
})

describe('ChannelManager durability across a simulated restart (Fase 1)', () => {
  it('reuses a persisted participant session when the backing session still exists', async () => {
    createChannel(workspaceRoot, {
      name: 'Architecture',
      participants: [{ id: 'hermes-lead', displayName: 'Hermes Lead', llmConnection: 'hermes', hermesProfile: 'lead' }],
    })

    const shared = createSessionStore()
    const first = createHarness(shared)
    await first.handlers.get(RPC_NAMESPACES.channels.SEND_MESSAGE)!(first.ctx, 'ws-1', {
      channelId: 'architecture',
      text: '@hermes-lead cria um plano',
    })
    expect(shared.createdSessions).toHaveLength(1)
    expect(getChannelParticipantSession(workspaceRoot, 'architecture', 'hermes-lead')).toBe('session-1')

    // Simulate an app restart: a brand-new ChannelManager/RpcServer over the same
    // workspace root and the same durable session store.
    const second = createHarness(shared)
    await second.handlers.get(RPC_NAMESPACES.channels.SEND_MESSAGE)!(second.ctx, 'ws-1', {
      channelId: 'architecture',
      text: '@hermes-lead continue o plano',
    })

    expect(shared.createdSessions).toHaveLength(1)
    expect(shared.sentMessages.map(message => message.sessionId)).toEqual(['session-1', 'session-1'])
  })

  it('creates and rebinds a new session when a persisted binding session no longer exists', async () => {
    createChannel(workspaceRoot, {
      name: 'Architecture',
      participants: [{ id: 'hermes-lead', displayName: 'Hermes Lead', llmConnection: 'hermes', hermesProfile: 'lead' }],
    })

    const shared = createSessionStore()
    const first = createHarness(shared)
    await first.handlers.get(RPC_NAMESPACES.channels.SEND_MESSAGE)!(first.ctx, 'ws-1', {
      channelId: 'architecture',
      text: '@hermes-lead cria um plano',
    })
    expect(getChannelParticipantSession(workspaceRoot, 'architecture', 'hermes-lead')).toBe('session-1')
    shared.deletedSessionIds.add('session-1')

    const second = createHarness(shared)
    await second.handlers.get(RPC_NAMESPACES.channels.SEND_MESSAGE)!(second.ctx, 'ws-1', {
      channelId: 'architecture',
      text: '@hermes-lead continue o plano',
    })

    expect(shared.createdSessions).toHaveLength(2)
    expect(shared.sentMessages.map(message => message.sessionId)).toEqual(['session-1', 'session-2'])
    expect(getChannelParticipantSession(workspaceRoot, 'architecture', 'hermes-lead')).toBe('session-2')
  })

  it('reconciles dispatches orphaned by a previous process to failed on restart', async () => {
    createChannel(workspaceRoot, {
      name: 'Architecture',
      participants: [{ id: 'hermes-lead', displayName: 'Hermes Lead', llmConnection: 'hermes', hermesProfile: 'lead' }],
    })
    createChannelDispatch(workspaceRoot, {
      channelId: 'architecture',
      participantId: 'hermes-lead',
      sourceMessageId: 'message-orphan',
    })

    const second = createHarness()
    const dispatches = await second.handlers.get(RPC_NAMESPACES.channels.LIST_DISPATCHES)!(second.ctx, 'ws-1', 'architecture')

    expect(dispatches).toHaveLength(1)
    expect(dispatches[0].status).toBe('failed')
    expect(dispatches[0].error).toContain('restart')
  })

  it('re-arms a persisted Kanban watcher on restart and flows an already-terminal task into the channel', async () => {
    createChannel(workspaceRoot, {
      name: 'Architecture',
      participants: [{ id: 'hermes-lead', displayName: 'Hermes Lead', llmConnection: 'hermes', hermesProfile: 'lead' }],
    })

    const futureCreatedAt = Math.floor(Date.now() / 1000) + 60
    mockKanbanTasks.push({
      id: 'task-1',
      title: 'Investigar bug',
      assignee: 'lead',
      status: 'in_progress',
      result: null,
      createdAt: futureCreatedAt,
      completedAt: null,
    })

    const shared = createSessionStore()
    const first = createHarness(shared)
    await first.handlers.get(RPC_NAMESPACES.channels.SEND_MESSAGE)!(first.ctx, 'ws-1', {
      channelId: 'architecture',
      text: '@hermes-lead delega isso pro kanban',
    })

    expect(loadChannelKanbanWatch(workspaceRoot, 'architecture')).toEqual(['task-1'])

    // Task reaches a terminal status while the app is closed.
    const task = mockKanbanTasks.find(item => item.id === 'task-1')!
    task.status = 'done'
    task.completedAt = futureCreatedAt + 5

    const second = createHarness(shared)
    await second.handlers.get(RPC_NAMESPACES.channels.LIST_MESSAGES)!(second.ctx, 'ws-1', 'architecture')

    expect(loadChannelKanbanWatch(workspaceRoot, 'architecture')).toEqual([])
    const messages = listChannelMessages(workspaceRoot, 'architecture')
    expect(messages.some(message => message.authorId === 'hermes-kanban' && message.text.includes('task-1'))).toBe(true)
  })
})
