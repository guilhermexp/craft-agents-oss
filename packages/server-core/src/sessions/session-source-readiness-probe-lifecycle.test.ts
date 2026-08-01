import { describe, expect, test } from 'bun:test'

import { isSourceUsable, type LoadedSource } from '@craft-agent/shared/sources'

import { SessionSourceReadinessProbe } from './session-source-readiness-probe.ts'

function source(slug: string, enabled: boolean): LoadedSource {
  return {
    config: {
      id: `${slug}-id`,
      name: slug,
      slug,
      enabled,
      provider: slug,
      type: 'mcp',
      isAuthenticated: true,
      expectedTools: slug.startsWith('composio-')
        ? [{ name: 'issues_list', apiVersion: 'v1' }]
        : undefined,
      readiness: slug.startsWith('composio-')
        ? { status: 'unhealthy', reason: 'missing-tools', checkedAt: 1 }
        : undefined,
      mcp: { transport: 'http', url: `https://${slug}.example.test/mcp`, authType: 'oauth' },
    },
    guide: null,
    folderPath: `/workspace/sources/${slug}`,
    workspaceRootPath: '/workspace',
    workspaceId: 'workspace',
  }
}

function servers(sources: LoadedSource[]) {
  return {
    mcpServers: Object.fromEntries(
      sources.filter(isSourceUsable).map((item) => [item.config.slug, {}]),
    ),
    apiServers: {},
  }
}

describe('SessionSourceReadinessProbe lifecycle', () => {
  test('rejects an overlapping injection and releases the lock after cleanup', async () => {
    const baseline = source('github', true)
    const candidate = source('composio-linear', false)
    let releaseFirstApply: (() => void) | undefined
    let firstApplyStarted: (() => void) | undefined
    const firstApply = new Promise<void>((resolve) => {
      firstApplyStarted = resolve
    })
    const waitForRelease = new Promise<void>((resolve) => {
      releaseFirstApply = resolve
    })
    let probeApplyCount = 0

    const probe = new SessionSourceReadinessProbe({
      backend: 'claude',
      getSource: () => candidate,
      getActiveSources: () => [baseline],
      buildServers: async (sources) => servers(sources),
      applyServers: async (sources) => {
        if (sources.some((item) => item.config.slug === candidate.config.slug)) {
          probeApplyCount += 1
          if (probeApplyCount === 1) {
            firstApplyStarted?.()
            await waitForRelease
          }
        }
      },
      clearServers: async () => {},
      getSourceTools: () => [],
    })

    const firstInjection = probe.inject(candidate.config.slug)
    await firstApply

    await expect(probe.inject(candidate.config.slug)).rejects.toThrow('Source probe is already active')

    releaseFirstApply?.()
    const first = await firstInjection
    await probe.remove(first.probeId)

    const second = await probe.inject(candidate.config.slug)
    await probe.remove(second.probeId)
    expect(probeApplyCount).toBe(2)
  })

  test('clears temporary exposure and releases the lock when restore fails after injection', async () => {
    const baseline = source('github', true)
    const candidate = source('composio-linear', false)
    let appliedSlugs = [baseline.config.slug]
    let cleanupApply = false
    let clearCount = 0

    const probe = new SessionSourceReadinessProbe({
      backend: 'claude',
      getSource: () => candidate,
      getActiveSources: () => [baseline],
      buildServers: async (sources) => servers(sources),
      applyServers: async (sources, _servers, context) => {
        if (context === 'source readiness cleanup' && !cleanupApply) {
          cleanupApply = true
          throw new Error('restore failed after partial bridge update')
        }
        appliedSlugs = sources.map((item) => item.config.slug)
      },
      clearServers: async () => {
        clearCount += 1
        appliedSlugs = []
      },
      getSourceTools: () => [],
    })

    const injection = await probe.inject(candidate.config.slug)
    expect(appliedSlugs).toEqual(['github', 'composio-linear'])

    await expect(probe.remove(injection.probeId)).rejects.toThrow('Source probe cleanup failed')
    expect(appliedSlugs).toEqual([])
    expect(clearCount).toBe(1)

    const retry = await probe.inject(candidate.config.slug)
    await probe.remove(retry.probeId)
  })

  test('commits a prepared activation without restoring it and releases the lock', async () => {
    const baseline = source('github', true)
    const candidate = source('composio-linear', false)
    let appliedSlugs = [baseline.config.slug]
    let cleanupCount = 0

    const probe = new SessionSourceReadinessProbe({
      backend: 'claude',
      getSource: () => candidate,
      getActiveSources: () => [baseline],
      buildServers: async (sources) => servers(sources),
      applyServers: async (sources, _servers, context) => {
        if (context === 'source readiness cleanup') cleanupCount += 1
        appliedSlugs = sources.map((item) => item.config.slug)
      },
      clearServers: async () => {
        appliedSlugs = []
      },
      getSourceTools: () => [],
    })

    const activation = await probe.inject(candidate.config.slug)
    expect(probe.commit(activation.probeId)).toBe(candidate.config.slug)
    expect(appliedSlugs).toEqual(['github', 'composio-linear'])
    expect(cleanupCount).toBe(0)

    const next = await probe.inject(candidate.config.slug)
    await probe.remove(next.probeId)
  })

  test('retains the rollback snapshot when activation bookkeeping throws before commit', async () => {
    const baseline = source('github', true)
    const candidate = source('composio-linear', false)
    let appliedSlugs = [baseline.config.slug]

    const probe = new SessionSourceReadinessProbe({
      backend: 'claude',
      getSource: () => candidate,
      getActiveSources: () => [baseline],
      buildServers: async (sources) => servers(sources),
      applyServers: async (sources) => {
        appliedSlugs = sources.map((item) => item.config.slug)
      },
      clearServers: async () => {
        appliedSlugs = []
      },
      getSourceTools: () => [],
    })

    const activation = await probe.inject(candidate.config.slug)
    expect(() => probe.commit(activation.probeId, () => {
      throw new Error('session bookkeeping failed')
    })).toThrow('session bookkeeping failed')

    await expect(probe.inject(candidate.config.slug)).rejects.toThrow('Source probe is already active')
    await probe.remove(activation.probeId)
    expect(appliedSlugs).toEqual(['github'])
  })

  test('clears partial injection and releases the lock when injection and restore both fail', async () => {
    const baseline = source('github', true)
    const candidate = source('composio-linear', false)
    let appliedSlugs = [baseline.config.slug]
    let injectionAttempts = 0
    let restoreAttempts = 0

    const probe = new SessionSourceReadinessProbe({
      backend: 'claude',
      getSource: () => candidate,
      getActiveSources: () => [baseline],
      buildServers: async (sources) => servers(sources),
      applyServers: async (sources, _servers, context) => {
        if (context === 'source readiness probe') {
          injectionAttempts += 1
          appliedSlugs = sources.map((item) => item.config.slug)
          if (injectionAttempts === 1) throw new Error('partial injection failure')
          return
        }
        restoreAttempts += 1
        if (restoreAttempts === 1) throw new Error('restore failure')
        appliedSlugs = sources.map((item) => item.config.slug)
      },
      clearServers: async () => {
        appliedSlugs = []
      },
      getSourceTools: () => [],
    })

    await expect(probe.inject(candidate.config.slug)).rejects.toThrow('Source probe injection failed')
    expect(appliedSlugs).toEqual([])

    const retry = await probe.inject(candidate.config.slug)
    await probe.remove(retry.probeId)
    expect(appliedSlugs).toEqual(['github'])
  })

  test('restores the exact source snapshot captured before a partial injection failure', async () => {
    const baseline = source('github', true)
    const candidate = source('composio-linear', false)
    let activeReadCount = 0
    let appliedSlugs = [baseline.config.slug]

    const probe = new SessionSourceReadinessProbe({
      backend: 'claude',
      getSource: () => candidate,
      getActiveSources: () => {
        activeReadCount += 1
        return activeReadCount === 1 ? [baseline] : []
      },
      buildServers: async (sources) => servers(sources),
      applyServers: async (sources, _servers, context) => {
        appliedSlugs = sources.map((item) => item.config.slug)
        if (context === 'source readiness probe') throw new Error('partial injection failure')
      },
      clearServers: async () => {
        appliedSlugs = []
      },
      getSourceTools: () => [],
    })

    await expect(probe.inject(candidate.config.slug)).rejects.toThrow('Source probe injection failed')
    expect(appliedSlugs).toEqual(['github'])
    expect(activeReadCount).toBe(1)
  })
})
