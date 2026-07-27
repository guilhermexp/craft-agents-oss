import { describe, expect, it } from 'bun:test'
import type { SessionEvent } from '@craft-agent/shared/protocol'
import { RPC_NAMESPACES } from '@craft-agent/shared/protocol'
import type { PushTarget } from '@craft-agent/shared/protocol'
import { SessionEventPublisher, type PublisherSession } from './session-event-publisher'

function harness() {
  const calls: Array<{ channel: string; target: PushTarget; payload: unknown[] }> = []
  const publisher = new SessionEventPublisher({ batchIntervalMs: 10_000 })
  publisher.setSink((channel, target, ...payload) => {
    calls.push({ channel, target, payload })
  })
  const session: PublisherSession = { id: 'session-1', workspace: { id: 'workspace-1' } }
  const events = () => calls.map(call => call.payload[0] as SessionEvent)
  return { publisher, session, calls, events }
}

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

  it('scopes every domain operation to the session workspace', () => {
    const { publisher, session, calls } = harness()

    publisher.titleGenerated(session, 'Ship it')

    expect(calls).toEqual([{
      channel: RPC_NAMESPACES.sessions.EVENT,
      target: { to: 'workspace', workspaceId: 'workspace-1' },
      payload: [{ type: 'title_generated', sessionId: 'session-1', title: 'Ship it' }],
    }])
  })

  it('maps boolean polarity onto the paired event types', () => {
    const { publisher, session, events } = harness()

    publisher.flagChanged(session, true)
    publisher.flagChanged(session, false)
    publisher.archiveChanged(session, true)
    publisher.archiveChanged(session, false)
    publisher.shareChanged(session, 'https://viewer/s/abc')
    publisher.shareChanged(session, null)

    expect(events()).toEqual([
      { type: 'session_flagged', sessionId: 'session-1' },
      { type: 'session_unflagged', sessionId: 'session-1' },
      { type: 'session_archived', sessionId: 'session-1' },
      { type: 'session_unarchived', sessionId: 'session-1' },
      { type: 'session_shared', sessionId: 'session-1', sharedUrl: 'https://viewer/s/abc' },
      { type: 'session_unshared', sessionId: 'session-1' },
    ])
  })

  it('mirrors the async-operation flag onto the session it announces', () => {
    const { publisher, session, events } = harness()

    publisher.asyncOperation(session, true)
    expect(session.isAsyncOperationOngoing).toBe(true)

    publisher.asyncOperation(session, false)
    expect(session.isAsyncOperationOngoing).toBe(false)

    expect(events()).toEqual([
      { type: 'async_operation', sessionId: 'session-1', isOngoing: true },
      { type: 'async_operation', sessionId: 'session-1', isOngoing: false },
    ])
  })

  it('renames the mode-manager diagnostics fields onto the wire event', () => {
    const { publisher, session, events } = harness()

    publisher.permissionModeChanged(session, 'allow-all', {
      modeVersion: 3,
      lastChangedAt: '2026-07-26T00:00:00.000Z',
      lastChangedBy: 'user',
      previousPermissionMode: 'ask',
      transitionDisplay: 'Ask -> Allow all',
    })

    expect(events()[0]).toEqual({
      type: 'permission_mode_changed',
      sessionId: 'session-1',
      permissionMode: 'allow-all',
      modeVersion: 3,
      changedBy: 'user',
      changedAt: '2026-07-26T00:00:00.000Z',
      previousPermissionMode: 'ask',
      transitionDisplay: 'Ask -> Allow all',
    })
  })

  it('omits optional event fields the caller did not supply', () => {
    const { publisher, session, events } = harness()

    publisher.info(session, 'Token expired, refreshing session…', { timestamp: 42 })
    publisher.error(session, 'boom')
    publisher.interrupted(session, [])
    publisher.interrupted(session, ['queued text'])

    const [info, error, silentInterrupt, restoringInterrupt] = events()
    expect(Object.keys(info!).sort()).toEqual(['message', 'sessionId', 'timestamp', 'type'])
    expect(Object.keys(error!).sort()).toEqual(['error', 'sessionId', 'type'])
    expect(silentInterrupt).toEqual({ type: 'interrupted', sessionId: 'session-1' })
    expect(restoringInterrupt).toEqual({
      type: 'interrupted',
      sessionId: 'session-1',
      queuedMessages: ['queued text'],
    })
  })

  it('forwards background-task events verbatim, only re-keying the session', () => {
    const { publisher, session, events } = harness()

    publisher.forwardBackgroundTaskEvent(session, {
      type: 'task_backgrounded',
      toolUseId: 'toolu_1',
      taskId: 'wf_run_1',
      intent: 'Analyze codebase',
      turnId: 'turn-1',
      kind: 'workflow',
      workflowId: 'wf_1',
    })

    expect(events()[0]).toEqual({
      type: 'task_backgrounded',
      toolUseId: 'toolu_1',
      taskId: 'wf_run_1',
      intent: 'Analyze codebase',
      turnId: 'turn-1',
      kind: 'workflow',
      workflowId: 'wf_1',
      sessionId: 'session-1',
    } as unknown as SessionEvent)
  })

  it('routes workspace and global broadcasts to their own channels', () => {
    const { publisher, calls } = harness()

    publisher.workspaceLabelsChanged('workspace-1')
    publisher.llmConnectionsChanged()
    publisher.sessionFilesChanged('client-9', 'session-1')

    expect(calls).toEqual([
      {
        channel: RPC_NAMESPACES.labels.CHANGED,
        target: { to: 'workspace', workspaceId: 'workspace-1' },
        payload: ['workspace-1'],
      },
      { channel: RPC_NAMESPACES.llmConnections.CHANGED, target: { to: 'all' }, payload: [] },
      {
        channel: RPC_NAMESPACES.sessions.FILES_CHANGED,
        target: { to: 'client', clientId: 'client-9' },
        payload: ['session-1'],
      },
    ])
  })

  it('reports sink attachment so callers can skip broadcasts before startup', () => {
    const publisher = new SessionEventPublisher()
    expect(publisher.hasSink()).toBe(false)
    publisher.setSink(() => {})
    expect(publisher.hasSink()).toBe(true)
  })
})
