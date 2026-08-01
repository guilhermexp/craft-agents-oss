import { describe, expect, test } from 'bun:test'
import { WORKSPACE_OBJECT_RPC_CHANNELS } from '@craft-agent/shared/workspace-objects/types'
import { RPC_CONTRACT } from './types'
import { CHANNEL_MAP } from '../transport/channel-map'

describe('workspace object Electron bridge', () => {
  test('materializes invoke and event channels from the typed RPC contract', () => {
    expect(RPC_CONTRACT.listWorkspaceObjects.channel).toBe(WORKSPACE_OBJECT_RPC_CHANNELS.LIST)
    expect(RPC_CONTRACT.executeWorkspaceObjectAction.channel).toBe(WORKSPACE_OBJECT_RPC_CHANNELS.EXECUTE)
    expect(RPC_CONTRACT.onWorkspaceObjectEvent.channel).toBe(WORKSPACE_OBJECT_RPC_CHANNELS.EVENT)
    expect(CHANNEL_MAP.listWorkspaceObjects).toEqual({ type: 'invoke', channel: WORKSPACE_OBJECT_RPC_CHANNELS.LIST })
    expect(CHANNEL_MAP.onWorkspaceObjectEvent).toEqual({ type: 'listener', channel: WORKSPACE_OBJECT_RPC_CHANNELS.EVENT })
  })

  test('keeps preload and server-core registration on the shared bridge', async () => {
    const preload = await Bun.file(new URL('../preload/bootstrap.ts', import.meta.url)).text()
    const handlers = await Bun.file(new URL('../../../../packages/server-core/src/handlers/rpc/index.ts', import.meta.url)).text()
    expect(preload).toContain('buildClientApi(client, CHANNEL_MAP')
    expect(handlers).toContain('registerWorkspaceObjectHandlers(server, deps)')
  })
})
