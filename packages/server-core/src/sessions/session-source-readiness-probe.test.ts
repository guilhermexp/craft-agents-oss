import { describe, expect, test } from 'bun:test'

import { isSourceUsable, type LoadedSource } from '@craft-agent/shared/sources'
import type { SourceProbeBackend } from '@craft-agent/session-tools-core'

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

describe('SessionSourceReadinessProbe', () => {
  for (const backend of ['claude', 'codex', 'hermes'] as const satisfies SourceProbeBackend[]) {
    test(`${backend} observes the same versioned toolset after injection and restores prior sources`, async () => {
      const baseline = source('github', true)
      const candidate = source('composio-linear', false)
      let appliedSlugs = [baseline.config.slug]
      const applyHistory: string[][] = []

      const probe = new SessionSourceReadinessProbe({
        backend,
        getSource: (slug) => slug === candidate.config.slug ? candidate : undefined,
        getActiveSources: () => [baseline],
        buildServers: async (sources) => ({
          mcpServers: Object.fromEntries(
            sources.filter(isSourceUsable).map((item) => [item.config.slug, {}]),
          ),
          apiServers: {},
        }),
        applyServers: async (sources) => {
          appliedSlugs = sources.map((item) => item.config.slug)
          applyHistory.push(appliedSlugs)
        },
        clearServers: async () => {
          appliedSlugs = []
        },
        getSourceTools: (slug) => appliedSlugs.includes(slug)
          ? [
              { name: 'issues_list', _meta: { craftApiVersion: 'v1' } },
              { name: 'issues_create', _meta: { craftApiVersion: 'v1' } },
            ]
          : [],
      })

      const { probeId } = await probe.inject(candidate.config.slug)
      const observed = probe.observe(probeId)
      await probe.remove(probeId)

      expect(observed).toEqual([
        { name: 'issues_list', apiVersion: 'v1' },
        { name: 'issues_create', apiVersion: 'v1' },
      ])
      expect(applyHistory).toEqual([
        ['github', 'composio-linear'],
        ['github'],
      ])
      expect(candidate.config.enabled).toBe(false)
    })
  }

  test('rolls back the prior source set when backend application throws after partial injection', async () => {
    const baseline = source('github', true)
    const candidate = source('composio-linear', false)
    const applyHistory: string[][] = []
    let firstApply = true
    const probe = new SessionSourceReadinessProbe({
      backend: 'claude',
      getSource: () => candidate,
      getActiveSources: () => [baseline],
      buildServers: async (sources) => ({
        mcpServers: Object.fromEntries(
          sources.filter(isSourceUsable).map((item) => [item.config.slug, {}]),
        ),
        apiServers: {},
      }),
      applyServers: async (sources) => {
        applyHistory.push(sources.map((item) => item.config.slug))
        if (firstApply) {
          firstApply = false
          throw new Error('backend apply failed authorization-sentinel')
        }
      },
      clearServers: async () => {},
      getSourceTools: () => [],
    })

    await expect(probe.inject(candidate.config.slug)).rejects.toThrow('Source probe injection failed')
    expect(applyHistory).toEqual([
      ['github', 'composio-linear'],
      ['github'],
    ])
    expect(JSON.stringify(applyHistory)).not.toContain('sentinel')
  })
})
