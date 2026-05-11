import { describe, expect, it } from 'bun:test'
import type { SessionEvent } from '@craft-agent/shared/protocol'
import { RPC_NAMESPACES } from '@craft-agent/shared/protocol'
import type { PushTarget } from '@craft-agent/shared/protocol'
import { SessionEventPublisher } from './session-event-publisher'

describe('SessionEventPublisher', () => {
  it('flushes pending deltas before publishing the final event', () => {
    const calls: Array<{ channel: string; target: PushTarget; event: SessionEvent }> = []
    const publisher = new SessionEventPublisher({ batchIntervalMs: 1 })
    publisher.setSink((channel, target, event: SessionEvent) => {
      calls.push({ channel, target, event })
    })

    publisher.queueTextDelta('session-1', 'workspace-1', 'hello ', 'turn-1')
    publisher.queueTextDelta('session-1', 'workspace-1', 'world', 'turn-1')
    publisher.publish({ type: 'complete', sessionId: 'session-1' }, 'workspace-1')

    expect(calls.map(call => call.event.type)).toEqual(['text_delta', 'complete'])
    expect(calls[0]).toMatchObject({
      channel: RPC_NAMESPACES.sessions.EVENT,
      event: { delta: 'hello world', sessionId: 'session-1', turnId: 'turn-1' },
    })
  })

  it('cleans up timers and pending deltas for a deleted session', () => {
    const calls: SessionEvent[] = []
    const publisher = new SessionEventPublisher({ batchIntervalMs: 10_000 })
    publisher.setSink((_channel, _target, event: SessionEvent) => {
      calls.push(event)
    })

    publisher.queueTextDelta('session-1', 'workspace-1', 'stale')
    publisher.cleanupSession('session-1')
    publisher.flushTextDelta('session-1', 'workspace-1')

    expect(calls).toEqual([])
  })
})
