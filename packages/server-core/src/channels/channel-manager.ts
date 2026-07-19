import { RPC_NAMESPACES } from '@craft-agent/shared/protocol'
import type { WarRoomChannel, WarRoomDispatch } from '@craft-agent/shared/channels'
import { getWorkspaceByNameOrId } from '@craft-agent/shared/config'
import { pushTyped, type RpcServer } from '@craft-agent/server-core/transport'
import type { HandlerDeps } from '../handlers/handler-deps'
import { createChannelOrchestrator, resolveChannelTargets, type ChannelOrchestrator } from './channel-orchestrator'
import { isTerminalKanbanStatus, listKanbanTasksByIds, listKanbanTasksCreatedSince } from './hermes-kanban'
import { createChannelDispatch, listChannelDispatches, updateChannelDispatch } from '@craft-agent/shared/channels/dispatches'
import { getChannelParticipantSession, setChannelParticipantSession } from '@craft-agent/shared/channels/session-bindings'
import { loadChannelKanbanWatch, saveChannelKanbanWatch } from '@craft-agent/shared/channels/kanban-watches'
import { mergeSessionScopedToolCallbacks } from '@craft-agent/shared/agent/session-scoped-tools'
import type { ChannelDispatchRequest, ChannelDispatchResult } from '@craft-agent/session-tools-core'

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
  private bootedWorkspaces = new Set<string>()

  constructor(
    private readonly server: RpcServer,
    private readonly deps: HandlerDeps,
  ) {}

  async list(workspaceId: string): Promise<WarRoomChannel[]> {
    const workspace = getWorkspaceByNameOrId(workspaceId)
    if (!workspace) throw new Error('Workspace not found')
    await this.ensureWorkspaceBooted(workspaceId, workspace.rootPath)

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
    await this.ensureWorkspaceBooted(workspaceId, workspace.rootPath)

    const { listChannels } = await import('@craft-agent/shared/channels/storage')
    const channel = listChannels(workspace.rootPath).find(item => item.id === channelId)
    if (!channel) throw new Error(`Channel '${channelId}' not found`)

    const { listChannelMessages } = await import('@craft-agent/shared/channels/messages')
    return listChannelMessages(workspace.rootPath, channelId)
  }

  async listDispatches(workspaceId: string, channelId: string): Promise<WarRoomDispatch[]> {
    const workspace = getWorkspaceByNameOrId(workspaceId)
    if (!workspace) throw new Error('Workspace not found')
    await this.ensureWorkspaceBooted(workspaceId, workspace.rootPath)

    const { listChannels } = await import('@craft-agent/shared/channels/storage')
    const channel = listChannels(workspace.rootPath).find(item => item.id === channelId)
    if (!channel) throw new Error(`Channel '${channelId}' not found`)

    return listChannelDispatches(workspace.rootPath, channelId)
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
    dispatches: WarRoomDispatch[]
  }> {
    const workspace = getWorkspaceByNameOrId(workspaceId)
    if (!workspace) throw new Error('Workspace not found')
    await this.ensureWorkspaceBooted(workspaceId, workspace.rootPath)

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
    const targets = resolveChannelTargets(channel, text, input.mentionedParticipantIds)
    const message = appendChannelMessage(workspace.rootPath, {
      channelId: channel.id,
      authorType: 'user',
      authorId: input.authorId ?? 'human',
      text,
      tagged: targets.participants.map(participant => participant.id),
    })
    const turnStartUnix = Math.floor(Date.now() / 1000) - 1
    const result = await this.getOrchestrator(workspaceId, channel.id, workspace.rootPath).sendMessage({
      channel,
      text,
      authorId: input.authorId ?? 'human',
      mentionedParticipantIds: input.mentionedParticipantIds,
      recentMessages,
      sourceMessageId: message.id,
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
      dispatches: result.dispatches,
    }
  }

  private orchestratorKey(workspaceId: string, channelId: string): string {
    return `${workspaceId}:${channelId}`
  }

  /**
   * Runs once per workspace on first use (not in the constructor, which can't be async):
   * fails dispatches left `queued`/`running` by a previous process, and re-arms Kanban
   * watchers from their persisted watch lists.
   */
  private async ensureWorkspaceBooted(workspaceId: string, workspaceRootPath: string): Promise<void> {
    if (this.bootedWorkspaces.has(workspaceId)) return
    this.bootedWorkspaces.add(workspaceId)

    const { listChannels } = await import('@craft-agent/shared/channels/storage')
    const channels = listChannels(workspaceRootPath)

    for (const channel of channels) {
      this.reconcileOrphanedDispatches(workspaceRootPath, channel.id)

      const taskIds = loadChannelKanbanWatch(workspaceRootPath, channel.id)
      if (taskIds.length > 0) {
        this.watchKanbanTasks({ workspaceId, workspaceRootPath, channel, taskIds })
      }
    }

    await this.pollWatchedKanbanTasks()
  }

  private reconcileOrphanedDispatches(workspaceRootPath: string, channelId: string): void {
    const dispatches = listChannelDispatches(workspaceRootPath, channelId)
    for (const dispatch of dispatches) {
      if (dispatch.status === 'queued' || dispatch.status === 'running') {
        updateChannelDispatch(workspaceRootPath, channelId, dispatch.id, {
          status: 'failed',
          error: 'App restarted before this dispatch completed',
        })
      }
    }
  }

  async dispatchFromSession(
    workspaceId: string,
    input: ChannelDispatchRequest & { sourceSessionId: string; inferredChannelId?: string },
  ): Promise<ChannelDispatchResult> {
    const workspace = getWorkspaceByNameOrId(workspaceId)
    if (!workspace) throw new Error('Workspace not found')
    await this.ensureWorkspaceBooted(workspaceId, workspace.rootPath)

    const channelId = input.channelId ?? input.inferredChannelId
    if (!channelId) throw new Error('channel_dispatch requires channelId when the current session is not bound to a channel')
    if (input.channelId && input.inferredChannelId && input.channelId !== input.inferredChannelId) {
      throw new Error(`channel_dispatch can only target the current channel (${input.inferredChannelId}) from this session`)
    }

    const text = input.message.trim()
    if (!text) throw new Error('channel_dispatch message is required')

    const { listChannels } = await import('@craft-agent/shared/channels/storage')
    const channel = listChannels(workspace.rootPath).find(item => item.id === channelId)
    if (!channel) throw new Error(`Channel '${channelId}' not found`)

    const participant = (channel.participants ?? []).find(item => item.id === input.participantId)
    if (!participant) throw new Error(`Participant '${input.participantId}' not found in channel '${channelId}'`)

    const { appendChannelMessage, listChannelMessages } = await import('@craft-agent/shared/channels/messages')
    const recentMessages = listChannelMessages(workspace.rootPath, channel.id).map(message => ({
      authorId: message.authorId,
      text: message.text,
    }))
    const sourceMessage = appendChannelMessage(workspace.rootPath, {
      channelId: channel.id,
      authorType: 'system',
      authorId: 'channel-dispatch',
      text: `Dispatch to @${participant.id}:\n${text}`,
      tagged: [participant.id],
      sourceSessionId: input.sourceSessionId,
      replyToMessageId: input.parentMessageId,
    })

    const result = await this.getOrchestrator(workspaceId, channel.id, workspace.rootPath).dispatchToParticipant({
      channel,
      participantId: participant.id,
      text,
      recentMessages,
      sourceMessageId: sourceMessage.id,
      parentMessageId: input.parentMessageId,
      sourceSessionId: input.sourceSessionId,
    })

    for (const agentMessage of result.agentMessages) {
      appendChannelMessage(workspace.rootPath, {
        channelId: channel.id,
        authorType: 'agent',
        authorId: agentMessage.participantId,
        text: agentMessage.text,
        sourceSessionId: agentMessage.sessionId,
        replyToMessageId: sourceMessage.id,
      })
    }

    this.pushMessagesChanged(workspaceId, channel.id)

    const dispatch = result.dispatches[0]
    if (!dispatch) {
      const failure = result.failures[0]
      throw new Error(failure?.message ?? 'channel_dispatch did not create a dispatch')
    }

    return {
      dispatchId: dispatch.id,
      channelId: dispatch.channelId,
      participantId: dispatch.participantId,
      status: dispatch.status,
      ...(dispatch.error ? { error: dispatch.error } : {}),
    }
  }

  private getOrchestrator(workspaceId: string, channelId: string, workspaceRootPath: string): ChannelOrchestrator {
    const key = this.orchestratorKey(workspaceId, channelId)
    const existing = this.orchestrators.get(key)
    if (existing) return existing

    const deps = this.deps
    const manager = this
    const orchestrator = createChannelOrchestrator({
      dispatchStore: {
        create(input) {
          return createChannelDispatch(workspaceRootPath, input)
        },
        update(dispatchId, updates) {
          return updateChannelDispatch(workspaceRootPath, channelId, dispatchId, updates)
        },
      },
      sessionBindingStore: {
        get(boundChannelId, participantId) {
          return getChannelParticipantSession(workspaceRootPath, boundChannelId, participantId)
        },
        set(boundChannelId, participantId, sessionId) {
          setChannelParticipantSession(workspaceRootPath, boundChannelId, participantId, sessionId)
        },
      },
      runtime: {
        async sessionExists(sessionId) {
          return (await deps.sessionManager.getSession(sessionId)) !== null
        },
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
          mergeSessionScopedToolCallbacks(session.id, {
            channelDispatchFn: (request) => manager.dispatchFromSession(workspaceId, {
              ...request,
              sourceSessionId: session.id,
              inferredChannelId: channelId,
            }),
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
    let taskIds: Set<string>
    if (existing) {
      for (const taskId of input.taskIds) existing.taskIds.add(taskId)
      taskIds = existing.taskIds
    } else {
      taskIds = new Set(input.taskIds)
      this.watchedKanbanTasks.set(key, {
        workspaceId: input.workspaceId,
        workspaceRootPath: input.workspaceRootPath,
        channel: input.channel,
        taskIds,
      })
    }
    saveChannelKanbanWatch(input.workspaceRootPath, input.channel.id, [...taskIds])

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
      saveChannelKanbanWatch(watched.workspaceRootPath, watched.channel.id, [...watched.taskIds])
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

      const result = await this.getOrchestrator(watched.workspaceId, watched.channel.id, watched.workspaceRootPath).sendTaskUpdate({
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
