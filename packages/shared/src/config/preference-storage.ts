import { join } from 'path';
import { loadStoredConfig, saveConfig, loadConfigDefaults } from './storage.ts';
import { CONFIG_DIR } from './paths.ts';
import type { NetworkProxySettings, BrowserProfile, BrowserProfileSettings } from './types.ts';
import { DEFAULT_BROWSER_PROFILE_ID } from './types.ts';
import { normalizeBrowserProfileSettings } from './browser-profiles.ts';
import { DEFAULT_SERVER_CONFIG, type ServerConfig } from './server-config.ts';
import { randomUUID } from 'crypto';

const CONFIG_FILE = join(CONFIG_DIR, 'config.json');

/**
 * Get whether desktop notifications are enabled.
 * Defaults to true if not set.
 */
export function getNotificationsEnabled(): boolean {
  const config = loadStoredConfig();
  if (config?.notificationsEnabled !== undefined) {
    return config.notificationsEnabled;
  }
  const defaults = loadConfigDefaults();
  return defaults.defaults.notificationsEnabled;
}

/**
 * Set whether desktop notifications are enabled.
 */
export function setNotificationsEnabled(enabled: boolean): void {
  const config = loadStoredConfig();
  if (!config) return;
  config.notificationsEnabled = enabled;
  saveConfig(config);
}

export function getActiveHermesProfile(): string {
  const active = loadStoredConfig()?.activeHermesProfile?.trim();
  return active || 'default';
}

export function setActiveHermesProfile(name: string): boolean {
  const config = loadStoredConfig();
  if (!config) return false;
  config.activeHermesProfile = name.trim() || 'default';
  saveConfig(config);
  return true;
}

/**
 * Get whether auto-capitalisation is enabled.
 * Defaults to true if not set.
 */
export function getAutoCapitalisation(): boolean {
  const config = loadStoredConfig();
  if (config?.autoCapitalisation !== undefined) {
    return config.autoCapitalisation;
  }
  const defaults = loadConfigDefaults();
  return defaults.defaults.autoCapitalisation;
}

/**
 * Set whether auto-capitalisation is enabled.
 */
export function setAutoCapitalisation(enabled: boolean): void {
  const config = loadStoredConfig();
  if (!config) return;
  config.autoCapitalisation = enabled;
  saveConfig(config);
}

/**
 * Get the key combination used to send messages.
 * Defaults to 'enter' if not set.
 */
export function getSendMessageKey(): 'enter' | 'cmd-enter' {
  const config = loadStoredConfig();
  if (config?.sendMessageKey !== undefined) {
    return config.sendMessageKey;
  }
  const defaults = loadConfigDefaults();
  return defaults.defaults.sendMessageKey;
}

/**
 * Set the key combination used to send messages.
 */
export function setSendMessageKey(key: 'enter' | 'cmd-enter'): void {
  const config = loadStoredConfig();
  if (!config) return;
  config.sendMessageKey = key;
  saveConfig(config);
}

/**
 * Get whether spell check is enabled in the input.
 */
export function getSpellCheck(): boolean {
  const config = loadStoredConfig();
  if (config?.spellCheck !== undefined) {
    return config.spellCheck;
  }
  const defaults = loadConfigDefaults();
  return defaults.defaults.spellCheck;
}

/**
 * Set whether spell check is enabled in the input.
 */
export function setSpellCheck(enabled: boolean): void {
  const config = loadStoredConfig();
  if (!config) return;
  config.spellCheck = enabled;
  saveConfig(config);
}

/**
 * Get whether screen should stay awake while sessions are running.
 * Defaults to false if not set.
 */
export function getKeepAwakeWhileRunning(): boolean {
  const config = loadStoredConfig();
  if (config?.keepAwakeWhileRunning !== undefined) {
    return config.keepAwakeWhileRunning;
  }
  const defaults = loadConfigDefaults();
  return defaults.defaults.keepAwakeWhileRunning;
}

/**
 * Set whether screen should stay awake while sessions are running.
 */
export function setKeepAwakeWhileRunning(enabled: boolean): void {
  const config = loadStoredConfig();
  if (!config) return;
  config.keepAwakeWhileRunning = enabled;
  saveConfig(config);
}

/**
 * Get whether rich tool descriptions are enabled.
 * When enabled, all tool calls include intent and display name metadata.
 * Defaults to true if not set.
 */
export function getRichToolDescriptions(): boolean {
  const config = loadStoredConfig();
  if (config?.richToolDescriptions !== undefined) {
    return config.richToolDescriptions;
  }
  return true;
}

/**
 * Set whether rich tool descriptions are enabled.
 */
export function setRichToolDescriptions(enabled: boolean): void {
  const config = loadStoredConfig();
  if (!config) return;
  config.richToolDescriptions = enabled;
  saveConfig(config);
}

/**
 * Get whether extended prompt cache (1h TTL) is enabled.
 * When enabled, the interceptor upgrades cache_control TTL from 5m to 1h.
 * Defaults to false if not set.
 */
export function getExtendedPromptCache(): boolean {
  const config = loadStoredConfig();
  return config?.extendedPromptCache ?? false;
}

/**
 * Set whether extended prompt cache (1h TTL) is enabled.
 */
export function setExtendedPromptCache(enabled: boolean): void {
  const config = loadStoredConfig();
  if (!config) return;
  config.extendedPromptCache = enabled;
  saveConfig(config);
}

/**
 * Get whether the built-in browser tool is enabled.
 * When disabled, browser_tool is not included in session tools.
 * Defaults to true if not set.
 */
export function getBrowserToolEnabled(): boolean {
  const config = loadStoredConfig();
  if (config?.browserToolEnabled !== undefined) {
    return config.browserToolEnabled;
  }
  const defaults = loadConfigDefaults();
  return defaults.defaults.browserToolEnabled;
}

/**
 * Set whether the built-in browser tool is enabled.
 */
export function setBrowserToolEnabled(enabled: boolean): void {
  const config = loadStoredConfig();
  if (!config) return;
  config.browserToolEnabled = enabled;
  saveConfig(config);

  // Clear session tool caches so all sessions pick up the change immediately.
  // Lazy import to avoid circular dependency (storage ← session-scoped-tools ← storage).
  import('../agent/session-scoped-tools.ts').then(m => m.invalidateAllSessionToolsCaches()).catch(() => {});
}

/**
 * Get whether remote agents may run `browser_tool evaluate` against this
 * desktop client's local browser. The check is enforced inside the local
 * capability dispatcher; the remote server cannot override it.
 *
 * Defaults to true. Users can flip it off if they don't trust the remote
 * workspaces they connect to.
 */
export function getAllowRemoteEvaluate(): boolean {
  const config = loadStoredConfig();
  if (config?.allowRemoteEvaluate !== undefined) {
    return config.allowRemoteEvaluate;
  }
  const defaults = loadConfigDefaults();
  return defaults.defaults.allowRemoteEvaluate;
}

/**
 * Set whether remote agents may run `browser_tool evaluate` locally.
 */
export function setAllowRemoteEvaluate(allowed: boolean): void {
  const config = loadStoredConfig();
  if (!config) return;
  config.allowRemoteEvaluate = allowed;
  saveConfig(config);
}

/**
 * Get whether rtk Bash-output compression is enabled.
 * When enabled, the PreToolUse pipeline rewrites Bash commands to their `rtk` equivalents
 * to reduce token consumption on common dev commands (git, ls, grep, test runners, etc.).
 * Defaults to false — opt-in. Requires the `rtk` binary on PATH.
 * https://github.com/rtk-ai/rtk
 */
export function getRtkEnabled(): boolean {
  const config = loadStoredConfig();
  return config?.rtkEnabled === true;
}

/**
 * Set whether rtk Bash-output compression is enabled.
 */
export function setRtkEnabled(enabled: boolean): void {
  const config = loadStoredConfig();
  if (!config) return;
  config.rtkEnabled = enabled;
  saveConfig(config);
}

/**
 * Get whether TurnCards and their activity groups should auto-expand by default in chat.
 * Defaults to false (collapsed) to preserve historical behavior.
 */
export function getAutoExpandActivities(): boolean {
  const config = loadStoredConfig();
  return config?.autoExpandActivities === true;
}

/**
 * Set whether TurnCards and their activity groups should auto-expand by default in chat.
 */
export function setAutoExpandActivities(enabled: boolean): void {
  const config = loadStoredConfig();
  if (!config) return;
  config.autoExpandActivities = enabled;
  saveConfig(config);
}

/**
 * Get persisted Git Bash path (Windows only).
 * Used to set CLAUDE_CODE_GIT_BASH_PATH for the SDK subprocess.
 */
export function getGitBashPath(): string | undefined {
  const config = loadStoredConfig();
  return config?.gitBashPath;
}

/**
 * Set Git Bash path (Windows only).
 * Persists to config so it survives app restarts.
 * Returns false if the config could not be loaded (path not persisted).
 */
export function setGitBashPath(path: string): boolean {
  const config = loadStoredConfig();
  if (!config) {
    console.warn('[storage] Failed to persist Git Bash path: config could not be loaded');
    return false;
  }
  config.gitBashPath = path;
  saveConfig(config);
  return true;
}

/**
 * Clear persisted Git Bash path (Windows only).
 * Used when the stored path is stale or invalid.
 */
export function clearGitBashPath(): void {
  const config = loadStoredConfig();
  if (!config || !config.gitBashPath) return;
  delete config.gitBashPath;
  saveConfig(config);
}

export function getConfigPath(): string {
  return CONFIG_FILE;
}

// ============================================
// Network Proxy Settings
// ============================================

function normalizeProxyString(value: string | undefined): string | undefined {
  const trimmed = value?.trim();
  return trimmed || undefined;
}

function normalizeNetworkProxySettings(
  settings: NetworkProxySettings,
): NetworkProxySettings {
  return {
    enabled: Boolean(settings.enabled),
    httpProxy: normalizeProxyString(settings.httpProxy),
    httpsProxy: normalizeProxyString(settings.httpsProxy),
    noProxy: normalizeProxyString(settings.noProxy),
  };
}

/**
 * Get the current network proxy settings.
 * Returns undefined if not configured.
 */
export function getNetworkProxySettings(): NetworkProxySettings | undefined {
  const config = loadStoredConfig();
  return config?.networkProxy;
}

/**
 * Persist network proxy settings.
 * Deletes the key when disabled and all proxy fields are empty.
 */
export function setNetworkProxySettings(settings: NetworkProxySettings): void {
  const config = loadStoredConfig();
  if (!config) return;

  const normalized = normalizeNetworkProxySettings(settings);

  // Remove the key entirely when proxy is disabled and all fields are blank
  if (!normalized.enabled && !normalized.httpProxy && !normalized.httpsProxy && !normalized.noProxy) {
    delete config.networkProxy;
  } else {
    config.networkProxy = normalized;
  }

  saveConfig(config);
}

// ============================================
// Browser Profiles (per-profile session isolation)
// ============================================

function makeDefaultBrowserProfileSettings(): BrowserProfileSettings {
  return normalizeBrowserProfileSettings(null);
}

function normalizeAndDetectProfileSettings(settings: Partial<BrowserProfileSettings> | null | undefined): {
  settings: BrowserProfileSettings;
  changed: boolean;
} {
  const normalized = normalizeBrowserProfileSettings(settings);
  return {
    settings: normalized,
    changed: JSON.stringify(normalized) !== JSON.stringify(settings ?? null),
  };
}

/**
 * Read browser profile settings. Auto-seeds with a default profile
 * (mapped to the legacy `persist:browser-pane` partition) on first call.
 */
export function getBrowserProfileSettings(): BrowserProfileSettings {
  const config = loadStoredConfig();
  if (!config) return makeDefaultBrowserProfileSettings();

  if (!config.browserProfileSettings) {
    const seeded = makeDefaultBrowserProfileSettings();
    config.browserProfileSettings = seeded;
    saveConfig(config);
    return seeded;
  }

  const { settings: ensured, changed } = normalizeAndDetectProfileSettings(config.browserProfileSettings);
  if (changed) {
    config.browserProfileSettings = ensured;
    saveConfig(config);
  }
  return ensured;
}

export function getBrowserProfiles(): BrowserProfile[] {
  return getBrowserProfileSettings().profiles;
}

export function setBrowserProfiles(profiles: BrowserProfile[]): void {
  const config = loadStoredConfig();
  if (!config) return;
  const current = config.browserProfileSettings ?? makeDefaultBrowserProfileSettings();
  config.browserProfileSettings = normalizeBrowserProfileSettings({
    ...current,
    profiles,
  });
  saveConfig(config);
}

export function getLastUsedBrowserProfileId(): string {
  return getBrowserProfileSettings().lastUsedProfileId;
}

export function setLastUsedBrowserProfileId(id: string): void {
  const config = loadStoredConfig();
  if (!config) return;
  const current = config.browserProfileSettings ?? makeDefaultBrowserProfileSettings();
  const exists = current.profiles.some(p => p.id === id);
  config.browserProfileSettings = normalizeBrowserProfileSettings({
    ...current,
    lastUsedProfileId: exists ? id : DEFAULT_BROWSER_PROFILE_ID,
  });
  saveConfig(config);
}

export function getBrowserPickerAlwaysAsk(): boolean {
  return getBrowserProfileSettings().alwaysAsk;
}

export function setBrowserPickerAlwaysAsk(alwaysAsk: boolean): void {
  const config = loadStoredConfig();
  if (!config) return;
  const current = config.browserProfileSettings ?? makeDefaultBrowserProfileSettings();
  config.browserProfileSettings = normalizeBrowserProfileSettings({
    ...current,
    alwaysAsk,
  });
  saveConfig(config);
}

// ============================================
// Setup Deferred (user skipped onboarding)
// ============================================

export function isSetupDeferred(): boolean {
  return loadStoredConfig()?.setupDeferred === true;
}

export function setSetupDeferred(deferred: boolean): void {
  const config = loadStoredConfig();
  if (!config) return;
  if (deferred) {
    config.setupDeferred = true;
  } else {
    delete config.setupDeferred;
  }
  saveConfig(config);
}

// ============================================
// Server Mode Configuration
// ============================================

/**
 * Get the current server configuration.
 * Returns defaults if not yet configured.
 */
export function getServerConfig(): ServerConfig {
  const config = loadStoredConfig();
  return config?.serverConfig ?? { ...DEFAULT_SERVER_CONFIG };
}

/**
 * Persist server configuration.
 * Auto-generates a stable auth token on first enable if none exists.
 */
export function setServerConfig(serverConfig: ServerConfig): void {
  const config = loadStoredConfig();
  if (!config) return;

  // Generate a stable token when first enabled (or if token is missing)
  if (serverConfig.enabled && !serverConfig.token) {
    serverConfig.token = randomUUID();
  }

  config.serverConfig = serverConfig;
  saveConfig(config);
}
