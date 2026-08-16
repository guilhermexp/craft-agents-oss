import type {
  SessionSourceReadiness,
  SourceConfig,
  SourceProbeBackend,
  SourceProbeOutcome,
  SourceToolIdentity,
} from '@craft-agent/session-tools-core'

/**
 * Minimal structural view of {@link SessionSourceReadinessProbe} the adapter
 * depends on. Declared as an interface so the adapter can be unit-tested with a
 * lightweight fake without spinning up a real backend probe.
 */
export interface ReadinessProbeSeam {
  readonly backend: Exclude<SourceProbeBackend, 'unsupported'>
  inject(sourceSlug: string): Promise<{ probeId: string }>
  observe(probeId: string): SourceToolIdentity[]
  remove(probeId: string): Promise<void>
  commit(probeId: string, beforeCommit?: (sourceSlug: string) => void): string
  finalize(probeId: string): string
}

/**
 * Side-effecting hooks the adapter needs from the owning session. Keeping them
 * behind an interface isolates the ordering-sensitive activation logic from
 * `SessionManager` internals so it can be exercised directly.
 */
export interface SessionSourceReadinessAdapterHooks {
  getEnabledSlugs(): string[]
  setEnabledSlugs(slugs: string[]): void
  persistSession(): void
  emitSourcesChanged(slugs: string[]): void
  getCurrentTurnUserMessage(): string
  schedulePendingRestart(input: { sourceSlug: string; userMessage: string }): void
  persistSourceConfig(source: SourceConfig): void
}

/**
 * Builds the `SessionSourceReadiness` seam consumed by the source-test handler.
 *
 * Ordering guarantees owned here:
 * - a failed observe reports `probe-failed` only once cleanup is confirmed;
 *   if cleanup also fails the source is still exposed and we report `cleanup-failed`;
 * - the pending source-activation restart is scheduled only after `persistReady`
 *   succeeds, so a rolled-back activation never leaves a restart queued.
 */
export function createSessionSourceReadinessAdapter(
  probe: ReadinessProbeSeam,
  hooks: SessionSourceReadinessAdapterHooks,
): SessionSourceReadiness {
  return {
    backend: probe.backend,
    probeSourceTools: async (sourceSlug): Promise<SourceProbeOutcome> => {
      const injected = await probe.inject(sourceSlug).catch(() => undefined)
      if (!injected) return { ok: false, reason: 'backend-injection-failed' }
      const probeId = injected.probeId

      let observedTools: SourceToolIdentity[]
      try {
        observedTools = probe.observe(probeId)
      } catch {
        // Probe verdict already failed. Only surface probe-failed once cleanup
        // confirms the source was restored; if cleanup fails too, the source is
        // still exposed and cleanup-failed is the truthful verdict.
        try {
          await probe.remove(probeId)
        } catch {
          return { ok: false, reason: 'cleanup-failed' }
        }
        return { ok: false, reason: 'probe-failed' }
      }

      try {
        await probe.remove(probeId)
      } catch {
        return { ok: false, reason: 'cleanup-failed' }
      }
      return { ok: true, observedTools }
    },
    activateSource: async (sourceSlug, persistReady) => {
      let activationId: string
      try {
        activationId = (await probe.inject(sourceSlug)).probeId
      } catch {
        return { ok: false, reason: 'exposure-failed' }
      }

      let previousEnabledSlugs: string[] | undefined
      const restoreExposure = async (): Promise<void> => {
        if (previousEnabledSlugs !== undefined) {
          hooks.setEnabledSlugs(previousEnabledSlugs)
          try {
            hooks.persistSession()
            hooks.emitSourcesChanged(previousEnabledSlugs)
          } catch { /* durable restore best-effort; exposure removal below is the guarantee */ }
        }
        try { await probe.remove(activationId) } catch { /* exposure removal best-effort */ }
      }

      let committedSlug: string
      try {
        committedSlug = probe.commit(activationId, (slug) => {
          previousEnabledSlugs = [...hooks.getEnabledSlugs()]
          const enabledSlugs = new Set(previousEnabledSlugs)
          enabledSlugs.add(slug)
          const nextSlugs = [...enabledSlugs]
          hooks.setEnabledSlugs(nextSlugs)
          hooks.persistSession()
          hooks.emitSourcesChanged(nextSlugs)
        })
      } catch {
        await restoreExposure()
        return { ok: false, reason: 'commit-failed' }
      }

      // Ready is durable only after a committed exposure; a failed persist rolls
      // the live exposure back and keeps the staged-unhealthy config.
      try {
        persistReady()
      } catch {
        await restoreExposure()
        return { ok: false, reason: 'ready-persist-failed' }
      }

      // Only now that exposure and ready state are both durable do we queue the
      // turn restart, so a rolled-back activation never schedules one.
      const userMessage = hooks.getCurrentTurnUserMessage()
      if (userMessage) {
        hooks.schedulePendingRestart({ sourceSlug: committedSlug, userMessage })
      }

      probe.finalize(activationId)
      return { ok: true }
    },
    persistSourceConfig: (source) => {
      hooks.persistSourceConfig(source)
    },
  }
}
