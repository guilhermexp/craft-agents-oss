/**
 * Chunked Transfer RPC Handlers
 *
 * Protocol adapter only. Transfer lifecycle, TTL, temp files and target
 * registry live in TransferManager.
 */

import { RPC_NAMESPACES } from '@craft-agent/shared/protocol'
import type { HandlerFn, RpcServer } from '../../transport/types'
import { transferManager } from '../../services/transfer-manager'

export function setTransferableHandler(channel: string, handler: HandlerFn): void {
  transferManager.registerHandler(channel, handler)
}

export function __resetTransferStateForTests(): void {
  transferManager.resetForTests()
}

export function registerTransferHandlers(server: RpcServer): void {
  server.handle(RPC_NAMESPACES.transfer.START, (ctx, opts) => {
    return transferManager.start(ctx, opts)
  })

  server.handle(RPC_NAMESPACES.transfer.CHUNK, (ctx, opts) => {
    return transferManager.chunk(ctx, opts)
  })

  server.handle(RPC_NAMESPACES.transfer.COMMIT, (ctx, opts) => {
    return transferManager.commit(ctx, opts)
  })

  server.handle(RPC_NAMESPACES.transfer.ABORT, (ctx, opts) => {
    return transferManager.abort(ctx, opts)
  })
}
