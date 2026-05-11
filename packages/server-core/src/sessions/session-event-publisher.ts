import type { EventSink } from '@craft-agent/server-core/transport'
import { RPC_NAMESPACES, type SessionEvent } from '@craft-agent/shared/protocol'

interface PendingDelta {
  delta: string
  turnId?: string
}

export interface SessionEventPublisherOptions {
  batchIntervalMs?: number
  warn?: (message: string) => void
}

export class SessionEventPublisher {
  private readonly batchIntervalMs: number
  private readonly warn: (message: string) => void
  private eventSink: EventSink | null = null
  private pendingDeltas = new Map<string, PendingDelta>()
  private deltaFlushTimers = new Map<string, NodeJS.Timeout>()

  constructor(options: SessionEventPublisherOptions = {}) {
    this.batchIntervalMs = options.batchIntervalMs ?? 50
    this.warn = options.warn ?? (() => {})
  }

  setSink(sink: EventSink): void {
    this.eventSink = sink
  }

  getSink(): EventSink | null {
    return this.eventSink
  }

  publish(event: SessionEvent, workspaceId?: string): void {
    if ('sessionId' in event && typeof event.sessionId === 'string') {
      this.flushTextDelta(event.sessionId, workspaceId)
    }

    if (!this.eventSink) {
      this.warn('Cannot send event - no event sink')
      return
    }

    if (!workspaceId) {
      this.warn(`Cannot send ${event.type} event - no workspaceId`)
      return
    }

    this.eventSink(RPC_NAMESPACES.sessions.EVENT, { to: 'workspace', workspaceId }, event)
  }

  publishToClient(clientId: string, event: SessionEvent): void {
    this.eventSink?.(RPC_NAMESPACES.sessions.EVENT, { to: 'client', clientId }, event)
  }

  publishWorkspaceChanged(channel: string, workspaceId: string, ...payload: unknown[]): void {
    this.eventSink?.(channel, { to: 'workspace', workspaceId }, ...payload)
  }

  publishAll(channel: string, ...payload: unknown[]): void {
    this.eventSink?.(channel, { to: 'all' }, ...payload)
  }

  publishClient(channel: string, clientId: string, ...payload: unknown[]): void {
    this.eventSink?.(channel, { to: 'client', clientId }, ...payload)
  }

  queueTextDelta(sessionId: string, workspaceId: string, delta: string, turnId?: string): void {
    const existing = this.pendingDeltas.get(sessionId)
    if (existing) {
      existing.delta += delta
      if (turnId) existing.turnId = turnId
    } else {
      this.pendingDeltas.set(sessionId, { delta, turnId })
    }

    if (!this.deltaFlushTimers.has(sessionId)) {
      const timer = setTimeout(() => {
        this.flushTextDelta(sessionId, workspaceId)
      }, this.batchIntervalMs)
      this.deltaFlushTimers.set(sessionId, timer)
    }
  }

  flushTextDelta(sessionId: string, workspaceId?: string): void {
    const timer = this.deltaFlushTimers.get(sessionId)
    if (timer) {
      clearTimeout(timer)
      this.deltaFlushTimers.delete(sessionId)
    }

    const pending = this.pendingDeltas.get(sessionId)
    if (!pending?.delta) return

    this.pendingDeltas.delete(sessionId)
    this.publish({
      type: 'text_delta',
      sessionId,
      delta: pending.delta,
      turnId: pending.turnId,
    }, workspaceId)
  }

  cleanupSession(sessionId: string): void {
    const timer = this.deltaFlushTimers.get(sessionId)
    if (timer) clearTimeout(timer)
    this.deltaFlushTimers.delete(sessionId)
    this.pendingDeltas.delete(sessionId)
  }

  cleanup(): void {
    for (const timer of this.deltaFlushTimers.values()) {
      clearTimeout(timer)
    }
    this.deltaFlushTimers.clear()
    this.pendingDeltas.clear()
  }
}
