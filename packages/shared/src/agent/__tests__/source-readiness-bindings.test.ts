import { afterEach, describe, expect, test } from 'bun:test'

import type { SessionSourceReadiness, SessionToolContext } from '@craft-agent/session-tools-core'

import {
  mergeSessionScopedToolCallbacks,
  unregisterSessionScopedToolCallbacks,
} from '../session-scoped-tool-callback-registry.ts'
import { attachSessionSelfManagementBindings } from '../session-self-management-bindings.ts'

const sessionId = 'source-readiness-bindings-session'

afterEach(() => unregisterSessionScopedToolCallbacks(sessionId))

describe('source readiness session bindings', () => {
  test('exposes the late-bound readiness seam to the real tool context', async () => {
    const events: string[] = []
    const context = {} as SessionToolContext
    attachSessionSelfManagementBindings(context, sessionId)

    // The seam is undefined until the backend merges it (late binding).
    expect(context.sessionSourceReadiness).toBeUndefined()

    const seam: SessionSourceReadiness = {
      backend: 'hermes',
      probeSourceTools: async (sourceSlug) => {
        events.push(`probe:${sourceSlug}`)
        return { ok: true, observedTools: [{ name: 'issues_list', apiVersion: 'v1' }] }
      },
      activateSource: async (sourceSlug, persistReady) => {
        events.push(`activate:${sourceSlug}`)
        persistReady()
        return { ok: true }
      },
      persistSourceConfig: (source) => {
        events.push(`persist:${source.readiness?.status ?? 'unknown'}`)
      },
    }

    mergeSessionScopedToolCallbacks(sessionId, { sessionSourceReadiness: seam })

    expect(context.sessionSourceReadiness).toBe(seam)
    expect(context.sessionSourceReadiness?.backend).toBe('hermes')

    const probe = await context.sessionSourceReadiness?.probeSourceTools('composio-linear')
    const activation = await context.sessionSourceReadiness?.activateSource('composio-linear', () => {
      context.sessionSourceReadiness?.persistSourceConfig({
        id: 'composio-linear',
        name: 'Linear',
        slug: 'composio-linear',
        enabled: true,
        provider: 'composio',
        type: 'mcp',
        readiness: { status: 'ready', checkedAt: 1 },
      })
    })

    expect(probe).toEqual({ ok: true, observedTools: [{ name: 'issues_list', apiVersion: 'v1' }] })
    expect(activation).toEqual({ ok: true })
    expect(events).toEqual([
      'probe:composio-linear',
      'activate:composio-linear',
      'persist:ready',
    ])
  })
})
