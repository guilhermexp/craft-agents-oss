/**
 * Config Types (Browser-safe)
 *
 * Pure type definitions for configuration.
 * Re-exports from @craft-agent/core for compatibility.
 */

// Re-export all config types from core (single source of truth)
export type {
  Workspace,
  McpAuthType,
  AuthType,
  OAuthCredentials,
} from '@craft-agent/core/types';

/** App-level network proxy configuration. */
export interface NetworkProxySettings {
  enabled: boolean;
  httpProxy?: string;
  httpsProxy?: string;
  noProxy?: string;
}

/**
 * Browser profile — isolates cookies, localStorage, IndexedDB, and cache
 * by mapping each profile to a distinct Electron session partition.
 *
 * The default profile uses the legacy partition string ('persist:browser-pane')
 * so existing cookies survive without migration.
 */
export type BrowserProfileKind = 'personal' | 'client' | 'bot' | 'test';

export interface BrowserProfile {
  id: string;
  name: string;
  /** Hex color used for the avatar circle when no custom image is set. */
  color: string;
  /** Optional custom avatar (data URL or absolute file path). */
  avatar?: string;
  /** Product identity for this browser context: personal, client, bot, or test. */
  kind?: BrowserProfileKind;
  /** Optional client/account label shown in profile management surfaces. */
  clientName?: string;
  /** Human note explaining what this logged-in browser context is for. */
  description?: string;
  /** Hostname hints (e.g. cliente.com.br) used to suggest this profile for URLs. */
  domainHints?: string[];
  /** When true, agent-owned browser instances cannot resolve this profile. */
  userOnly?: boolean;
  createdAt: number;
  lastUsedAt?: number;
}

export type BrowserProfileInput = {
  name: string;
  color?: string;
  avatar?: string;
  kind?: BrowserProfileKind | string;
  clientName?: string;
  description?: string;
  domainHints?: string[];
  userOnly?: boolean;
};

export interface BrowserProfileSettings {
  profiles: BrowserProfile[];
  lastUsedProfileId: string;
  /** When true, picker is shown every time a preview window opens. */
  alwaysAsk: boolean;
}

/** Stable id for the legacy/default profile. Maps to `persist:browser-pane`. */
export const DEFAULT_BROWSER_PROFILE_ID = 'default';
