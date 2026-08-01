import { randomUUID } from 'node:crypto'

import type { LoadedSource } from '@craft-agent/shared/sources'
import type { SourceProbeBackend, SourceToolIdentity } from '@craft-agent/session-tools-core'

export interface SourceProbeServers {
  mcpServers: Record<string, unknown>
  apiServers: Record<string, unknown>
}

interface SourceProbeTool {
  name?: unknown
  _meta?: unknown
}

export interface SessionSourceReadinessProbeDependencies {
  backend: Exclude<SourceProbeBackend, 'unsupported'>
  getSource(sourceSlug: string): LoadedSource | undefined
  getActiveSources(): LoadedSource[]
  buildServers(sources: LoadedSource[]): Promise<SourceProbeServers>
  applyServers(
    sources: LoadedSource[],
    servers: SourceProbeServers,
    context: 'source readiness probe' | 'source readiness cleanup',
  ): Promise<void>
  getSourceTools(sourceSlug: string): SourceProbeTool[]
}

interface SourceProbeSnapshot {
  sourceSlug: string
  activeSources: LoadedSource[]
}

function withProbeSource(activeSources: LoadedSource[], source: LoadedSource): LoadedSource[] {
  const bySlug = new Map(activeSources.map((item) => [item.config.slug, item]))
  bySlug.set(source.config.slug, {
    ...source,
    config: {
      ...source.config,
      enabled: true,
      // The readiness guard protects normal exposure. This non-persisted clone
      // bypasses only that guard so the probe can discover the backend-visible
      // toolset that decides whether readiness may be persisted.
      expectedTools: undefined,
      readiness: undefined,
    },
  })
  return [...bySlug.values()]
}

function readApiVersion(meta: unknown): string {
  if (meta === null || typeof meta !== 'object') return 'unversioned'
  const record = meta as Record<string, unknown>
  if (typeof record.craftApiVersion === 'string' && record.craftApiVersion.length > 0) {
    return record.craftApiVersion
  }
  if (typeof record.apiVersion === 'string' && record.apiVersion.length > 0) {
    return record.apiVersion
  }
  return 'unversioned'
}

/**
 * Temporarily applies a source to the real session backend and observes the
 * shared MCP pool only after injection. The original source set is restored
 * after every successful probe and after partial injection failures.
 */
export class SessionSourceReadinessProbe {
  readonly backend: Exclude<SourceProbeBackend, 'unsupported'>
  private readonly snapshots = new Map<string, SourceProbeSnapshot>()

  constructor(private readonly dependencies: SessionSourceReadinessProbeDependencies) {
    this.backend = dependencies.backend
  }

  async inject(sourceSlug: string): Promise<{ probeId: string }> {
    const source = this.dependencies.getSource(sourceSlug)
    if (!source) throw new Error('Source probe injection failed')

    const activeSources = this.dependencies.getActiveSources()
    const probeSources = withProbeSource(activeSources, source)
    const probeId = randomUUID()

    try {
      const servers = await this.dependencies.buildServers(probeSources)
      if (!(sourceSlug in servers.mcpServers) && !(sourceSlug in servers.apiServers)) {
        throw new Error('Source was not built for probe')
      }
      await this.dependencies.applyServers(probeSources, servers, 'source readiness probe')
      this.snapshots.set(probeId, { sourceSlug, activeSources })
      return { probeId }
    } catch {
      try {
        const restoreServers = await this.dependencies.buildServers(activeSources)
        await this.dependencies.applyServers(activeSources, restoreServers, 'source readiness cleanup')
      } catch {
        // The public failure remains fixed and redacted; callers persist unhealthy.
      }
      throw new Error('Source probe injection failed')
    }
  }

  observe(probeId: string): SourceToolIdentity[] {
    const snapshot = this.snapshots.get(probeId)
    if (!snapshot) throw new Error('Source probe is not active')

    return this.dependencies.getSourceTools(snapshot.sourceSlug).flatMap((tool) => {
      if (typeof tool.name !== 'string' || tool.name.length === 0) return []
      return [{ name: tool.name, apiVersion: readApiVersion(tool._meta) }]
    })
  }

  async remove(probeId: string): Promise<void> {
    const snapshot = this.snapshots.get(probeId)
    if (!snapshot) throw new Error('Source probe is not active')

    const servers = await this.dependencies.buildServers(snapshot.activeSources)
    await this.dependencies.applyServers(
      snapshot.activeSources,
      servers,
      'source readiness cleanup',
    )
    this.snapshots.delete(probeId)
  }
}
