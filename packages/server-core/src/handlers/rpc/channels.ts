import { RPC_NAMESPACES } from '@craft-agent/shared/protocol'
import { getWorkspaceByNameOrId } from '@craft-agent/shared/config'
import { pushTyped, type RpcServer } from '@craft-agent/server-core/transport'
import type { HandlerDeps } from '../handler-deps'
import { createChannelOrchestrator, type ChannelOrchestrator } from '../../channels/channel-orchestrator'
import { isTerminalKanbanStatus, listKanbanTasksByIds, listKanbanTasksCreatedSince } from '../../channels/hermes-kanban'
import type { WarRoomChannel } from '@craft-agent/shared/channels'

export const HANDLED_CHANNELS = [
  RPC_NAMESPACES.channels.LIST,
  RPC_NAMESPACES.channels.CREATE,
  RPC_NAMESPACES.channels.UPDATE,
  RPC_NAMESPACES.channels.DELETE,
  RPC_NAMESPACES.channels.LIST_MESSAGES,
  RPC_NAMESPACES.channels.SEND_MESSAGE,
] as const

const orchestrators = new Map<string, ChannelOrchestrator>()
const watchedKanbanTasks = new Map<string, {
  workspaceId: string
  workspaceRootPath: string
  channel: WarRoomChannel
  taskIds: Set<string>
  deps: HandlerDeps
  server: RpcServer
}>()
let kanbanWatchTimer: ReturnType<typeof setInterval> | null = null

function orchestratorKey(workspaceId: string, channelId: string): string {
  return `${workspaceId}:${channelId}`
}

function getOrchestrator(deps: HandlerDeps, workspaceId: string, channelId: string): ChannelOrchestrator {
  const key = orchestratorKey(workspaceId, channelId)
  const existing = orchestrators.get(key)
  if (existing) return existing

  const orchestrator = createChannelOrchestrator({
    runtime: {
      async createSession(input) {
        const session = await deps.sessionManager.createSession(workspaceId, {
          name: input.name,
          labels: input.labels,
          llmConnection: input.llmConnection,
          model: input.model,
          hermesProfile: input.hermesProfile,
          enabledSourceSlugs: input.enabledSourceSlugs,
          permissionMode: input.permissionMode,
          workingDirectory: input.workingDirectory,
        })
        return { id: session.id }
      },
      async sendMessage(input) {
        const before = await deps.sessionManager.getSession(input.sessionId)
        const previousMessageIds = new Set((before?.messages ?? []).map(message => message.id))
        await deps.sessionManager.sendMessage(input.sessionId, input.message)
        const after = await deps.sessionManager.getSession(input.sessionId)
        const assistant = (after?.messages ?? [])
          .filter(message => !previousMessageIds.has(message.id))
          .reverse()
          .find(message => message.role === 'assistant' && !message.isIntermediate && message.content.trim().length > 0)
        return { assistantText: assistant?.content }
      },
    },
  })
  orchestrators.set(key, orchestrator)
  return orchestrator
}

function channelKanbanAssignees(channel: WarRoomChannel): Set<string> {
  return new Set((channel.participants ?? [])
    .filter(participant => participant.llmConnection === 'hermes')
    .map(participant => participant.hermesProfile ?? participant.id))
}

function participantIdForKanbanAssignee(channel: WarRoomChannel, assignee: string | null): string | null {
  if (!assignee) return null
  const participant = (channel.participants ?? []).find(item => (
    item.id === assignee || (item.llmConnection === 'hermes' && item.hermesProfile === assignee)
  ))
  return participant?.id ?? assignee
}

function watchKanbanTasks(input: {
  workspaceId: string
  workspaceRootPath: string
  channel: WarRoomChannel
  taskIds: string[]
  deps: HandlerDeps
  server: RpcServer
}): void {
  if (input.taskIds.length === 0) return
  const key = orchestratorKey(input.workspaceId, input.channel.id)
  const existing = watchedKanbanTasks.get(key)
  if (existing) {
    for (const taskId of input.taskIds) existing.taskIds.add(taskId)
  } else {
    watchedKanbanTasks.set(key, {
      workspaceId: input.workspaceId,
      workspaceRootPath: input.workspaceRootPath,
      channel: input.channel,
      taskIds: new Set(input.taskIds),
      deps: input.deps,
      server: input.server,
    })
  }

  if (kanbanWatchTimer) return
  kanbanWatchTimer = setInterval(() => {
    void pollWatchedKanbanTasks()
  }, 5000)
  kanbanWatchTimer.unref?.()
}

async function pollWatchedKanbanTasks(): Promise<void> {
  if (watchedKanbanTasks.size === 0) {
    if (kanbanWatchTimer) clearInterval(kanbanWatchTimer)
    kanbanWatchTimer = null
    return
  }

  for (const [key, watched] of watchedKanbanTasks) {
    const tasks = listKanbanTasksByIds([...watched.taskIds])
    const terminalTasks = tasks.filter(task => isTerminalKanbanStatus(task.status))
    if (terminalTasks.length === 0) continue

    for (const task of terminalTasks) watched.taskIds.delete(task.id)
    if (watched.taskIds.size === 0) watchedKanbanTasks.delete(key)

    const { appendChannelMessage, listChannelMessages } = await import('@craft-agent/shared/channels/messages')
    const visible = terminalTasks.map(task => (
      `${task.id} (${task.assignee ?? 'unassigned'}) ${task.status}: ${task.title}`
    )).join('\n')

    appendChannelMessage(watched.workspaceRootPath, {
      channelId: watched.channel.id,
      authorType: 'system',
      authorId: 'hermes-kanban',
      text: `Hermes Kanban update:\n${visible}`,
      tagged: terminalTasks
        .map(task => participantIdForKanbanAssignee(watched.channel, task.assignee))
        .filter((participantId): participantId is string => typeof participantId === 'string'),
    })

    const recentMessages = listChannelMessages(watched.workspaceRootPath, watched.channel.id).map(message => ({
      authorId: message.authorId,
      text: message.text,
    }))

    const result = await getOrchestrator(watched.deps, watched.workspaceId, watched.channel.id).sendTaskUpdate({
      channel: watched.channel,
      tasks: terminalTasks,
      recentMessages,
    })

    for (const agentMessage of result.agentMessages) {
      appendChannelMessage(watched.workspaceRootPath, {
        channelId: watched.channel.id,
        authorType: 'agent',
        authorId: agentMessage.participantId,
        text: agentMessage.text,
        sourceSessionId: agentMessage.sessionId,
      })
    }

    pushTyped(watched.server, RPC_NAMESPACES.channels.MESSAGES_CHANGED, { to: 'workspace', workspaceId: watched.workspaceId }, watched.workspaceId, watched.channel.id)
  }
}

export function registerChannelsHandlers(server: RpcServer, deps: HandlerDeps): void {
  server.handle(RPC_NAMESPACES.channels.LIST, async (_ctx, workspaceId: string) => {
    const workspace = getWorkspaceByNameOrId(workspaceId)
    if (!workspace) throw new Error('Workspace not found')

    const { listChannels } = await import('@craft-agent/shared/channels/storage')
    return listChannels(workspace.rootPath)
  })

  server.handle(RPC_NAMESPACES.channels.CREATE, async (_ctx, workspaceId: string, input: import('@craft-agent/shared/channels').CreateWarRoomChannelInput) => {
    const workspace = getWorkspaceByNameOrId(workspaceId)
    if (!workspace) throw new Error('Workspace not found')

    const { createChannel } = await import('@craft-agent/shared/channels/crud')
    const channel = createChannel(workspace.rootPath, input)
    pushTyped(server, RPC_NAMESPACES.channels.CHANGED, { to: 'workspace', workspaceId }, workspaceId)
    pushTyped(server, RPC_NAMESPACES.labels.CHANGED, { to: 'workspace', workspaceId }, workspaceId)
    return channel
  })

  server.handle(RPC_NAMESPACES.channels.UPDATE, async (_ctx, workspaceId: string, channelId: string, updates: import('@craft-agent/shared/channels').UpdateWarRoomChannelInput) => {
    const workspace = getWorkspaceByNameOrId(workspaceId)
    if (!workspace) throw new Error('Workspace not found')

    const { updateChannel } = await import('@craft-agent/shared/channels/crud')
    const channel = updateChannel(workspace.rootPath, channelId, updates)
    pushTyped(server, RPC_NAMESPACES.channels.CHANGED, { to: 'workspace', workspaceId }, workspaceId)
    pushTyped(server, RPC_NAMESPACES.labels.CHANGED, { to: 'workspace', workspaceId }, workspaceId)
    return channel
  })

  server.handle(RPC_NAMESPACES.channels.DELETE, async (
    _ctx,
    workspaceId: string,
    channelId: string,
    options?: import('@craft-agent/shared/channels').DeleteChannelOptions,
  ) => {
    const workspace = getWorkspaceByNameOrId(workspaceId)
    if (!workspace) throw new Error('Workspace not found')

    const { deleteChannel } = await import('@craft-agent/shared/channels/crud')
    const result = deleteChannel(workspace.rootPath, channelId, options)
    pushTyped(server, RPC_NAMESPACES.channels.CHANGED, { to: 'workspace', workspaceId }, workspaceId)
    if (result.labelDeleted) {
      pushTyped(server, RPC_NAMESPACES.labels.CHANGED, { to: 'workspace', workspaceId }, workspaceId)
    }
    return result
  })

  server.handle(RPC_NAMESPACES.channels.LIST_MESSAGES, async (_ctx, workspaceId: string, channelId: string) => {
    const workspace = getWorkspaceByNameOrId(workspaceId)
    if (!workspace) throw new Error('Workspace not found')

    const { listChannels } = await import('@craft-agent/shared/channels/storage')
    const channel = listChannels(workspace.rootPath).find(item => item.id === channelId)
    if (!channel) throw new Error(`Channel '${channelId}' not found`)

    const { listChannelMessages } = await import('@craft-agent/shared/channels/messages')
    return listChannelMessages(workspace.rootPath, channelId)
  })

  server.handle(RPC_NAMESPACES.channels.SEND_MESSAGE, async (
    _ctx,
    workspaceId: string,
    input: {
      channelId: string
      text: string
      authorId?: string
      mentionedParticipantIds?: string[]
    },
  ) => {
    const workspace = getWorkspaceByNameOrId(workspaceId)
    if (!workspace) throw new Error('Workspace not found')

    const text = input.text.trim()
    if (!text) throw new Error('Channel message text is required')

    const { listChannels } = await import('@craft-agent/shared/channels/storage')
    const channel = listChannels(workspace.rootPath).find(item => item.id === input.channelId)
    if (!channel) throw new Error(`Channel '${input.channelId}' not found`)

    const { appendChannelMessage, listChannelMessages } = await import('@craft-agent/shared/channels/messages')
    const recentMessages = listChannelMessages(workspace.rootPath, channel.id).map(message => ({
      authorId: message.authorId,
      text: message.text,
    }))
    const turnStartUnix = Math.floor(Date.now() / 1000) - 1
    const result = await getOrchestrator(deps, workspaceId, channel.id).sendMessage({
      channel,
      text,
      authorId: input.authorId ?? 'human',
      mentionedParticipantIds: input.mentionedParticipantIds,
      recentMessages,
    })

    const message = appendChannelMessage(workspace.rootPath, {
      channelId: channel.id,
      authorType: 'user',
      authorId: input.authorId ?? 'human',
      text,
      tagged: result.targetedParticipantIds,
    })

    for (const agentMessage of result.agentMessages) {
      appendChannelMessage(workspace.rootPath, {
        channelId: channel.id,
        authorType: 'agent',
        authorId: agentMessage.participantId,
        text: agentMessage.text,
        sourceSessionId: agentMessage.sessionId,
        replyToMessageId: message.id,
      })
    }

    const allowedAssignees = channelKanbanAssignees(channel)
    const createdTasks = listKanbanTasksCreatedSince(turnStartUnix)
      .filter(task => task.assignee !== null && allowedAssignees.has(task.assignee))
    if (createdTasks.length > 0) {
      watchKanbanTasks({
        workspaceId,
        workspaceRootPath: workspace.rootPath,
        channel,
        taskIds: createdTasks.map(task => task.id),
        deps,
        server,
      })
    }

    pushTyped(server, RPC_NAMESPACES.channels.MESSAGES_CHANGED, { to: 'workspace', workspaceId }, workspaceId, channel.id)

    return {
      message,
      targetedParticipantIds: result.targetedParticipantIds,
      unknownMentions: result.unknownMentions,
      failures: result.failures,
    }
  })
}
