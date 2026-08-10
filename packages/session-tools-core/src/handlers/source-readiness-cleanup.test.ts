import { describe, expect, test } from 'bun:test'

import {
  runSourceReadinessCheck,
  type SourceReadinessDependencies,
  type SourceReadinessRequest,
} from './source-test.ts'

const request: SourceReadinessRequest = {
  sourceSlug: 'composio-linear',
  backend: 'claude',
  expectedTools: [
    { name: 'issues_list', apiVersion: 'v1' },
    { name: 'issues_create', apiVersion: 'v1' },
  ],
}

function dependencies(
  observedTools: SourceReadinessRequest['expectedTools'],
  writeHealth: SourceReadinessDependencies['writeHealth'] = async () => {},
): SourceReadinessDependencies & { events: string[] } {
  const events: string[] = []
  return {
    events,
    testSource: async () => ({ ok: true }),
    injectIntoSession: async () => {
      events.push('inject')
      return { sessionId: 'probe-1' }
    },
    observeSessionTools: async () => {
      events.push('observe')
      return observedTools
    },
    removeFromSession: async () => {
      events.push('cleanup')
    },
    writeHealth: async (health) => {
      events.push(`health:${health.status}`)
      await writeHealth(health)
    },
  }
}

describe('source readiness cleanup ordering', () => {
  test('cleans up before persisting a missing-tool result', async () => {
    const deps = dependencies([request.expectedTools[0]!])

    const result = await runSourceReadinessCheck(request, deps)

    expect(result).toMatchObject({ ready: false, reason: 'missing-tools' })
    expect(deps.events).toEqual(['inject', 'observe', 'cleanup', 'health:unhealthy'])
  })

  test('cleans up before persisting a version-mismatch result', async () => {
    const deps = dependencies([
      request.expectedTools[0]!,
      { name: request.expectedTools[1]!.name, apiVersion: 'v2' },
    ])

    const result = await runSourceReadinessCheck(request, deps)

    expect(result).toMatchObject({ ready: false, reason: 'version-mismatch' })
    expect(deps.events).toEqual(['inject', 'observe', 'cleanup', 'health:unhealthy'])
  })

  test('has already cleaned up when ready-health persistence throws', async () => {
    const deps = dependencies(request.expectedTools, async () => {
      throw new Error('disk failure credential-sentinel')
    })

    let caught: unknown
    try {
      await runSourceReadinessCheck(request, deps)
    } catch (error) {
      caught = error
    }
    expect(caught).toBeInstanceOf(Error)
    expect((caught as Error).message).toBe('Source readiness health persistence failed')
    expect(JSON.stringify(caught)).not.toContain('sentinel')
    expect(deps.events).toEqual(['inject', 'observe', 'cleanup', 'health:ready'])
  })
})
