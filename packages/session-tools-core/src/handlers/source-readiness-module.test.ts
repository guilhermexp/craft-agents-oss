import { describe, expect, test } from 'bun:test'

import {
  resolveSourceReadiness,
  type SessionSourceReadiness,
  type SourceActivationOutcome,
  type SourceProbeOutcome,
  type SourceReadinessRequest,
} from './source-readiness.ts'
import type {
  SourceConfig,
  SourceProbeBackend,
  SourceReadinessReason,
  SourceToolIdentity,
} from '../types.ts'

const SOURCE_SLUG = 'composio-linear'

const STABLE_REASONS: readonly SourceReadinessReason[] = [
  'unsupported-backend',
  'source-test-failed',
  'backend-injection-failed',
  'probe-failed',
  'cleanup-failed',
  'missing-tools',
  'version-mismatch',
]

const expectedTools: SourceToolIdentity[] = [
  { name: 'mcp__composio-linear__list_issues', apiVersion: 'v1' },
  { name: 'mcp__composio-linear__create_issue', apiVersion: 'v1' },
]

function createSource(): SourceConfig {
  return {
    id: SOURCE_SLUG,
    name: 'Composio Linear',
    slug: SOURCE_SLUG,
    enabled: false,
    provider: 'composio',
    type: 'mcp',
    expectedTools: expectedTools.map((tool) => ({ ...tool })),
  }
}

function createRequest(): SourceReadinessRequest {
  return {
    source: createSource(),
    sourceTestPassed: true,
    connectionStatus: 'connected',
    autoEnable: true,
    checkedAt: 1_000,
  }
}

interface SessionOverrides {
  backend?: SourceProbeBackend
  probe?: () => Promise<SourceProbeOutcome>
  activate?: (persistReady: () => void) => Promise<SourceActivationOutcome>
}

type FakeSession = SessionSourceReadiness & {
  events: string[]
  persistedConfigs: SourceConfig[]
}

// Compact seam fake: the module drives ordering, persistence and reason mapping;
// the session only records what it is asked to do and honours the persistReady commit.
function createSession(overrides: SessionOverrides = {}): FakeSession {
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

describe('resolveSourceReadiness', () => {
  test('probes, stages unhealthy, activates, then persists ready in that order', async () => {
    const session = createSession()

    const outcome = await resolveSourceReadiness(createRequest(), session)

    expect(outcome).toEqual({ ready: true, observedTools: expectedTools })
    expect(session.events).toEqual([
      `probe:${SOURCE_SLUG}`,
      'persist:unhealthy',
      `activate:${SOURCE_SLUG}`,
      'persist:ready',
    ])

    // Durable staged-unhealthy state precedes the durable ready commit.
    expect(session.persistedConfigs.map((config) => config.readiness?.status)).toEqual([
      'unhealthy',
      'ready',
    ])
    const staged = session.persistedConfigs[0]!
    expect(staged.enabled).toBe(false)
    expect(staged.readiness).toMatchObject({ status: 'unhealthy' })
    const committed = session.persistedConfigs.at(-1)!
    expect(committed.enabled).toBe(true)
    expect(committed.readiness).toMatchObject({ status: 'ready', observedTools: expectedTools })
  })

  test('activation failure keeps the source unhealthy, never persists ready, and maps to an existing reason', async () => {
    const session = createSession({
      activate: async () => ({ ok: false, reason: 'commit-failed' }),
    })

    const outcome = await resolveSourceReadiness(createRequest(), session)

    if (outcome.ready) throw new Error('expected activation to fail')
    expect(STABLE_REASONS).toContain(outcome.reason)
    // Durable reason stays stable; the stage rides along only as a transient diagnostic.
    expect(outcome).toEqual({
      ready: false,
      reason: 'backend-injection-failed',
      activationDiagnostic: 'commit-failed',
    })

    // Ready is durable only after a committed activation; the failed commit leaves
    // the staged-unhealthy state in place and never invokes persistReady.
    expect(session.events).toEqual([
      `probe:${SOURCE_SLUG}`,
      'persist:unhealthy',
      `activate:${SOURCE_SLUG}`,
    ])
    expect(session.persistedConfigs.map((config) => config.readiness?.status)).toEqual(['unhealthy'])
    expect(session.persistedConfigs.at(-1)!.enabled).toBe(false)
  })

  test('surfaces the stage-specific activation diagnostic for each failing stage', async () => {
    for (const stage of ['exposure-failed', 'commit-failed', 'ready-persist-failed'] as const) {
      const session = createSession({ activate: async () => ({ ok: false, reason: stage }) })

      const outcome = await resolveSourceReadiness(createRequest(), session)

      expect(outcome).toEqual({
        ready: false,
        reason: 'backend-injection-failed',
        activationDiagnostic: stage,
      })
    }
  })

  test('does not serialize the raw activation error into the outcome or persisted config', async () => {
    // The activation reason is a closed union, so a seam can no longer smuggle raw
    // error text through it; the durable config keeps only the stable reason.
    const session = createSession({
      activate: async () => ({ ok: false, reason: 'commit-failed' }),
    })

    const outcome = await resolveSourceReadiness(createRequest(), session)

    expect(outcome).toEqual({
      ready: false,
      reason: 'backend-injection-failed',
      activationDiagnostic: 'commit-failed',
    })
    expect(session.persistedConfigs.at(-1)!.readiness).toMatchObject({
      status: 'unhealthy',
      reason: 'backend-injection-failed',
    })
    expect(session.persistedConfigs.at(-1)!.connectionError).toBe('backend-injection-failed')
  })
})
