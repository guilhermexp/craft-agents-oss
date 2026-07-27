/**
 * Channel map — the ElectronAPI-method → IPC-channel table consumed by
 * buildClientApi().
 *
 * Derived from the single RPC_CONTRACT (see ../shared/types). Every non-local
 * contract leaf contributes one entry; `local` leaves are attached by the
 * preload / web adapter / build-api and never cross this map.
 */

import { RPC_CONTRACT } from '../shared/types'
import type { ChannelMap, ChannelMapEntry } from './build-api'

export const CHANNEL_MAP: ChannelMap = Object.fromEntries(
  Object.entries(RPC_CONTRACT).flatMap(([api, leaf]): Array<[string, ChannelMapEntry]> => {
    if (leaf.kind === 'local') return []
    const entry: ChannelMapEntry =
      leaf.kind === 'event'
        ? { type: 'listener', channel: leaf.channel }
        : { type: 'invoke', channel: leaf.channel }
    return [[api, entry]]
  }),
)
