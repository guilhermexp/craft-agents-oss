import type { HermesDashboardResult } from '@craft-agent/shared/protocol'
import type { IHermesDashboardHost } from '@craft-agent/server-core/handlers'
import type { BrowserPaneManager, BrowserNavigationDecision } from '../browser-pane-manager'
import { mainLog } from '../logger'

const HERMES_DASHBOARD_BROWSER_ID = 'hermes-dashboard-host'
const CRAFT_DEEPLINK_SCHEME_PREFIX = `${process.env.CRAFT_DEEPLINK_SCHEME || 'craftagents'}://`

export interface HermesDashboardHostState {
  instanceId: string | null
  dashboardUrl: string | null
}

export function isHermesDashboardUrlAllowed(url: string, activeDashboardUrl: string): boolean {
  let parsed: URL
  let active: URL
  try {
    parsed = new URL(url)
    active = new URL(activeDashboardUrl)
  } catch {
    return false
  }

  return parsed.protocol === active.protocol
    && parsed.hostname === active.hostname
    && parsed.port === active.port
}

export function decideHermesDashboardNavigation(url: string, activeDashboardUrl: string): BrowserNavigationDecision {
  if (url.startsWith(CRAFT_DEEPLINK_SCHEME_PREFIX)) {
    return { action: 'allow' }
  }

  if (isHermesDashboardUrlAllowed(url, activeDashboardUrl)) {
    return { action: 'allow' }
  }

  return { action: 'deny', reason: 'hermes-dashboard-origin' }
}

function assertDashboardUrlIsSafe(url: string): void {
  const parsed = new URL(url)
  if (parsed.protocol !== 'http:' || !['127.0.0.1', 'localhost', '::1'].includes(parsed.hostname)) {
    throw new Error(`Hermes dashboard URL must be local http, got ${parsed.origin}`)
  }
  if (parsed.searchParams.size > 0) {
    throw new Error('Hermes dashboard URL must not include query parameters')
  }
}

export class HermesDashboardHost implements IHermesDashboardHost {
  private readonly state: HermesDashboardHostState = {
    instanceId: null,
    dashboardUrl: null,
  }

  constructor(private readonly browserPaneManager: BrowserPaneManager) {}

  getStateForTest(): HermesDashboardHostState {
    return { ...this.state }
  }

  async openDashboard(ensureDashboardRunning: () => Promise<HermesDashboardResult>): Promise<HermesDashboardResult> {
    const dashboard = await ensureDashboardRunning()
    if (!dashboard.success || !dashboard.url) {
      return dashboard
    }

    assertDashboardUrlIsSafe(dashboard.url)
    const activeUrl = dashboard.url
    const existing = this.state.instanceId ? this.browserPaneManager.getInstance(this.state.instanceId) : undefined

    if (existing && this.state.dashboardUrl === activeUrl) {
      this.browserPaneManager.focus(this.state.instanceId!)
      return dashboard
    }

    if (existing && this.state.instanceId) {
      this.browserPaneManager.destroyInstance(this.state.instanceId)
    }

    const instanceId = this.browserPaneManager.createInstance(HERMES_DASHBOARD_BROWSER_ID, {
      show: true,
      url: activeUrl,
      navigationPolicy: {
        willNavigate: (url) => decideHermesDashboardNavigation(url, activeUrl),
        windowOpen: (url) => decideHermesDashboardNavigation(url, activeUrl),
      },
    })
    this.state.instanceId = instanceId
    this.state.dashboardUrl = activeUrl
    this.browserPaneManager.focus(instanceId)
    mainLog.info(`[hermes-dashboard-host] opened dashboard instance=${instanceId} url=${activeUrl}`)
    return dashboard
  }

  async reloadDashboard(ensureDashboardRunning: () => Promise<HermesDashboardResult>): Promise<HermesDashboardResult> {
    const dashboard = await ensureDashboardRunning()
    if (!dashboard.success || !dashboard.url) {
      return dashboard
    }

    assertDashboardUrlIsSafe(dashboard.url)
    if (!this.state.instanceId || this.state.dashboardUrl !== dashboard.url) {
      return this.openDashboard(async () => dashboard)
    }

    this.browserPaneManager.reload(this.state.instanceId)
    this.browserPaneManager.focus(this.state.instanceId)
    return dashboard
  }

  closeDashboard(): void {
    if (this.state.instanceId) {
      this.browserPaneManager.destroyInstance(this.state.instanceId)
    }
    this.state.instanceId = null
    this.state.dashboardUrl = null
  }
}
