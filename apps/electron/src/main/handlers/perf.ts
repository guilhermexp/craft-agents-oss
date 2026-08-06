import { RPC_NAMESPACES } from '@craft-agent/shared/protocol'
import type { RpcServer } from '@craft-agent/server-core/transport'
import { MainPerfSampler } from '../perf/main-perf-sampler'

/**
 * The single main-process sampler. Module-level (like `auto-update.ts`'s sink)
 * so `cleanupClientResources` in `main/index.ts` can drop a disconnected
 * client's subscription without threading the instance through HandlerDeps.
 */
let sampler: MainPerfSampler | null = null

export function registerPerfHandlers(server: RpcServer): void {
  sampler = new MainPerfSampler(() => server.push.bind(server))

  server.handle(RPC_NAMESPACES.perf.SUBSCRIBE, async (ctx) => {
    sampler?.subscribe(ctx.clientId)
  })

  server.handle(RPC_NAMESPACES.perf.UNSUBSCRIBE, async (ctx) => {
    sampler?.unsubscribe(ctx.clientId)
  })
}

/** Called from the transport's per-client teardown when a window goes away. */
export function cleanupPerfClient(clientId: string): void {
  sampler?.cleanupClient(clientId)
}
