import { describe, expect, test } from 'bun:test'
import { decideHermesDashboardNavigation, HermesDashboardHost, isHermesDashboardUrlAllowed } from '../index'
import type { BrowserPaneManager } from '../../browser-pane-manager'

describe('hermes-dashboard-host navigation policy', () => {
  test('permite apenas a origem localhost ativa do dashboard', () => {
    const active = 'http://127.0.0.1:49152'

    expect(isHermesDashboardUrlAllowed('http://127.0.0.1:49152/settings', active)).toBe(true)
    expect(isHermesDashboardUrlAllowed('http://localhost:49152/settings', active)).toBe(false)
    expect(isHermesDashboardUrlAllowed('https://127.0.0.1:49152/settings', active)).toBe(false)
    expect(isHermesDashboardUrlAllowed('http://example.com/settings', active)).toBe(false)
  })

  test('bloqueia navegacao externa e permite deep-link Craft', () => {
    const active = 'http://127.0.0.1:49152'

    expect(decideHermesDashboardNavigation('http://127.0.0.1:49152/profile', active).action).toBe('allow')
    expect(decideHermesDashboardNavigation('craftagents://settings?view=hermes', active).action).toBe('allow')
    expect(decideHermesDashboardNavigation('https://example.com', active)).toEqual({
      action: 'deny',
      reason: 'hermes-dashboard-origin',
    })
  })
})

describe('HermesDashboardHost mount', () => {
  test('cria e reusa uma instancia dedicada sem expor token em URL', async () => {
    const calls: string[] = []
    const manager = {
      createInstance: (id: string | undefined, options: { url?: string }) => {
        calls.push(`create:${id}:${options.url ?? ''}`)
        return id ?? 'generated'
      },
      focus: (id: string) => {
        calls.push(`focus:${id}`)
      },
      getLiveInstance: (id: string) => calls.includes(`destroy:${id}`) ? undefined : ({ id }),
      destroyInstance: (id: string) => {
        calls.push(`destroy:${id}`)
      },
      reload: (id: string) => {
        calls.push(`reload:${id}`)
      },
    } as unknown as BrowserPaneManager

    const host = new HermesDashboardHost(manager)
    const ensure = async () => ({ success: true, url: 'http://127.0.0.1:49152', port: 49152 })

    await host.openDashboard(ensure)
    await host.openDashboard(ensure)

    expect(calls).toEqual([
      'create:hermes-dashboard-host:http://127.0.0.1:49152',
      'focus:hermes-dashboard-host',
      'focus:hermes-dashboard-host',
    ])
    expect(host.getStateForTest()).toEqual({
      instanceId: 'hermes-dashboard-host',
      dashboardUrl: 'http://127.0.0.1:49152',
    })
  })

  test('rejeita query string para nao transportar segredo ao renderer', async () => {
    const host = new HermesDashboardHost({} as BrowserPaneManager)

    await expect(host.openDashboard(async () => ({
      success: true,
      url: 'http://127.0.0.1:49152?token=secret',
    }))).rejects.toThrow('must not include query parameters')
  })
})
