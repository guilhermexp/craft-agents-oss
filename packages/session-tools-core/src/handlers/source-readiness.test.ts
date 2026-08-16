import { describe, expect, test } from 'bun:test'

import {
  resolveSourceReadiness,
  type SessionSourceReadiness,
  type SourceActivationOutcome,
  type SourceProbeOutcome,
  type SourceReadinessRequest,
} from './source-readiness.ts'
import type { SourceConfig, SourceToolIdentity } from '../types.ts'

const SOURCE_SLUG = 'composio-linear'

const expectedTools: SourceToolIdentity[] = [
  { name: 'mcp__composio-linear__list_issues', apiVersion: 'v1' },
  { name: 'mcp__composio-linear__create_issue', apiVersion: 'v1' },
]

function createSource(overrides: Partial<SourceConfig> = {}): SourceConfig {
  return {
    id: SOURCE_SLUG,
    name: 'Composio Linear',
    slug: SOURCE_SLUG,
    enabled: false,
    provider: 'composio',
    type: 'mcp',
    expectedTools: expectedTools.map((tool) => ({ ...tool })),
    ...overrides,
  }
}

function createRequest(overrides: Partial<SourceReadinessRequest> = {}): SourceReadinessRequest {
  return {
    source: createSource(),
    sourceTestPassed: true,
    connectionStatus: 'connected',
    autoEnable: true,
    checkedAt: 1_000,
    ...overrides,
  }
}

interface Overrides {
  backend?: SessionSourceReadiness['backend']
  probe?: () => Promise<SourceProbeOutcome>
  activate?: (persistReady: () => void) => Promise<SourceActivationOutcome>
}

type FakeSession = SessionSourceReadiness & {
  events: string[]
  persistedConfigs: SourceConfig[]
}

function createSession(overrides: Overrides = {}): FakeSession {
  const events: string[] = []
  const persistedConfigs: SourceConfig[] = []

  const probe = overrides.probe
    ?? (async (): Promise<SourceProbeOutcome> => ({
      ok: true,
      observedTools: expectedTools.map((tool) => ({ ...tool })),
    }))

  const activate = overrides.activate
    ?? (async (persistReady: () => void): Promise<SourceActivationOutcome> => {
      persistReady()
      return { ok: true }
    })

  return {
    events,
    persistedConfigs,
    backend: overrides.backend ?? 'claude',
    probeSourceTools: async (sourceSlug) => {
      events.push(`probe:${sourceSlug}`)
      return probe()
    },
    activateSource: async (sourceSlug, persistReady) => {
      events.push(`activate:${sourceSlug}`)
      return activate(persistReady)
    },
    persistSourceConfig: (source) => {
      events.push(`persist:${source.readiness?.status ?? 'unknown'}`)
      persistedConfigs.push(source)
    },
  }
}

describe('resolveSourceReadiness verdict and gating', () => {
  test('rejects an expected tool version that is not real explicit metadata', async () => {
    const session = createSession()

    const outcome = await resolveSourceReadiness(
      createRequest({ source: createSource({ expectedTools: [{ name: 'issues_list', apiVersion: 'unversioned' }] }) }),
      session,
    )

    expect(outcome).toEqual({ ready: false, reason: 'source-test-failed' })
    // Identity is validated before any probe runs.
    expect(session.events).toEqual(['persist:unhealthy'])
    expect(session.persistedConfigs.at(-1)!.enabled).toBe(false)
  })

  test('maps an unsupported backend to a stable reason without probing', async () => {
    const session = createSession({ backend: 'unsupported' })

    const outcome = await resolveSourceReadiness(createRequest(), session)

    expect(outcome).toEqual({ ready: false, reason: 'unsupported-backend' })
    expect(session.events).toEqual(['persist:unhealthy'])
  })

  test('fails closed when the connection gate did not pass', async () => {
    const session = createSession()

    const outcome = await resolveSourceReadiness(
      createRequest({ sourceTestPassed: false, connectionStatus: 'error' }),
      session,
    )

    expect(outcome).toEqual({ ready: false, reason: 'source-test-failed' })
    expect(session.events).toEqual(['persist:unhealthy'])
  })

  test('fails closed on a contradictory request: source-test flagged passed but not connected', async () => {
    const session = createSession()

    const outcome = await resolveSourceReadiness(
      createRequest({ sourceTestPassed: true, connectionStatus: 'disconnected' }),
      session,
    )

    expect(outcome).toEqual({ ready: false, reason: 'source-test-failed' })
    // The connection gate is enforced inside the module: no probe runs.
    expect(session.events).toEqual(['persist:unhealthy'])
  })

  test('records a missing tool as unhealthy with the observed evidence', async () => {
    const session = createSession({
      probe: async () => ({ ok: true, observedTools: [{ ...expectedTools[0]! }] }),
    })

    const outcome = await resolveSourceReadiness(createRequest(), session)

    expect(outcome).toEqual({ ready: false, reason: 'missing-tools' })
    expect(session.events).toEqual([`probe:${SOURCE_SLUG}`, 'persist:unhealthy'])
    expect(session.persistedConfigs.at(-1)!.readiness).toMatchObject({
      status: 'unhealthy',
      reason: 'missing-tools',
      observedTools: [expectedTools[0]],
    })
  })

  test('records a version mismatch as unhealthy', async () => {
    const session = createSession({
      probe: async () => ({
        ok: true,
        observedTools: [
          { ...expectedTools[0]! },
          { name: expectedTools[1]!.name, apiVersion: 'v2' },
        ],
      }),
    })

    const outcome = await resolveSourceReadiness(createRequest(), session)

    expect(outcome).toEqual({ ready: false, reason: 'version-mismatch' })
    expect(session.persistedConfigs.at(-1)!.readiness).toMatchObject({
      status: 'unhealthy',
      reason: 'version-mismatch',
    })
  })

  test('propagates a probe failure reason and stays unhealthy', async () => {
    const session = createSession({ probe: async () => ({ ok: false, reason: 'probe-failed' }) })

    const outcome = await resolveSourceReadiness(createRequest(), session)

    expect(outcome).toEqual({ ready: false, reason: 'probe-failed' })
    expect(session.events).toEqual([`probe:${SOURCE_SLUG}`, 'persist:unhealthy'])
  })

  test('propagates a cleanup failure reason and stays unhealthy', async () => {
    const session = createSession({ probe: async () => ({ ok: false, reason: 'cleanup-failed' }) })

    const outcome = await resolveSourceReadiness(createRequest(), session)

    expect(outcome).toEqual({ ready: false, reason: 'cleanup-failed' })
  })

  test('never lets non-allowlisted observed tools enter evidence or leak secrets', async () => {
    const session = createSession({
      probe: async () => ({
        ok: true,
        observedTools: [
          ...expectedTools.map((tool) => ({ ...tool })),
          { name: 'authorization-sentinel', apiVersion: 'Bearer credential-sentinel' },
        ],
      }),
    })

    const outcome = await resolveSourceReadiness(createRequest(), session)

    expect(outcome).toEqual({ ready: true, observedTools: expectedTools })
    expect(JSON.stringify({ outcome, persistedConfigs: session.persistedConfigs })).not.toContain('sentinel')
  })

  test('records ready evidence without exposure when activation is not requested', async () => {
    const session = createSession()

    const outcome = await resolveSourceReadiness(createRequest({ autoEnable: false }), session)

    expect(outcome).toEqual({ ready: true, observedTools: expectedTools })
    // No staged/activate cycle: ready evidence persisted directly, source disabled.
    expect(session.events).toEqual([`probe:${SOURCE_SLUG}`, 'persist:ready'])
    const persisted = session.persistedConfigs.at(-1)!
    expect(persisted.enabled).toBe(false)
    expect(persisted.readiness).toMatchObject({ status: 'ready', observedTools: expectedTools })
  })
})
