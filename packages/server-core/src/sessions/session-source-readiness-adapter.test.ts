import { describe, expect, test } from 'bun:test'

import type { SourceToolIdentity } from '@craft-agent/session-tools-core'

import {
  createSessionSourceReadinessAdapter,
  type ReadinessProbeSeam,
  type SessionSourceReadinessAdapterHooks,
} from './session-source-readiness-adapter.ts'

const SLUG = 'composio-linear'
const OBSERVED: SourceToolIdentity[] = [{ name: 'issues_list', apiVersion: 'v1' }]

interface ProbeBehavior {
  inject?: (slug: string) => Promise<{ probeId: string }>
  observe?: (probeId: string) => SourceToolIdentity[]
  remove?: (probeId: string) => Promise<void>
  commit?: (probeId: string, beforeCommit?: (slug: string) => void) => string
  finalize?: (probeId: string) => string
}

function createProbe(behavior: ProbeBehavior = {}): ReadinessProbeSeam & { events: string[] } {
  const events: string[] = []
  return {
    events,
    backend: 'claude',
    inject: behavior.inject ?? (async (slug) => { events.push(`inject:${slug}`); return { probeId: 'p1' } }),
    observe: behavior.observe ?? ((probeId) => { events.push(`observe:${probeId}`); return OBSERVED }),
    remove: behavior.remove ?? (async (probeId) => { events.push(`remove:${probeId}`) }),
    commit: behavior.commit ?? ((probeId, beforeCommit) => {
      events.push(`commit:${probeId}`)
      beforeCommit?.(SLUG)
      return SLUG
    }),
    finalize: behavior.finalize ?? ((probeId) => { events.push(`finalize:${probeId}`); return SLUG }),
  }
}

function createHooks(initialEnabled: string[] = []): SessionSourceReadinessAdapterHooks & { events: string[]; enabled(): string[] } {
  const events: string[] = []
  let enabled = [...initialEnabled]
  return {
    events,
    enabled: () => enabled,
    getEnabledSlugs: () => enabled,
    setEnabledSlugs: (slugs) => { enabled = slugs; events.push(`setEnabled:[${slugs.join(',')}]`) },
    persistSession: () => events.push('persistSession'),
    emitSourcesChanged: (slugs) => events.push(`changed:[${slugs.join(',')}]`),
    getCurrentTurnUserMessage: () => 'original message',
    schedulePendingRestart: (input) => events.push(`restart:${input.sourceSlug}`),
    persistSourceConfig: () => events.push('persistSourceConfig'),
  }
}

describe('createSessionSourceReadinessAdapter probeSourceTools', () => {
  test('reports probe-failed only after cleanup is confirmed when observe fails', async () => {
    const probe = createProbe({
      observe: () => { throw new Error('observe blew up') },
    })
    const adapter = createSessionSourceReadinessAdapter(probe, createHooks())

    const outcome = await adapter.probeSourceTools(SLUG)

    expect(outcome).toEqual({ ok: false, reason: 'probe-failed' })
    // Cleanup ran and succeeded before the probe verdict was surfaced.
    expect(probe.events).toEqual([`inject:${SLUG}`, 'remove:p1'])
  })

  test('reports cleanup-failed when both observe and cleanup fail', async () => {
    const probe = createProbe({
      observe: () => { throw new Error('observe blew up') },
      remove: async () => { throw new Error('cleanup blew up') },
    })
    const adapter = createSessionSourceReadinessAdapter(probe, createHooks())

    const outcome = await adapter.probeSourceTools(SLUG)

    // The source is still exposed, so cleanup-failed is the truthful verdict.
    expect(outcome).toEqual({ ok: false, reason: 'cleanup-failed' })
  })

  test('reports cleanup-failed when observe succeeds but cleanup fails', async () => {
    const probe = createProbe({ remove: async () => { throw new Error('cleanup blew up') } })
    const adapter = createSessionSourceReadinessAdapter(probe, createHooks())

    const outcome = await adapter.probeSourceTools(SLUG)

    expect(outcome).toEqual({ ok: false, reason: 'cleanup-failed' })
  })

  test('reports backend-injection-failed when inject rejects', async () => {
    const probe = createProbe({ inject: async () => { throw new Error('inject blew up') } })
    const adapter = createSessionSourceReadinessAdapter(probe, createHooks())

    const outcome = await adapter.probeSourceTools(SLUG)

    expect(outcome).toEqual({ ok: false, reason: 'backend-injection-failed' })
  })

  test('returns the observed toolset on a clean probe cycle', async () => {
    const probe = createProbe()
    const adapter = createSessionSourceReadinessAdapter(probe, createHooks())

    const outcome = await adapter.probeSourceTools(SLUG)

    expect(outcome).toEqual({ ok: true, observedTools: OBSERVED })
    expect(probe.events).toEqual([`inject:${SLUG}`, 'observe:p1', 'remove:p1'])
  })
})

describe('createSessionSourceReadinessAdapter activateSource', () => {
  test('schedules the pending restart only after persistReady succeeds', async () => {
    const probe = createProbe()
    const hooks = createHooks([])
    const adapter = createSessionSourceReadinessAdapter(probe, hooks)

    const outcome = await adapter.activateSource(SLUG, () => hooks.events.push('persistReady'))

    expect(outcome).toEqual({ ok: true })
    expect(hooks.enabled()).toEqual([SLUG])
    // persistReady must precede the restart schedule, and finalize closes the cycle.
    const persistIndex = hooks.events.indexOf('persistReady')
    const restartIndex = hooks.events.indexOf(`restart:${SLUG}`)
    expect(persistIndex).toBeGreaterThanOrEqual(0)
    expect(restartIndex).toBeGreaterThan(persistIndex)
    expect(probe.events).toContain('finalize:p1')
  })

  test('rolls back exposure and never schedules a restart when persistReady throws', async () => {
    const probe = createProbe()
    const hooks = createHooks(['github'])
    const adapter = createSessionSourceReadinessAdapter(probe, hooks)

    const outcome = await adapter.activateSource(SLUG, () => { throw new Error('ready persist blew up') })

    expect(outcome).toEqual({ ok: false, reason: 'ready-persist-failed' })
    // Enabled slugs restored to the pre-activation set; exposure removed; no restart.
    expect(hooks.enabled()).toEqual(['github'])
    expect(hooks.events).not.toContain(`restart:${SLUG}`)
    expect(probe.events).toContain('remove:p1')
    expect(probe.events).not.toContain('finalize:p1')
  })

  test('rolls back and reports commit-failed without scheduling a restart', async () => {
    const probe = createProbe({ commit: () => { throw new Error('commit blew up') } })
    const hooks = createHooks(['github'])
    const adapter = createSessionSourceReadinessAdapter(probe, hooks)

    const outcome = await adapter.activateSource(SLUG, () => hooks.events.push('persistReady'))

    expect(outcome).toEqual({ ok: false, reason: 'commit-failed' })
    expect(hooks.events).not.toContain('persistReady')
    expect(hooks.events).not.toContain(`restart:${SLUG}`)
    expect(probe.events).toContain('remove:p1')
  })

  test('reports exposure-failed when injection rejects and never schedules a restart', async () => {
    const probe = createProbe({ inject: async () => { throw new Error('inject blew up') } })
    const hooks = createHooks()
    const adapter = createSessionSourceReadinessAdapter(probe, hooks)

    const outcome = await adapter.activateSource(SLUG, () => hooks.events.push('persistReady'))

    expect(outcome).toEqual({ ok: false, reason: 'exposure-failed' })
    expect(hooks.events).toEqual([])
  })
})
