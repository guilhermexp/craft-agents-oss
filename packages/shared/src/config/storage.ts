import { existsSync, mkdirSync, readFileSync, writeFileSync, rmSync } from 'fs';
import { join } from 'path';
import {
  loadWorkspaceConfig,
  saveWorkspaceConfig,
  createWorkspaceAtPath,
  isValidWorkspace,
} from '../workspaces/storage.ts';
import { initializeDocs } from '../docs/index.ts';
import { expandPath, toPortablePath, getBundledAssetsDir } from '../utils/paths.ts';
import { debug } from '../utils/debug.ts';
import { readJsonFileSync } from '../utils/files.ts';
import { CONFIG_DIR } from './paths.ts';
import type { PermissionMode } from '../agent/mode-manager.ts';
import type { ThinkingLevel } from '../agent/thinking-levels.ts';
import { parsePermissionMode, PERMISSION_MODE_ORDER } from '../agent/mode-types.ts';
import { type ConfigDefaults } from './config-defaults-schema.ts';
import { ensureToolIcons } from './tool-icon-storage.ts';
import type { LlmConnection } from './llm-connections.ts';

// Re-export CONFIG_DIR for convenience (centralized in paths.ts)
export { CONFIG_DIR } from './paths.ts';

// Re-export base types from core (single source of truth)
export type {
  WorkspaceInfo,
  Workspace,
  McpAuthType,
  AuthType,
  OAuthCredentials,
} from '@craft-agent/core/types';

// Import for local use
import type { Workspace } from '@craft-agent/core/types';

// Config stored in JSON file (credentials stored in encrypted file, not here)
export interface StoredConfig {
  // LLM Connections (authoritative source for auth and model config)
  llmConnections?: LlmConnection[];
  defaultLlmConnection?: string;  // Slug of default connection for new sessions
  defaultThinkingLevel?: ThinkingLevel;  // App-level default thinking level for new sessions

  workspaces: Workspace[];
  activeWorkspaceId: string | null;
  activeSessionId: string | null;  // Currently active session (primary scope)
  // Notifications
  notificationsEnabled?: boolean;  // Desktop notifications for task completion (default: true)
  // Appearance
  colorTheme?: string;  // ID of selected preset theme (e.g., 'dracula', 'nord'). Default: 'default'
  // Auto-update
  dismissedUpdateVersion?: string;  // Version that user dismissed (skip notifications for this version)
  // Input settings
  autoCapitalisation?: boolean;  // Auto-capitalize first letter when typing (default: true)
  sendMessageKey?: 'enter' | 'cmd-enter';  // Key to send messages (default: 'enter')
  spellCheck?: boolean;  // Enable spell check in input (default: false)
  // Power settings
  keepAwakeWhileRunning?: boolean;  // Prevent screen sleep while sessions are running (default: false)
  // Tool metadata
  richToolDescriptions?: boolean;  // Add intent/action metadata to all tool calls (default: true)
  // Chat appearance
  autoExpandActivities?: boolean;  // Auto-expand TurnCards and activity groups in the chat (default: false)
  // Tools
  browserToolEnabled?: boolean;  // Enable built-in browser tool (default: true). Disable for Playwright/Puppeteer.
  allowRemoteEvaluate?: boolean;  // Allow remote agents to call `browser_tool evaluate` on local browser (default: true).
  // Prompt caching & context
  extendedPromptCache?: boolean;  // Use 1h prompt cache TTL instead of 5m (default: false)
  enable1MContext?: boolean;  // Enable 1M context window for supported models (default: false — opt-in; requires Anthropic Tier 4+)
  // Token optimization
  rtkEnabled?: boolean;  // Route Bash commands through rtk to compress tool output (default: false). https://github.com/rtk-ai/rtk
  // Network proxy
  networkProxy?: import('./types.ts').NetworkProxySettings;
  // Browser profiles — isolation per profile (cookies/storage/cache)
  browserProfileSettings?: import('./types.ts').BrowserProfileSettings;
  // Hermes profile used by new Hermes chat turns. "default" means base HERMES_HOME.
  activeHermesProfile?: string;
  // Windows: path to Git Bash (bash.exe) for the SDK subprocess
  gitBashPath?: string;
  // User chose "Setup later" during onboarding — skip showing onboarding on next launch
  setupDeferred?: boolean;
  // Server mode — embedded remote server settings
  serverConfig?: import('./server-config.ts').ServerConfig;
  // One-shot migration markers. Used by migrations that should run at most
  // once per user (e.g. restoring a previously-removed model to connection
  // lists without re-adding it if the user later removes it deliberately).
  migrationsApplied?: string[];
}

const CONFIG_FILE = join(CONFIG_DIR, 'config.json');
const CONFIG_DEFAULTS_FILE = join(CONFIG_DIR, 'config-defaults.json');

// Track if config-defaults have been synced this session (prevents re-sync on hot reload)
let configDefaultsSynced = false;

const FALLBACK_CONFIG_DEFAULTS: ConfigDefaults = {
  version: '1.0',
  description: 'Default configuration values for Craft Agents',
  defaults: {
    notificationsEnabled: true,
    colorTheme: 'default',
    autoCapitalisation: true,
    sendMessageKey: 'enter',
    spellCheck: false,
    keepAwakeWhileRunning: false,
    richToolDescriptions: true,
    extendedPromptCache: false,
    browserToolEnabled: true,
    allowRemoteEvaluate: true,
  },
  workspaceDefaults: {
    thinkingLevel: 'medium',
    permissionMode: 'ask',
    cyclablePermissionModes: ['safe', 'ask', 'allow-all'],
    localMcpServers: { enabled: true },
  },
};

function syncConfigDefaults(): void {
  if (configDefaultsSynced) return;
  configDefaultsSynced = true;

  // Get bundled config-defaults.json from resources folder
  const bundledDir = getBundledAssetsDir('.');
  if (!bundledDir) {
    debug('[config] No bundled assets dir found - using fallback config-defaults');
    if (!existsSync(CONFIG_DEFAULTS_FILE)) {
      writeFileSync(CONFIG_DEFAULTS_FILE, JSON.stringify(FALLBACK_CONFIG_DEFAULTS, null, 2), 'utf-8');
    }
    return;
  }

  const bundledFile = join(bundledDir, 'config-defaults.json');
  if (!existsSync(bundledFile)) {
    debug('[config] Bundled config-defaults.json not found at: ' + bundledFile + ' - using fallback');
    if (!existsSync(CONFIG_DEFAULTS_FILE)) {
      writeFileSync(CONFIG_DEFAULTS_FILE, JSON.stringify(FALLBACK_CONFIG_DEFAULTS, null, 2), 'utf-8');
    }
    return;
  }

  // Sync from bundled file (same pattern as docs)
  const content = readFileSync(bundledFile, 'utf-8');
  writeFileSync(CONFIG_DEFAULTS_FILE, content, 'utf-8');
  debug('[config] Synced config-defaults.json from bundled assets');
}

export function loadConfigDefaults(): ConfigDefaults {
  if (!existsSync(CONFIG_DEFAULTS_FILE)) {
    throw new Error('config-defaults.json not found at ' + CONFIG_DEFAULTS_FILE + '. Ensure ensureConfigDir() was called at startup.');
  }

  const defaults = readJsonFileSync<ConfigDefaults>(CONFIG_DEFAULTS_FILE);

  const parsedPermissionMode =
    typeof defaults.workspaceDefaults?.permissionMode === 'string'
      ? parsePermissionMode(defaults.workspaceDefaults.permissionMode)
      : null;
  defaults.workspaceDefaults.permissionMode = parsedPermissionMode ?? 'ask';

  const rawCyclable = Array.isArray(defaults.workspaceDefaults?.cyclablePermissionModes)
    ? defaults.workspaceDefaults.cyclablePermissionModes
    : [];

  const normalizedCyclable: PermissionMode[] = [];
  for (const mode of rawCyclable) {
    if (typeof mode !== 'string') continue;
    const parsed = parsePermissionMode(mode);
    if (!parsed) continue;
    if (!normalizedCyclable.includes(parsed)) {
      normalizedCyclable.push(parsed);
    }
  }

  defaults.workspaceDefaults.cyclablePermissionModes =
    normalizedCyclable.length >= 2 ? normalizedCyclable : [...PERMISSION_MODE_ORDER];

  return defaults;
}

export function ensureConfigDefaults(): void {
  syncConfigDefaults();
}

let configDirInitialized = false;

export function ensureConfigDir(): void {
  if (configDirInitialized) return;

  if (!existsSync(CONFIG_DIR)) {
    mkdirSync(CONFIG_DIR, { recursive: true });
  }
  // Initialize bundled docs (creates ~/.craft-agent/docs/ with sources.md, agents.md, permissions.md)
  initializeDocs();

  // Initialize config defaults
  ensureConfigDefaults();

  // Initialize tool icons (CLI tool icons for turn card display)
  ensureToolIcons();

  configDirInitialized = true;
}

export function loadStoredConfig(): StoredConfig | null {
  try {
    if (!existsSync(CONFIG_FILE)) {
      return null;
    }
    const config = readJsonFileSync<StoredConfig>(CONFIG_FILE);

    // Must have workspaces array
    if (!Array.isArray(config.workspaces)) {
      return null;
    }

    // Expand path variables (~ and ${HOME}) for portability
    for (const workspace of config.workspaces) {
      workspace.rootPath = expandPath(workspace.rootPath);
    }

    // Validate active workspace exists
    const activeWorkspace = config.workspaces.find(w => w.id === config.activeWorkspaceId);
    if (!activeWorkspace) {
      // Default to first workspace
      config.activeWorkspaceId = config.workspaces[0]?.id || null;
    }

    // Ensure workspace folder structure exists for all workspaces.
    // Failures here are non-fatal — the workspace will be re-created on next access.
    for (const workspace of config.workspaces) {
      if (!isValidWorkspace(workspace.rootPath)) {
        try {
          createWorkspaceAtPath(workspace.rootPath, workspace.name);
        } catch (wsError) {
          debug('[config] Failed to create workspace at', workspace.rootPath, ':', wsError instanceof Error ? wsError.message : wsError);
        }
      }
    }

    return config;
  } catch (error) {
    debug('[config] loadStoredConfig failed:', error instanceof Error ? error.message : error);
    return null;
  }
}

export function saveConfig(config: StoredConfig): void {
  ensureConfigDir();

  // Convert paths to portable form (~ prefix) for cross-machine compatibility
  const storageConfig: StoredConfig = {
    ...config,
    workspaces: config.workspaces.map(ws => ({
      ...ws,
      rootPath: toPortablePath(ws.rootPath),
    })),
  };

  writeFileSync(CONFIG_FILE, JSON.stringify(storageConfig, null, 2), 'utf-8');
}

export async function clearAllConfig(): Promise<void> {
  // Delete config file
  if (existsSync(CONFIG_FILE)) {
    rmSync(CONFIG_FILE);
  }

  // Delete credentials file
  const credentialsFile = join(CONFIG_DIR, 'credentials.enc');
  if (existsSync(credentialsFile)) {
    rmSync(credentialsFile);
  }

  // Optionally: Delete workspace data (conversations)
  const workspacesDir = join(CONFIG_DIR, 'workspaces');
  if (existsSync(workspacesDir)) {
    rmSync(workspacesDir, { recursive: true });
  }
}

// ============================================
// Extracted domain modules — re-exports for backward compatibility
// ============================================

// Preferences
export { getNotificationsEnabled, setNotificationsEnabled, getActiveHermesProfile, setActiveHermesProfile, getAutoCapitalisation, setAutoCapitalisation, getSendMessageKey, setSendMessageKey, getSpellCheck, setSpellCheck, getKeepAwakeWhileRunning, setKeepAwakeWhileRunning, getRichToolDescriptions, setRichToolDescriptions, getExtendedPromptCache, setExtendedPromptCache, getBrowserToolEnabled, setBrowserToolEnabled, getAllowRemoteEvaluate, setAllowRemoteEvaluate, getEnable1MContext, setEnable1MContext, getRtkEnabled, setRtkEnabled, getAutoExpandActivities, setAutoExpandActivities, getGitBashPath, setGitBashPath, clearGitBashPath, getConfigPath } from './preference-storage.ts';

// Network proxy, browser profiles, setup deferred, server config
export { getNetworkProxySettings, setNetworkProxySettings, getBrowserProfileSettings, getBrowserProfiles, setBrowserProfiles, getLastUsedBrowserProfileId, setLastUsedBrowserProfileId, getBrowserPickerAlwaysAsk, setBrowserPickerAlwaysAsk, isSetupDeferred, setSetupDeferred, getServerConfig, setServerConfig } from './preference-storage.ts';

// Workspaces
export {
  generateWorkspaceId,
  findWorkspaceIcon,
  getWorkspaces,
  getActiveWorkspace,
  getWorkspaceByNameOrId,
  updateWorkspaceRemoteServer,
  setActiveWorkspace,
  switchWorkspaceAtomic,
  addWorkspace,
  syncWorkspaces,
  removeWorkspace,
  type WorkspaceConversation,
  type StoredAttachment,
  type StoredMessage,
  saveWorkspaceConversation,
  loadWorkspaceConversation,
  getWorkspaceDataPath,
  clearWorkspaceConversation,
  saveWorkspacePlan,
  loadWorkspacePlan,
  clearWorkspacePlan,
} from './workspace-storage.ts';

// Drafts
export { type DraftAttachmentContent, type DraftAttachmentRef, type SessionDraft, getSessionDraft, setSessionDraft, deleteSessionDraft, getAllSessionDrafts } from './draft-storage.ts';

// Theme storage
export { getAppThemePath, getAppThemesDir, loadAppTheme, saveAppTheme, ensurePresetThemes, loadPresetThemes, loadPresetTheme, getPresetThemesDir, resetPresetTheme, getColorTheme, setColorTheme, getDismissedUpdateVersion, setDismissedUpdateVersion, clearDismissedUpdateVersion } from './theme-storage.ts';

// LLM Connection types
export type {
  LlmConnection,
  LlmProviderType,
  LlmAuthType,
  LlmConnectionWithStatus,
} from './llm-connections.ts';

// LLM Connection migrations
export {
  shouldMigratePiOpenAiProvider,
  shouldRepairPiApiKeyCodexProvider,
  inferModelSelectionMode,
  migrateLegacyLlmConnectionsConfig,
  migrateOrphanedDefaultConnections,
  ensureDefaultLlmConnection,
  migrateLegacyCredentials,
} from './llm-connection-migrations.ts';

// LLM Connection CRUD
export {
  getLlmConnections,
  getLlmConnection,
  addLlmConnection,
  updateLlmConnection,
  deleteLlmConnection,
  getDefaultLlmConnection,
  setDefaultLlmConnection,
  getDefaultThinkingLevel,
  setDefaultThinkingLevel,
  touchLlmConnection,
} from './llm-connection-storage.ts';

// Tool Icons
export { getToolIconsDir, ensureToolIcons } from './tool-icon-storage.ts';
