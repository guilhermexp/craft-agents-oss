/**
 * Per-channel RPC latency probe.
 *
 * Every `window.electronAPI` call is a WebSocket round trip to the main
 * process, so "the panel is slow" is often "the panel is waiting". The probe
 * wraps the single choke point (`buildClientApi`'s client) in the preload,
 * where the timing is honest — a renderer-side wrapper would also be measuring
 * contextBridge marshalling.
 *
 * Results are drained by the renderer through a contextBridge accessor rather
 * than pushed, so nothing crosses the boundary while the overlay is off.
 */

import type { RpcClient } from '@craft-agent/server-core/transport'

/** Distinct channels tracked before new ones are ignored for the window. */
const MAX_CHANNELS = 256

export interface RpcChannelStat {
  channel: string
  calls: number
  totalMs: number
  maxMs: number
  errors: number
}

export interface RpcProbe {
  /** RpcClient facade to hand to `buildClientApi`. */
  readonly client: RpcClient
  /** contextBridge-safe surface exposed to the renderer. */
  readonly bridge: {
    setEnabled(next: boolean): void
    drain(): RpcChannelStat[]
  }
}

export function createRpcProbe(inner: RpcClient): RpcProbe {
  let enabled = false
  const stats = new Map<string, RpcChannelStat>()

  function record(channel: string, startedAt: number, failed: boolean): void {
    const elapsed = performance.now() - startedAt
    let stat = stats.get(channel)
    if (!stat) {
      if (stats.size >= MAX_CHANNELS) return
      stat = { channel, calls: 0, totalMs: 0, maxMs: 0, errors: 0 }
      stats.set(channel, stat)
    }
    stat.calls++
    stat.totalMs += elapsed
    if (elapsed > stat.maxMs) stat.maxMs = elapsed
    if (failed) stat.errors++
  }

  const client: RpcClient = {
    invoke: (channel: string, ...args: unknown[]) => {
      if (!enabled) return inner.invoke(channel, ...args)
      const startedAt = performance.now()
      // A rejected call still consumed wall time the user waited through, so it
      // is timed like any other and counted separately as an error.
      return inner.invoke(channel, ...args).then(
        (value) => {
          record(channel, startedAt, false)
          return value
        },
        (error: unknown) => {
          record(channel, startedAt, true)
          throw error
        },
      )
    },
    on: (channel: string, callback: (...args: unknown[]) => void) => inner.on(channel, callback),
    handleCapability: (name: string, handler: (...args: unknown[]) => unknown) =>
      inner.handleCapability(name, handler),
  }

  return {
    client,
    bridge: {
      setEnabled(next: boolean) {
        if (enabled === next) return
        enabled = next
        stats.clear()
      },
      drain() {
        const out = [...stats.values()]
        stats.clear()
        return out
      },
    },
  }
}
