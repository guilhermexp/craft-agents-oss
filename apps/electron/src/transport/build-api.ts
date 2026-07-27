/**
 * Build the client API proxy.
 *
 * Replaces the 329-line preload. The ElectronAPI TypeScript type still enforces
 * types at compile time — this proxy provides runtime dispatch. Both the proxy's
 * CHANNEL_MAP and the ElectronAPI type are derived from the single RPC_CONTRACT.
 */

import { RPC_NAMESPACES } from '@craft-agent/shared/protocol'
import type { SetupNeeds } from '@craft-agent/shared/auth/types'
import type { RpcClient } from '@craft-agent/server-core/transport'
import type { ElectronAPI } from '../shared/types'

// ---------------------------------------------------------------------------
// Channel map entry
// ---------------------------------------------------------------------------

export type ChannelMapEntry =
  | { type: 'invoke'; channel: string }
  | { type: 'listener'; channel: string }

export type ChannelMap = Record<string, ChannelMapEntry>

// ---------------------------------------------------------------------------
// Proxy builder
// ---------------------------------------------------------------------------

export function buildClientApi(
  client: RpcClient,
  channelMap: ChannelMap,
  isChannelAvailable?: (channel: string) => boolean,
): ElectronAPI {
  const api: Record<string, unknown> = {}
  const nested: Record<string, Record<string, unknown>> = {}

  for (const [key, entry] of Object.entries(channelMap)) {
    const fn =
      entry.type === 'listener'
        ? (cb: (...args: unknown[]) => void) => client.on(entry.channel, cb)
        : (...args: unknown[]) => client.invoke(entry.channel, ...args)

    // Dotted keys like "browserPane.create" become nested: api.browserPane.create
    const dotIdx = key.indexOf('.')
    if (dotIdx !== -1) {
      const ns = key.slice(0, dotIdx)
      const method = key.slice(dotIdx + 1)
      if (!nested[ns]) nested[ns] = {}
      nested[ns][method] = fn
    } else {
      api[key] = fn
    }
  }

  // Attach nested namespaces as plain objects
  for (const [ns, methods] of Object.entries(nested)) {
    api[ns] = methods
  }

  // Expose channel availability check for GUI-aware code
  api.isChannelAvailable = isChannelAvailable ?? (() => true)

  // getSetupNeeds is the sole client-side projection of getAuthState's result.
  // It was the only user of the removed CHANNEL_MAP `transform` seam; inlined here.
  api.getSetupNeeds = async (): Promise<SetupNeeds> => {
    // Boundary read: the RPC result carries setupNeeds alongside the auth state.
    const state = await client.invoke(RPC_NAMESPACES.onboarding.GET_AUTH_STATE)
    return (state as { setupNeeds: SetupNeeds }).setupNeeds
  }

  return api as ElectronAPI
}
