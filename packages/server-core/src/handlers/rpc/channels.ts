import { RPC_NAMESPACES } from '@craft-agent/shared/protocol'
import type { RpcServer } from '@craft-agent/server-core/transport'
import type { HandlerDeps } from '../handler-deps'
import { ChannelManager } from '../../channels/channel-manager'

export function registerChannelsHandlers(server: RpcServer, deps: HandlerDeps): void {
  const channelManager = new ChannelManager(server, deps)

  server.handle(RPC_NAMESPACES.channels.LIST, async (_ctx, workspaceId: string) => {
    return channelManager.list(workspaceId)
  })

  server.handle(RPC_NAMESPACES.channels.CREATE, async (_ctx, workspaceId: string, input: import('@craft-agent/shared/channels').CreateWarRoomChannelInput) => {
    return channelManager.create(workspaceId, input)
  })

  server.handle(RPC_NAMESPACES.channels.UPDATE, async (_ctx, workspaceId: string, channelId: string, updates: import('@craft-agent/shared/channels').UpdateWarRoomChannelInput) => {
    return channelManager.update(workspaceId, channelId, updates)
  })

  server.handle(RPC_NAMESPACES.channels.DELETE, async (
    _ctx,
    workspaceId: string,
    channelId: string,
    options?: import('@craft-agent/shared/channels').DeleteChannelOptions,
  ) => {
    return channelManager.delete(workspaceId, channelId, options)
  })

  server.handle(RPC_NAMESPACES.channels.LIST_MESSAGES, async (_ctx, workspaceId: string, channelId: string) => {
    return channelManager.listMessages(workspaceId, channelId)
  })

  server.handle(RPC_NAMESPACES.channels.LIST_DISPATCHES, async (_ctx, workspaceId: string, channelId: string) => {
    return channelManager.listDispatches(workspaceId, channelId)
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
    return channelManager.sendMessage(workspaceId, input)
  })
}
