import { afterEach, describe, expect, test } from 'bun:test'

import type { SessionToolContext } from '@craft-agent/session-tools-core'

import {
  mergeSessionScopedToolCallbacks,
  unregisterSessionScopedToolCallbacks,
} from '../session-scoped-tool-callback-registry.ts'
import { attachSessionSelfManagementBindings } from '../session-self-management-bindings.ts'

const sessionId = 'source-readiness-bindings-session'

afterEach(() => unregisterSessionScopedToolCallbacks(sessionId))

describe('source readiness session bindings', () => {
  test('exposes late-bound inject, observe, and cleanup callbacks to the real tool context', async () => {
    const events: string[] = []
    const context = {} as SessionToolContext
    attachSessionSelfManagementBindings(context, sessionId)

    mergeSessionScopedToolCallbacks(sessionId, {
      sourceProbeBackend: 'hermes',
      injectSourceForProbeFn: async (sourceSlug) => {
        events.push(`inject:${sourceSlug}`)
        return { probeId: 'probe-1' }
      },
      observeSourceToolsForProbeFn: async (probeId) => {
        events.push(`observe:${probeId}`)
        return [{ name: 'issues_list', apiVersion: 'v1' }]
      },
      removeSourceProbeFn: async (probeId) => {
        events.push(`cleanup:${probeId}`)
      },
    })

    const injection = await context.injectSourceForProbe?.('composio-linear')
    const observed = await context.observeSourceToolsForProbe?.(injection!.probeId)
    await context.removeSourceProbe?.(injection!.probeId)

    expect(context.sourceProbeBackend).toBe('hermes')
    expect(observed).toEqual([{ name: 'issues_list', apiVersion: 'v1' }])
    expect(events).toEqual(['inject:composio-linear', 'observe:probe-1', 'cleanup:probe-1'])
  })
})
