import { RPC_NAMESPACES } from '@craft-agent/shared/protocol'
import type { WarRoomChannel } from '@craft-agent/shared/channels'
import { getWorkspaceByNameOrId } from '@craft-agent/shared/config'
import { pushTyped, type RpcServer } from '@craft-agent/server-core/transport'
import type { HandlerDeps } from '../handlers/handler-deps'
import { createChannelOrchestrator, type ChannelOrchestrator } from './channel-orchestrator'
import { isTerminalKanbanStatus, listKanbanTasksByIds, listKanbanTasksCreatedSince } from './hermes-kanban'

interface WatchedKanbanTasks {
  workspaceId: string
  workspaceRootPath: string
  channel: WarRoomChannel
  taskIds: Set<string>
}

export class ChannelManager {
  private orchestrators = new Map<string, ChannelOrchestrator>()
  private watchedKanbanTasks = new Map<string, WatchedKanbanTasks>()
  private kanbanWatchTimer: ReturnType<typeof setInterval> | null = null

  constructor(
    private readonly server: RpcServer,
    private readonly deps: HandlerDeps,
  ) {}

  async list(workspaceId: string): Promise<WarRoomChannel[]> {
    const workspace = getWorkspaceByNameOrId(workspaceId)
    if (!workspace) throw new Error('Workspace not found')

    const { listChannels } = await import('@craft-agent/shared/channels/storage')
    return listChannels(workspace.rootPath)
  }

  async create(workspaceId: string, input: import('@craft-agent/shared/channels').CreateWarRoomChannelInput): Promise<WarRoomChannel> {
    const workspace = getWorkspaceByNameOrId(workspaceId)
    if (!workspace) throw new Error('Workspace not found')

    const { createChannel } = await import('@craft-agent/shared/channels/crud')
    const channel = createChannel(workspace.rootPath, input)
    this.pushChannelsChanged(workspaceId)
    pushTyped(this.server, RPC_NAMESPACES.labels.CHANGED, { to: 'workspace', workspaceId }, workspaceId)
    return channel
  }

  async update(workspaceId: string, channelId: string, updates: import('@craft-agent/shared/channels').UpdateWarRoomChannelInput): Promise<WarRoomChannel> {
    const workspace = getWorkspaceByNameOrId(workspaceId)
    if (!workspace) throw new Error('Workspace not found')

    const { updateChannel } = await import('@craft-agent/shared/channels/crud')
    const channel = updateChannel(workspace.rootPath, channelId, updates)
    this.pushChannelsChanged(workspaceId)
    pushTyped(this.server, RPC_NAMESPACES.labels.CHANGED, { to: 'workspace', workspaceId }, workspaceId)
    return channel
  }

  async delete(workspaceId: string, channelId: string, options?: import('@craft-agent/shared/channels').DeleteChannelOptions): Promise<ReturnType<typeof import('@craft-agent/shared/channels/crud').deleteChannel>> {
    const workspace = getWorkspaceByNameOrId(workspaceId)
    if (!workspace) throw new Error('Workspace not found')

    const { deleteChannel } = await import('@craft-agent/shared/channels/crud')
    const result = deleteChannel(workspace.rootPath, channelId, options)
    this.pushChannelsChanged(workspaceId)
    if (result.labelDeleted) {
      pushTyped(this.server, RPC_NAMESPACES.labels.CHANGED, { to: 'workspace', workspaceId }, workspaceId)
    }
    return result
  }

  async listMessages(workspaceId: string, channelId: string): Promise<ReturnType<typeof import('@craft-agent/shared/channels/messages').listChannelMessages>> {
    const workspace = getWorkspaceByNameOrId(workspaceId)
    if (!workspace) throw new Error('Workspace not found')

    const { listChannels } = await import('@craft-agent/shared/channels/storage')
    const channel = listChannels(workspace.rootPath).find(item => item.id === channelId)
    if (!channel) throw new Error(`Channel '${channelId}' not found`)

    const { listChannelMessages } = await import('@craft-agent/shared/channels/messages')
    return listChannelMessages(workspace.rootPath, channelId)
  }

  async sendMessage(
    workspaceId: string,
    input: {
      channelId: string
      text: string
      authorId?: string
      mentionedParticipantIds?: string[]
    },
  ): Promise<{
    message: ReturnType<typeof import('@craft-agent/shared/channels/messages').appendChannelMessage>
    targetedParticipantIds: string[]
    unknownMentions: string[]
    failures: Array<{ participantId: string; message: string }>
  }> {
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
    const result = await this.getOrchestrator(workspaceId, channel.id).sendMessage({
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

    const allowedAssignees = this.channelKanbanAssignees(channel)
    const createdTasks = listKanbanTasksCreatedSince(turnStartUnix)
      .filter(task => task.assignee !== null && allowedAssignees.has(task.assignee))
    if (createdTasks.length > 0) {
      this.watchKanbanTasks({
        workspaceId,
        workspaceRootPath: workspace.rootPath,
        channel,
        taskIds: createdTasks.map(task => task.id),
      })
    }

    this.pushMessagesChanged(workspaceId, channel.id)

    return {
      message,
      targetedParticipantIds: result.targetedParticipantIds,
      unknownMentions: result.unknownMentions,
      failures: result.failures,
    }
  }

  private orchestratorKey(workspaceId: string, channelId: string): string {
    return `${workspaceId}:${channelId}`
  }

  private getOrchestrator(workspaceId: string, channelId: string): ChannelOrchestrator {
    const key = this.orchestratorKey(workspaceId, channelId)
    const existing = this.orchestrators.get(key)
    if (existing) return existing

    const deps = this.deps
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
    this.orchestrators.set(key, orchestrator)
    return orchestrator
  }

  private channelKanbanAssignees(channel: WarRoomChannel): Set<string> {
    return new Set((channel.participants ?? [])
      .filter(participant => participant.llmConnection === 'hermes')
      .map(participant => participant.hermesProfile ?? participant.id))
  }

  private participantIdForKanbanAssignee(channel: WarRoomChannel, assignee: string | null): string | null {
    if (!assignee) return null
    const participant = (channel.participants ?? []).find(item => (
      item.id === assignee || (item.llmConnection === 'hermes' && item.hermesProfile === assignee)
    ))
    return participant?.id ?? assignee
  }

  private watchKanbanTasks(input: {
    workspaceId: string
    workspaceRootPath: string
    channel: WarRoomChannel
    taskIds: string[]
  }): void {
    if (input.taskIds.length === 0) return
    const key = this.orchestratorKey(input.workspaceId, input.channel.id)
    const existing = this.watchedKanbanTasks.get(key)
    if (existing) {
      for (const taskId of input.taskIds) existing.taskIds.add(taskId)
    } else {
      this.watchedKanbanTasks.set(key, {
        workspaceId: input.workspaceId,
        workspaceRootPath: input.workspaceRootPath,
        channel: input.channel,
        taskIds: new Set(input.taskIds),
      })
    }

    if (this.kanbanWatchTimer) return
    this.kanbanWatchTimer = setInterval(() => {
      void this.pollWatchedKanbanTasks()
    }, 5000)
    this.kanbanWatchTimer.unref?.()
  }

  private async pollWatchedKanbanTasks(): Promise<void> {
    if (this.watchedKanbanTasks.size === 0) {
      if (this.kanbanWatchTimer) clearInterval(this.kanbanWatchTimer)
      this.kanbanWatchTimer = null
      return
    }

    for (const [key, watched] of this.watchedKanbanTasks) {
      const tasks = listKanbanTasksByIds([...watched.taskIds])
      const terminalTasks = tasks.filter(task => isTerminalKanbanStatus(task.status))
      if (terminalTasks.length === 0) continue

      for (const task of terminalTasks) watched.taskIds.delete(task.id)
      if (watched.taskIds.size === 0) this.watchedKanbanTasks.delete(key)

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
          .map(task => this.participantIdForKanbanAssignee(watched.channel, task.assignee))
          .filter((participantId): participantId is string => typeof participantId === 'string'),
      })

      const recentMessages = listChannelMessages(watched.workspaceRootPath, watched.channel.id).map(message => ({
        authorId: message.authorId,
        text: message.text,
      }))

      const result = await this.getOrchestrator(watched.workspaceId, watched.channel.id).sendTaskUpdate({
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

      this.pushMessagesChanged(watched.workspaceId, watched.channel.id)
    }
  }

  private pushChannelsChanged(workspaceId: string): void {
    pushTyped(this.server, RPC_NAMESPACES.channels.CHANGED, { to: 'workspace', workspaceId }, workspaceId)
  }

  private pushMessagesChanged(workspaceId: string, channelId: string): void {
    pushTyped(this.server, RPC_NAMESPACES.channels.MESSAGES_CHANGED, { to: 'workspace', workspaceId }, workspaceId, channelId)
  }
}
