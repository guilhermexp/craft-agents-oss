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
    // The client argument may be a transparent decorator (the perf RPC probe
    // wraps `invoke` to time it). What must not drift is that the API is
    // materialized from the shared CHANNEL_MAP through buildClientApi.
    expect(preload).toMatch(/buildClientApi\(\s*[\w.]+,\s*CHANNEL_MAP/)
    expect(handlers).toContain('registerWorkspaceObjectHandlers(server, deps)')
  })
})
