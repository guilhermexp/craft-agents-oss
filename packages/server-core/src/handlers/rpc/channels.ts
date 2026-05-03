import { RPC_CHANNELS } from '@craft-agent/shared/protocol'
import { getWorkspaceByNameOrId } from '@craft-agent/shared/config'
import { pushTyped, type RpcServer } from '@craft-agent/server-core/transport'
import type { HandlerDeps } from '../handler-deps'

export const HANDLED_CHANNELS = [
  RPC_CHANNELS.channels.LIST,
  RPC_CHANNELS.channels.CREATE,
  RPC_CHANNELS.channels.UPDATE,
  RPC_CHANNELS.channels.DELETE,
] as const

export function registerChannelsHandlers(server: RpcServer, _deps: HandlerDeps): void {
  server.handle(RPC_CHANNELS.channels.LIST, async (_ctx, workspaceId: string) => {
    const workspace = getWorkspaceByNameOrId(workspaceId)
    if (!workspace) throw new Error('Workspace not found')

    const { listChannels } = await import('@craft-agent/shared/channels/storage')
    return listChannels(workspace.rootPath)
  })

  server.handle(RPC_CHANNELS.channels.CREATE, async (_ctx, workspaceId: string, input: import('@craft-agent/shared/channels').CreateChannelInput) => {
    const workspace = getWorkspaceByNameOrId(workspaceId)
    if (!workspace) throw new Error('Workspace not found')

    const { createChannel } = await import('@craft-agent/shared/channels/crud')
    const channel = createChannel(workspace.rootPath, input)
    pushTyped(server, RPC_CHANNELS.channels.CHANGED, { to: 'workspace', workspaceId }, workspaceId)
    pushTyped(server, RPC_CHANNELS.labels.CHANGED, { to: 'workspace', workspaceId }, workspaceId)
    return channel
  })

  server.handle(RPC_CHANNELS.channels.UPDATE, async (_ctx, workspaceId: string, channelId: string, updates: import('@craft-agent/shared/channels').UpdateChannelInput) => {
    const workspace = getWorkspaceByNameOrId(workspaceId)
    if (!workspace) throw new Error('Workspace not found')

    const { updateChannel } = await import('@craft-agent/shared/channels/crud')
    const channel = updateChannel(workspace.rootPath, channelId, updates)
    pushTyped(server, RPC_CHANNELS.channels.CHANGED, { to: 'workspace', workspaceId }, workspaceId)
    pushTyped(server, RPC_CHANNELS.labels.CHANGED, { to: 'workspace', workspaceId }, workspaceId)
    return channel
  })

  server.handle(RPC_CHANNELS.channels.DELETE, async (_ctx, workspaceId: string, channelId: string) => {
    const workspace = getWorkspaceByNameOrId(workspaceId)
    if (!workspace) throw new Error('Workspace not found')

    const { deleteChannel } = await import('@craft-agent/shared/channels/crud')
    const result = deleteChannel(workspace.rootPath, channelId)
    pushTyped(server, RPC_CHANNELS.channels.CHANGED, { to: 'workspace', workspaceId }, workspaceId)
    return result
  })
}
