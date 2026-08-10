import { describe, expect, test } from 'bun:test'

import {
  runSourceReadinessCheck,
  type SourceReadinessDependencies,
  type SourceReadinessRequest,
} from './source-test.ts'

const SECRET_SENTINELS = [
  'provider-token-sentinel',
  'credential-sentinel',
  'Bearer authorization-sentinel',
]

const request: SourceReadinessRequest = {
  sourceSlug: 'composio-linear',
  backend: 'claude',
  expectedTools: [
    { name: 'mcp__composio-linear__list_issues', apiVersion: 'v1' },
    { name: 'mcp__composio-linear__create_issue', apiVersion: 'v1' },
  ],
}

function createDependencies(
  overrides: Partial<SourceReadinessDependencies> = {},
): SourceReadinessDependencies & { events: string[]; logs: unknown[] } {
  const events: string[] = []
  const logs: unknown[] = []

  return {
    events,
    logs,
    testSource: async () => {
      events.push('source-test')
      return { ok: true }
    },
    injectIntoSession: async () => {
      events.push('inject')
      return { sessionId: 'probe-session' }
    },
    observeSessionTools: async ({ sessionId }) => {
      events.push(`observe:${sessionId}`)
      return [...request.expectedTools]
    },
    removeFromSession: async ({ sessionId }) => {
      events.push(`cleanup:${sessionId}`)
    },
    writeHealth: async (health) => {
      events.push(`health:${health.status}`)
    },
    logHealth: (evidence) => {
      logs.push(evidence)
    },
    ...overrides,
  }
}

describe('source readiness', () => {
  test('rejects an expected tool version that is not real explicit metadata', async () => {
    const result = await runSourceReadinessCheck(
      {
        ...request,
        expectedTools: [{ name: 'issues_list', apiVersion: 'unversioned' }],
      },
      createDependencies(),
    )

    expect(result).toEqual({ ready: false, reason: 'source-test-failed' })
  })

  test('exposes a Composio source only after source test and session observation both pass', async () => {
    const dependencies = createDependencies()

    const result = await runSourceReadinessCheck(request, dependencies)

    expect(result).toEqual({
      ready: true,
      observedTools: request.expectedTools,
    })
    expect(dependencies.events).toEqual([
      'source-test',
      'inject',
      'observe:probe-session',
      'cleanup:probe-session',
      'health:ready',
    ])
  })

  test('keeps the source disabled when an expected tool is missing', async () => {
    const dependencies = createDependencies({
      observeSessionTools: async () => [request.expectedTools[0]!],
    })

    const result = await runSourceReadinessCheck(request, dependencies)

    expect(result).toEqual({
      ready: false,
      reason: 'missing-tools',
      missingTools: [request.expectedTools[1]!],
      observedTools: [request.expectedTools[0]!],
    })
    expect(dependencies.events.at(-1)).toBe('health:unhealthy')
  })

  test('rejects a tool with the expected name but an incompatible API version', async () => {
    const dependencies = createDependencies({
      observeSessionTools: async () => [
        request.expectedTools[0]!,
        { name: request.expectedTools[1]!.name, apiVersion: 'v2' },
      ],
    })

    const result = await runSourceReadinessCheck(request, dependencies)

    expect(result).toEqual({
      ready: false,
      reason: 'version-mismatch',
      versionMismatches: [{
        name: request.expectedTools[1]!.name,
        expectedApiVersion: 'v1',
        observedApiVersions: ['v2'],
      }],
      observedTools: [
        request.expectedTools[0]!,
        { name: request.expectedTools[1]!.name, apiVersion: 'v2' },
      ],
    })
    expect(dependencies.events.at(-1)).toBe('health:unhealthy')
  })

  test('does not inject an unsupported backend and keeps the source unhealthy', async () => {
    const dependencies = createDependencies()

    const result = await runSourceReadinessCheck(
      { ...request, backend: 'unsupported' },
      dependencies,
    )

    expect(result).toEqual({ ready: false, reason: 'unsupported-backend' })
    expect(dependencies.events).toEqual(['health:unhealthy'])
  })

  test('rolls back temporary injection when observation throws', async () => {
    const dependencies = createDependencies({
      observeSessionTools: async () => {
        throw new Error(`probe failed ${SECRET_SENTINELS.join(' ')}`)
      },
    })

    const result = await runSourceReadinessCheck(request, dependencies)

    expect(result).toEqual({ ready: false, reason: 'probe-failed' })
    expect(dependencies.events).toContain('cleanup:probe-session')
    expect(dependencies.events.at(-1)).toBe('health:unhealthy')
    expect(JSON.stringify({ result, logs: dependencies.logs })).not.toContain('sentinel')
  })

  test('does not inject when the source connection test fails', async () => {
    const dependencies = createDependencies({
      testSource: async () => ({
        ok: false,
        error: `401 ${SECRET_SENTINELS.join(' ')}`,
      }),
    })

    const result = await runSourceReadinessCheck(request, dependencies)

    expect(result).toEqual({ ready: false, reason: 'source-test-failed' })
    expect(dependencies.events).toEqual(['health:unhealthy'])
    expect(JSON.stringify({ result, logs: dependencies.logs })).not.toContain('sentinel')
  })

  test('allowlists health evidence to expected tool identities', async () => {
    const dependencies = createDependencies({
      observeSessionTools: async () => [
        ...request.expectedTools,
        { name: 'authorization-sentinel', apiVersion: 'Bearer credential-sentinel' },
      ],
    })

    const result = await runSourceReadinessCheck(request, dependencies)

    expect(result).toEqual({ ready: true, observedTools: request.expectedTools })
    expect(JSON.stringify({ result, logs: dependencies.logs })).not.toContain('sentinel')
  })
})
