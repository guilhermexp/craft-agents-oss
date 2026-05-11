import { describe, expect, it } from 'bun:test'
import type { Session } from '@craft-agent/shared/protocol'
import { SessionLifecycleManager } from './session-lifecycle-manager'

describe('SessionLifecycleManager', () => {
  it('delegates lifecycle operations through an explicit domain boundary', async () => {
    const calls: string[] = []
    const lifecycle = new SessionLifecycleManager({
      initialize: async () => { calls.push('initialize') },
      createSession: async (workspaceId) => {
        calls.push(`create:${workspaceId}`)
        return { id: 'session-1', workspaceId } as Session
      },
      getSession: async (sessionId) => {
        calls.push(`get:${sessionId}`)
        return null
      },
      getSessions: () => {
        calls.push('list')
        return []
      },
      sendMessage: async (sessionId, message) => { calls.push(`send:${sessionId}:${message}`) },
      cancelProcessing: async (sessionId) => { calls.push(`cancel:${sessionId}`) },
      rollbackToMessage: async (sessionId, messageId) => { calls.push(`rollback:${sessionId}:${messageId}`) },
      deleteSession: async (sessionId) => { calls.push(`delete:${sessionId}`) },
      exportSession: async (sessionId) => {
        calls.push(`export:${sessionId}`)
        return null
      },
      importSession: async (workspaceId) => {
        calls.push(`import:${workspaceId}`)
        return { sessionId: 'session-1' }
      },
    })

    await lifecycle.initialize()
    await lifecycle.createSession('workspace-1')
    lifecycle.getSessions()
    await lifecycle.getSession('session-1')
    await lifecycle.sendMessage('session-1', 'hello')
    await lifecycle.cancelProcessing('session-1')
    await lifecycle.rollbackToMessage('session-1', 'message-1', true)
    await lifecycle.deleteSession('session-1')
    await lifecycle.exportSession('session-1', 'workspace-1')
    await lifecycle.importSession('workspace-1', { version: 1 } as never, 'copy' as never)

    expect(calls).toEqual([
      'initialize',
      'create:workspace-1',
      'list',
      'get:session-1',
      'send:session-1:hello',
      'cancel:session-1',
      'rollback:session-1:message-1',
      'delete:session-1',
      'export:session-1',
      'import:workspace-1',
    ])
  })
})
