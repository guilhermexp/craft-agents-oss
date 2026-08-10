import { randomUUID } from 'node:crypto'
import { realpathSync } from 'node:fs'
import { resolve } from 'node:path'

import type { LoadedSource } from '@craft-agent/shared/sources/types'
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
  clearServers(): Promise<void>
  getSourceTools(sourceSlug: string): SourceProbeTool[]
}

interface SourceProbeSnapshot {
  sourceSlug: string
  activeSources: LoadedSource[]
  lockKey: string
}

const activeProbeKeys = new Map<string, string>()

function canonicalPath(path: string): string {
  const absolute = resolve(path)
  try {
    return realpathSync.native(absolute)
  } catch {
    return absolute
  }
}

function sourceLockKey(source: LoadedSource): string {
  return `${canonicalPath(source.workspaceRootPath)}\0${source.config.slug}`
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

function readApiVersion(meta: unknown): string | undefined {
  if (meta === null || typeof meta !== 'object') return undefined
  const record = meta as Record<string, unknown>
  if (typeof record.craftApiVersion === 'string' && record.craftApiVersion.length > 0) {
    return record.craftApiVersion
  }
  if (typeof record.apiVersion === 'string' && record.apiVersion.length > 0) {
    return record.apiVersion
  }
  return undefined
}

/**
 * Temporarily applies a source to the real session backend and observes the
 * shared MCP pool only after injection. The original source set is restored
 * after every successful probe and after partial injection failures.
 */
export class SessionSourceReadinessProbe {
  readonly backend: Exclude<SourceProbeBackend, 'unsupported'>
  private readonly snapshots = new Map<string, SourceProbeSnapshot>()
  private activeProbeId: string | undefined

  constructor(private readonly dependencies: SessionSourceReadinessProbeDependencies) {
    this.backend = dependencies.backend
  }

  async inject(sourceSlug: string): Promise<{ probeId: string }> {
    const probeId = randomUUID()
    if (this.activeProbeId !== undefined) throw new Error('Source probe is already active')
    const source = this.dependencies.getSource(sourceSlug)
    if (!source) throw new Error('Source probe injection failed')
    const lockKey = sourceLockKey(source)
    if (activeProbeKeys.has(lockKey)) throw new Error('Source probe is already active')
    activeProbeKeys.set(lockKey, probeId)
    this.activeProbeId = probeId
    let applyAttempted = false
    let activeSources: LoadedSource[] | undefined

    try {
      activeSources = this.dependencies.getActiveSources()
      const probeSources = withProbeSource(activeSources, source)
      const servers = await this.dependencies.buildServers(probeSources)
      if (!(sourceSlug in servers.mcpServers) && !(sourceSlug in servers.apiServers)) {
        throw new Error('Source was not built for probe')
      }
      applyAttempted = true
      await this.dependencies.applyServers(probeSources, servers, 'source readiness probe')
      this.snapshots.set(probeId, { sourceSlug, activeSources, lockKey })
      return { probeId }
    } catch {
      if (applyAttempted && activeSources !== undefined) {
        await this.restoreOrClear(activeSources)
      }
      if (this.activeProbeId === probeId) this.activeProbeId = undefined
      if (activeProbeKeys.get(lockKey) === probeId) activeProbeKeys.delete(lockKey)
      throw new Error('Source probe injection failed')
    }
  }

  observe(probeId: string): SourceToolIdentity[] {
    const snapshot = this.snapshots.get(probeId)
    if (!snapshot) throw new Error('Source probe is not active')

    return this.dependencies.getSourceTools(snapshot.sourceSlug).flatMap((tool) => {
      if (typeof tool.name !== 'string' || tool.name.length === 0) return []
      const apiVersion = readApiVersion(tool._meta)
      return apiVersion === undefined ? [] : [{ name: tool.name, apiVersion }]
    })
  }

  async remove(probeId: string): Promise<void> {
    const snapshot = this.snapshots.get(probeId)
    if (!snapshot) throw new Error('Source probe is not active')

    try {
      const restored = await this.restoreOrClear(snapshot.activeSources)
      if (!restored) throw new Error('Source probe cleanup failed')
    } finally {
      this.snapshots.delete(probeId)
      if (this.activeProbeId === probeId) this.activeProbeId = undefined
      if (activeProbeKeys.get(snapshot.lockKey) === probeId) activeProbeKeys.delete(snapshot.lockKey)
    }
  }

  commit(probeId: string, beforeCommit?: (sourceSlug: string) => void): string {
    const snapshot = this.snapshots.get(probeId)
    if (!snapshot) throw new Error('Source probe is not active')
    beforeCommit?.(snapshot.sourceSlug)
    return snapshot.sourceSlug
  }

  finalize(probeId: string): string {
    const snapshot = this.snapshots.get(probeId)
    if (!snapshot) throw new Error('Source probe is not active')
    this.snapshots.delete(probeId)
    if (this.activeProbeId === probeId) this.activeProbeId = undefined
    if (activeProbeKeys.get(snapshot.lockKey) === probeId) activeProbeKeys.delete(snapshot.lockKey)
    return snapshot.sourceSlug
  }

  private async restoreOrClear(activeSources: LoadedSource[]): Promise<boolean> {
    try {
      const servers = await this.dependencies.buildServers(activeSources)
      await this.dependencies.applyServers(
        activeSources,
        servers,
        'source readiness cleanup',
      )
      return true
    } catch {
      try {
        await this.dependencies.clearServers()
      } catch {
        // The fixed failure returned by the caller remains redacted.
      }
      return false
    }
  }
}
