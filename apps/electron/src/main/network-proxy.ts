/**
 * Network proxy manager — configures both Node.js (undici) and Electron session proxies.
 *
 * - Node side: replaces the global undici dispatcher with a ProtocolProxyDispatcher
 *   that routes HTTP/HTTPS through different ProxyAgent instances and respects NO_PROXY.
 * - Electron side: calls session.setProxy() on default + browser-pane sessions.
 */

import { app, session } from 'electron';
import { Agent, Dispatcher, ProxyAgent, setGlobalDispatcher } from 'undici';
import { parseNoProxyRules, shouldBypassProxy, splitCommaSeparated, type NoProxyRule } from './network-proxy-utils';
import { getNetworkProxySettings, setNetworkProxySettings, getBrowserProfiles } from '@craft-agent/shared/config/storage';
import type { NetworkProxySettings } from '@craft-agent/shared/config/types';
import { getProfilePartition } from './browser-profile-resolver';
import log from './logger';

// Track the current dispatcher so we can close it when reconfiguring
let currentProxyDispatcher: Dispatcher | null = null;

/**
 * Custom undici Dispatcher that routes requests through proxy agents based on protocol,
 * bypasses proxied destinations listed in NO_PROXY rules, and falls back to a direct Agent.
 */
class ProtocolProxyDispatcher extends Dispatcher {
  private httpProxy: ProxyAgent | null;
  private httpsProxy: ProxyAgent | null;
  private direct: Agent;
  private rules: NoProxyRule[];

  constructor(opts: {
    httpProxy?: string;
    httpsProxy?: string;
    noProxy?: string;
  }) {
    super();
    this.httpProxy = opts.httpProxy ? new ProxyAgent(opts.httpProxy) : null;
    this.httpsProxy = opts.httpsProxy ? new ProxyAgent(opts.httpsProxy) : null;
    this.direct = new Agent();
    this.rules = parseNoProxyRules(opts.noProxy);
  }

  dispatch(opts: Dispatcher.DispatchOptions, handler: Dispatcher.DispatchHandler): boolean {
    const url = typeof opts.origin === 'string' ? opts.origin : opts.origin?.toString();

    // If URL matches bypass rules, go direct
    if (url && shouldBypassProxy(url, this.rules)) {
      return this.direct.dispatch(opts, handler);
    }

    // Route based on protocol
    const isHttps = url?.startsWith('https:');
    const proxy = isHttps ? (this.httpsProxy ?? this.httpProxy) : this.httpProxy;

    if (proxy) {
      return proxy.dispatch(opts, handler);
    }

    return this.direct.dispatch(opts, handler);
  }

  async close(): Promise<void> {
    await Promise.all([
      this.httpProxy?.close(),
      this.httpsProxy?.close(),
      this.direct.close(),
    ]);
  }

  async destroy(): Promise<void> {
    await Promise.all([
      this.httpProxy?.destroy(),
      this.httpsProxy?.destroy(),
      this.direct.destroy(),
    ]);
  }
}

/**
 * Configure the Node.js global undici dispatcher for proxy routing.
 */
function configureNodeProxy(settings: NetworkProxySettings | undefined): void {
  // Close previous dispatcher (proxy or direct — both are tracked)
  if (currentProxyDispatcher) {
    currentProxyDispatcher.close().catch(() => {});
    currentProxyDispatcher = null;
  }

  if (!settings?.enabled || (!settings.httpProxy && !settings.httpsProxy)) {
    // Restore a direct dispatcher and track it so next reconfigure can close it
    const direct = new Agent();
    setGlobalDispatcher(direct);
    currentProxyDispatcher = direct;
    return;
  }

  const dispatcher = new ProtocolProxyDispatcher({
    httpProxy: settings.httpProxy,
    httpsProxy: settings.httpsProxy,
    noProxy: settings.noProxy,
  });

  setGlobalDispatcher(dispatcher);
  currentProxyDispatcher = dispatcher;
}

function getCurrentProxyConfig(): Electron.ProxyConfig {
  const settings = getNetworkProxySettings();
  return settings?.enabled
    ? buildElectronProxyConfig(settings)
    : { mode: 'direct' as const };
}

function getAllBrowserPanePartitions(): string[] {
  try {
    const ids = getBrowserProfiles().map(p => p.id);
    const partitions = new Set<string>();
    for (const id of ids) partitions.add(getProfilePartition(id));
    // Always include the legacy/default partition even if storage is empty
    // so a fresh install still gets the proxy applied.
    partitions.add(getProfilePartition(undefined));
    return Array.from(partitions);
  } catch {
    return [getProfilePartition(undefined)];
  }
}

/**
 * Configure Electron session proxies (default session + every browser-pane
 * profile partition). Requires app to be ready.
 */
async function configureElectronProxy(settings: NetworkProxySettings | undefined): Promise<void> {
  if (!app.isReady()) return;

  const proxyConfig = settings?.enabled
    ? buildElectronProxyConfig(settings)
    : { mode: 'direct' as const };

  const partitions = getAllBrowserPanePartitions();
  const sessions = [
    session.defaultSession,
    ...partitions.map(p => session.fromPartition(p)),
  ];

  await Promise.all(sessions.map(ses => ses.setProxy(proxyConfig)));
}

/**
 * Apply the currently configured proxy to a single profile partition.
 * Used after a new browser profile is created so it picks up app-wide settings
 * without requiring a full reapply pass.
 */
export async function applyProxyToProfilePartition(partition: string): Promise<void> {
  if (!app.isReady()) return;
  const ses = session.fromPartition(partition);
  await ses.setProxy(getCurrentProxyConfig());
}

function buildElectronProxyConfig(settings: NetworkProxySettings): Electron.ProxyConfig {
  const rules: string[] = [];

  if (settings.httpsProxy) {
    rules.push(`https=${settings.httpsProxy}`);
  }
  if (settings.httpProxy) {
    rules.push(`http=${settings.httpProxy}`);
  }

  if (rules.length === 0) {
    return { mode: 'direct' };
  }

  return {
    mode: 'fixed_servers',
    proxyRules: rules.join(';'),
    proxyBypassRules: settings.noProxy
      ? splitCommaSeparated(settings.noProxy).join(',')
      : undefined,
  };
}

/**
 * Read persisted proxy settings and apply to both Node and Electron.
 * Safe to call before app.whenReady() — Electron session setup is skipped until ready.
 */
export async function applyConfiguredProxySettings(): Promise<void> {
  const settings = getNetworkProxySettings();

  const hasHttpProxy = !!settings?.httpProxy;
  const hasNoProxy = !!settings?.noProxy;
  log.info('[proxy] Applying proxy settings:', {
    enabled: settings?.enabled ?? false,
    hasHttpProxy,
    hasHttpsProxy: !!settings?.httpsProxy,
    hasNoProxy,
  });

  configureNodeProxy(settings);
  await configureElectronProxy(settings);
}

/**
 * Persist new proxy settings and apply immediately.
 */
export async function updateConfiguredProxySettings(settings: NetworkProxySettings): Promise<void> {
  setNetworkProxySettings(settings);
  await applyConfiguredProxySettings();
}
