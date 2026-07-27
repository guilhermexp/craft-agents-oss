/**
 * Credential Manager
 *
 * Main interface for credential storage. Uses encrypted file storage
 * for cross-platform compatibility without OS keychain prompts.
 */

import type { CredentialBackend } from './backends/types.ts';
import type { CredentialId, CredentialType, StoredCredential, CredentialHealthStatus, CredentialHealthIssue } from './types.ts';
import type { LlmAuthType, LlmProviderType } from '../config/llm-connections.ts';
import { SecureStorageBackend } from './backends/secure-storage.ts';
import { credentialIdToAccount } from './types.ts';
import { debug } from '../utils/debug.ts';

/**
 * A resolved LLM credential carrying the actual secret value(s) for a
 * connection, discriminated by how the credential must be applied downstream.
 *
 * This is the single value-bearing projection of `authType -> credential`.
 * `hasLlmCredentials` is the thin boolean derived from it (`!== null`).
 */
export type ResolvedLlmCredential =
  | { kind: 'api_key'; value: string }
  | { kind: 'oauth'; accessToken: string; refreshToken?: string; expiresAt?: number }
  | { kind: 'iam'; accessKeyId: string; secretAccessKey: string; region?: string; sessionToken?: string }
  | { kind: 'service_account'; path: string }
  | { kind: 'environment'; value: string }
  | { kind: 'none' };

export class CredentialManager {
  private backends: CredentialBackend[] = [];
  private writeBackend: CredentialBackend | null = null;
  private initialized = false;
  private initPromise: Promise<void> | null = null;

  /**
   * In-memory credentials that take precedence over every persistent backend
   * and are never written to disk. Populated between {@link setEphemeralLlmApiKey}
   * and {@link clearEphemeralLlmApiKey} — connection-test flows that must resolve
   * a credential by slug without leaving a throwaway entry in the store.
   */
  private readonly ephemeralCredentials = new Map<string, StoredCredential>();

  /**
   * @param injectedBackends - Optional explicit backend list. When provided the
   *   manager uses exactly these backends (highest priority first) and skips
   *   platform auto-detection. Primarily a dependency-injection seam for tests
   *   that need an in-memory store instead of the on-disk SecureStorageBackend.
   */
  constructor(injectedBackends?: CredentialBackend[]) {
    if (injectedBackends && injectedBackends.length > 0) {
      this.backends = [...injectedBackends].sort((a, b) => b.priority - a.priority);
      this.writeBackend = this.backends[0] ?? null;
      this.initialized = true;
    }
  }

  /**
   * Explicitly initialize the credential manager.
   * This is optional - methods auto-initialize via ensureInitialized().
   * Use this for eager initialization at app startup if desired.
   */
  async initialize(): Promise<void> {
    await this.ensureInitialized();
  }

  /**
   * Internal: ensure initialization has completed.
   * Called automatically by all public methods.
   */
  private async ensureInitialized(): Promise<void> {
    if (this.initialized) {
      return;
    }
    // Prevent race condition with concurrent initialization
    if (this.initPromise) {
      return this.initPromise;
    }

    // Clear promise on failure so initialization can be retried
    this.initPromise = this._doInitialize().catch((err) => {
      this.initPromise = null;
      throw err;
    });
    await this.initPromise;
  }

  private ensureInitializedSync(): void {
    if (this.initialized) {
      return;
    }

    // SecureStorageBackend is always available and is currently the only
    // credential backend. This sync path exists for sync callers such as
    // saveSourceConfig(), where fire-and-forget cleanup can race immediate reloads.
    const backend = new SecureStorageBackend();
    this.backends = [backend];
    this.writeBackend = backend;
    this.initialized = true;
    this.initPromise = null;
    debug(`[CredentialManager] Backend available: ${backend.name} (priority ${backend.priority})`);
    debug(`[CredentialManager] Using backend: ${backend.name}`);
  }

  private async _doInitialize(): Promise<void> {
    const potentialBackends: CredentialBackend[] = [
      new SecureStorageBackend(),
    ];
    const availableBackends: CredentialBackend[] = [];

    // Check which backends are available
    for (const backend of potentialBackends) {
      if (await backend.isAvailable()) {
        availableBackends.push(backend);
        debug(`[CredentialManager] Backend available: ${backend.name} (priority ${backend.priority})`);
      }
    }

    // A synchronous caller may have initialized the singleton while the async
    // availability checks above were in flight. In that case, keep the sync state
    // instead of appending duplicate backends.
    if (this.initialized) return;

    // Sort by priority (highest first)
    availableBackends.sort((a, b) => b.priority - a.priority);
    this.backends = availableBackends;

    // Use the first available backend for writing
    this.writeBackend = this.backends[0] || null;

    if (this.writeBackend) {
      debug(`[CredentialManager] Using backend: ${this.writeBackend.name}`);
    } else {
      debug(`[CredentialManager] WARNING: No backend available.`);
    }

    this.initialized = true;
  }

  /** Get the name of the active write backend */
  getActiveBackendName(): string | null {
    return this.writeBackend?.name || null;
  }

  /**
   * Get a credential by ID, trying all backends.
   * Automatically initializes if needed.
   */
  async get(id: CredentialId): Promise<StoredCredential | null> {
    await this.ensureInitialized();

    const ephemeral = this.ephemeralCredentials.get(credentialIdToAccount(id));
    if (ephemeral) {
      return ephemeral;
    }

    for (const backend of this.backends) {
      try {
        const cred = await backend.get(id);
        if (cred) {
          debug(`[CredentialManager] Found ${id.type} in ${backend.name}`);
          return cred;
        }
      } catch (err) {
        debug(`[CredentialManager] Error reading from ${backend.name}:`, err);
      }
    }

    return null;
  }

  /**
   * Set a credential using the write backend.
   * Automatically initializes if needed.
   */
  async set(id: CredentialId, credential: StoredCredential): Promise<void> {
    await this.ensureInitialized();

    if (!this.writeBackend) {
      throw new Error('No writable credential backend available');
    }

    await this.writeBackend.set(id, credential);
    debug(`[CredentialManager] Saved ${id.type} to ${this.writeBackend.name}`);
  }

  /**
   * Delete a credential from all backends.
   * Automatically initializes if needed.
   */
  async delete(id: CredentialId): Promise<boolean> {
    await this.ensureInitialized();

    let deleted = false;
    for (const backend of this.backends) {
      try {
        if (await backend.delete(id)) {
          deleted = true;
          debug(`[CredentialManager] Deleted ${id.type} from ${backend.name}`);
        }
      } catch (err) {
        debug(`[CredentialManager] Error deleting from ${backend.name}:`, err);
      }
    }

    return deleted;
  }

  deleteSync(id: CredentialId): boolean {
    this.ensureInitializedSync();

    let deleted = false;
    for (const backend of this.backends) {
      if (!backend.deleteSync) {
        debug(`[CredentialManager] Backend ${backend.name} does not support synchronous delete`);
        continue;
      }

      try {
        if (backend.deleteSync(id)) {
          deleted = true;
          debug(`[CredentialManager] Deleted ${id.type} from ${backend.name}`);
        }
      } catch (err) {
        debug(`[CredentialManager] Error deleting from ${backend.name}:`, err);
      }
    }

    return deleted;
  }

  /**
   * List credentials matching a filter.
   * Automatically initializes if needed.
   */
  async list(filter?: Partial<CredentialId>): Promise<CredentialId[]> {
    await this.ensureInitialized();

    const seen = new Set<string>();
    const results: CredentialId[] = [];

    for (const backend of this.backends) {
      try {
        const ids = await backend.list(filter);
        for (const id of ids) {
          const key = JSON.stringify(id);
          if (!seen.has(key)) {
            seen.add(key);
            results.push(id);
          }
        }
      } catch (err) {
        debug(`[CredentialManager] Error listing from ${backend.name}:`, err);
      }
    }

    return results;
  }

  // ============================================================
  // Convenience Methods
  // ============================================================

  /** Get Anthropic API key */
  async getApiKey(): Promise<string | null> {
    const cred = await this.get({ type: 'anthropic_api_key' });
    return cred?.value || null;
  }

  /** Set Anthropic API key */
  async setApiKey(key: string): Promise<void> {
    await this.set({ type: 'anthropic_api_key' }, { value: key });
  }

  /** Get Claude OAuth token */
  async getClaudeOAuth(): Promise<string | null> {
    const cred = await this.get({ type: 'claude_oauth' });
    return cred?.value || null;
  }

  /** Set Claude OAuth token */
  async setClaudeOAuth(token: string): Promise<void> {
    await this.set({ type: 'claude_oauth' }, { value: token });
  }

  /** Get Claude OAuth credentials (with refresh token, expiry, and source) */
  async getClaudeOAuthCredentials(): Promise<{
    accessToken: string;
    refreshToken?: string;
    expiresAt?: number;
    /** Where the token came from: 'native' (our OAuth), 'cli' (Claude CLI import), or undefined (unknown) */
    source?: 'native' | 'cli';
  } | null> {
    const cred = await this.get({ type: 'claude_oauth' });
    if (!cred) return null;

    return {
      accessToken: cred.value,
      refreshToken: cred.refreshToken,
      expiresAt: cred.expiresAt,
      source: cred.source as 'native' | 'cli' | undefined,
    };
  }

  /** Set Claude OAuth credentials (with refresh token, expiry, and source) */
  async setClaudeOAuthCredentials(credentials: {
    accessToken: string;
    refreshToken?: string;
    expiresAt?: number;
    /** Where the token came from: 'native' (our OAuth), 'cli' (Claude CLI import) */
    source?: 'native' | 'cli';
  }): Promise<void> {
    await this.set({ type: 'claude_oauth' }, {
      value: credentials.accessToken,
      refreshToken: credentials.refreshToken,
      expiresAt: credentials.expiresAt,
      source: credentials.source,
    });
  }

  /** Get workspace MCP OAuth credentials */
  async getWorkspaceOAuth(workspaceId: string): Promise<{
    accessToken: string;
    tokenType?: string;
    clientId?: string;
  } | null> {
    const cred = await this.get({ type: 'workspace_oauth', workspaceId });
    if (!cred) return null;
    return {
      accessToken: cred.value,
      tokenType: cred.tokenType,
      clientId: cred.clientId,
    };
  }

  /** Set workspace MCP OAuth credentials */
  async setWorkspaceOAuth(workspaceId: string, credentials: {
    accessToken: string;
    tokenType?: string;
    clientId?: string;
  }): Promise<void> {
    await this.set(
      { type: 'workspace_oauth', workspaceId },
      {
        value: credentials.accessToken,
        tokenType: credentials.tokenType,
        clientId: credentials.clientId,
      }
    );
  }

  /** Delete all credentials for a workspace (source credentials) */
  async deleteWorkspaceCredentials(workspaceId: string): Promise<void> {
    const allCreds = await this.list({ workspaceId });
    for (const cred of allCreds) {
      await this.delete(cred);
    }
  }

  // Note: OpenAI API key methods removed - Codex uses native ChatGPT OAuth flow

  // ============================================================
  // LLM Connection Credentials
  // ============================================================

  /**
   * Get API key for an LLM connection.
   * @param connectionSlug - The connection slug
   * @returns API key or null if not found
   */
  async getLlmApiKey(connectionSlug: string): Promise<string | null> {
    const cred = await this.get({ type: 'llm_api_key', connectionSlug });
    return cred?.value || null;
  }

  /**
   * Set API key for an LLM connection.
   * @param connectionSlug - The connection slug
   * @param apiKey - The API key to store
   */
  async setLlmApiKey(connectionSlug: string, apiKey: string): Promise<void> {
    await this.set({ type: 'llm_api_key', connectionSlug }, { value: apiKey });
  }

  /**
   * Delete API key for an LLM connection.
   * @param connectionSlug - The connection slug
   * @returns true if deleted, false if not found
   */
  async deleteLlmApiKey(connectionSlug: string): Promise<boolean> {
    return this.delete({ type: 'llm_api_key', connectionSlug });
  }

  /**
   * Store an LLM API key in memory only — resolvable by slug (via
   * {@link getLlmApiKey}/{@link get}) but never written to any persistent
   * backend. This is the validate-without-persisting primitive for connection
   * tests: a synthetic connection can be exercised end to end without leaving a
   * throwaway credential on disk. Always pair with {@link clearEphemeralLlmApiKey}
   * (e.g. in a `finally`).
   */
  setEphemeralLlmApiKey(connectionSlug: string, apiKey: string): void {
    this.ephemeralCredentials.set(
      credentialIdToAccount({ type: 'llm_api_key', connectionSlug }),
      { value: apiKey },
    );
  }

  /** Remove an in-memory LLM API key stored via {@link setEphemeralLlmApiKey}. */
  clearEphemeralLlmApiKey(connectionSlug: string): void {
    this.ephemeralCredentials.delete(
      credentialIdToAccount({ type: 'llm_api_key', connectionSlug }),
    );
  }

  /**
   * Get OAuth token for an LLM connection.
   * @param connectionSlug - The connection slug
   * @returns OAuth credentials or null if not found
   */
  async getLlmOAuth(connectionSlug: string): Promise<{
    accessToken: string;
    refreshToken?: string;
    expiresAt?: number;
    /** OIDC id_token (used by OpenAI/Codex) */
    idToken?: string;
  } | null> {
    const cred = await this.get({ type: 'llm_oauth', connectionSlug });
    if (!cred) return null;
    return {
      accessToken: cred.value,
      refreshToken: cred.refreshToken,
      expiresAt: cred.expiresAt,
      idToken: cred.idToken,
    };
  }

  /**
   * Set OAuth token for an LLM connection.
   * @param connectionSlug - The connection slug
   * @param credentials - OAuth credentials to store
   */
  async setLlmOAuth(connectionSlug: string, credentials: {
    accessToken: string;
    refreshToken?: string;
    expiresAt?: number;
    /** OIDC id_token (used by OpenAI/Codex) */
    idToken?: string;
  }): Promise<void> {
    await this.set({ type: 'llm_oauth', connectionSlug }, {
      value: credentials.accessToken,
      refreshToken: credentials.refreshToken,
      expiresAt: credentials.expiresAt,
      idToken: credentials.idToken,
    });
  }

  /**
   * Delete all credentials for an LLM connection.
   * @param connectionSlug - The connection slug
   */
  async deleteLlmCredentials(connectionSlug: string): Promise<void> {
    await this.delete({ type: 'llm_api_key', connectionSlug });
    await this.delete({ type: 'llm_oauth', connectionSlug });
    await this.delete({ type: 'llm_iam', connectionSlug });
    await this.delete({ type: 'llm_service_account', connectionSlug });
  }

  // ============================================================
  // IAM Credentials (AWS Bedrock)
  // ============================================================

  /**
   * Get IAM credentials for an LLM connection.
   * @param connectionSlug - The connection slug
   * @returns IAM credentials or null if not found
   */
  async getLlmIamCredentials(connectionSlug: string): Promise<{
    accessKeyId: string;
    secretAccessKey: string;
    region?: string;
    sessionToken?: string;
  } | null> {
    const cred = await this.get({ type: 'llm_iam', connectionSlug });
    if (!cred || !cred.awsAccessKeyId) return null;
    return {
      accessKeyId: cred.awsAccessKeyId,
      secretAccessKey: cred.value, // Secret key stored in value field
      region: cred.awsRegion,
      sessionToken: cred.awsSessionToken,
    };
  }

  /**
   * Set IAM credentials for an LLM connection.
   * @param connectionSlug - The connection slug
   * @param credentials - IAM credentials to store
   */
  async setLlmIamCredentials(connectionSlug: string, credentials: {
    accessKeyId: string;
    secretAccessKey: string;
    region?: string;
    sessionToken?: string;
  }): Promise<void> {
    await this.set({ type: 'llm_iam', connectionSlug }, {
      value: credentials.secretAccessKey, // Primary secret in value field
      awsAccessKeyId: credentials.accessKeyId,
      awsRegion: credentials.region,
      awsSessionToken: credentials.sessionToken,
    });
  }

  // ============================================================
  // Service Account Credentials (GCP Vertex)
  // ============================================================

  /**
   * Get service account credentials for an LLM connection.
   * @param connectionSlug - The connection slug
   * @returns Service account JSON and metadata or null if not found
   */
  async getLlmServiceAccount(connectionSlug: string): Promise<{
    serviceAccountJson: string;
    projectId?: string;
    region?: string;
    email?: string;
  } | null> {
    const cred = await this.get({ type: 'llm_service_account', connectionSlug });
    if (!cred) return null;
    return {
      serviceAccountJson: cred.value, // Full JSON stored in value field
      projectId: cred.gcpProjectId,
      region: cred.gcpRegion,
      email: cred.serviceAccountEmail,
    };
  }

  /**
   * Set service account credentials for an LLM connection.
   * @param connectionSlug - The connection slug
   * @param credentials - Service account credentials to store
   */
  async setLlmServiceAccount(connectionSlug: string, credentials: {
    serviceAccountJson: string;
    projectId?: string;
    region?: string;
    email?: string;
  }): Promise<void> {
    await this.set({ type: 'llm_service_account', connectionSlug }, {
      value: credentials.serviceAccountJson, // Full JSON in value field
      gcpProjectId: credentials.projectId,
      gcpRegion: credentials.region,
      serviceAccountEmail: credentials.email,
    });
  }

  // ============================================================
  // Unified Credential Checking
  // ============================================================

  /**
   * Resolve an LLM connection's credential to its concrete value(s).
   *
   * This is the single place that maps `authType -> credential`; every consumer
   * that needs the value (driver validation, env-var injection, Pi auth) derives
   * from here instead of re-deriving the switch. Returns `null` when no usable
   * credential exists.
   *
   * @param connectionSlug - The connection slug
   * @param authType - The auth mechanism to resolve
   * @param providerType - Optional provider type; only affects `environment`
   *   resolution (see below)
   */
  async resolveLlmCredential(
    connectionSlug: string,
    authType: LlmAuthType,
    providerType?: LlmProviderType,
  ): Promise<ResolvedLlmCredential | null> {
    switch (authType) {
      // Keyless connections (local/self-hosted, e.g. Ollama). Present by
      // definition; downstream applies KEYLESS_API_KEY_PLACEHOLDER.
      case 'none':
        return { kind: 'none' };

      // API-key family — all share llm_api_key storage. `bearer_token` stores
      // its secret here too; consumers that need the Bearer-vs-x-api-key
      // distinction branch on `authType`, not on the resolved kind.
      case 'api_key':
      case 'api_key_with_endpoint':
      case 'bearer_token': {
        const value = await this.getLlmApiKey(connectionSlug);
        return value ? { kind: 'api_key', value } : null;
      }

      // Browser OAuth. Mirrors expiry handling: an expired token with no refresh
      // token is not usable and resolves to null.
      case 'oauth': {
        const oauth = await this.getLlmOAuth(connectionSlug);
        if (!oauth) return null;
        if (
          oauth.expiresAt &&
          this.isExpired({ value: oauth.accessToken, expiresAt: oauth.expiresAt }) &&
          !oauth.refreshToken
        ) {
          return null;
        }
        return {
          kind: 'oauth',
          accessToken: oauth.accessToken,
          refreshToken: oauth.refreshToken,
          expiresAt: oauth.expiresAt,
        };
      }

      // AWS IAM credentials (Bedrock).
      case 'iam_credentials': {
        const iam = await this.getLlmIamCredentials(connectionSlug);
        if (!iam?.accessKeyId || !iam.secretAccessKey) return null;
        return {
          kind: 'iam',
          accessKeyId: iam.accessKeyId,
          secretAccessKey: iam.secretAccessKey,
          region: iam.region,
          sessionToken: iam.sessionToken,
        };
      }

      // GCP service account (Vertex). The stored secret is the account JSON,
      // exposed on `path` per the ResolvedLlmCredential contract.
      case 'service_account_file': {
        const sa = await this.getLlmServiceAccount(connectionSlug);
        return sa?.serviceAccountJson
          ? { kind: 'service_account', path: sa.serviceAccountJson }
          : null;
      }

      // Credentials supplied out-of-band via the process environment. Anthropic
      // exposes a single named variable (ANTHROPIC_API_KEY) we can verify — a
      // missing variable means no credential. Other provider families back
      // `environment` with a credential *chain* (e.g. Bedrock via ~/.aws, IAM
      // roles, SSO) that cannot be verified from a single variable, so they
      // resolve as present and defer to the liveness check.
      case 'environment': {
        if (providerType === 'anthropic') {
          const value = process.env.ANTHROPIC_API_KEY;
          return value ? { kind: 'environment', value } : null;
        }
        return { kind: 'environment', value: '' };
      }

      default: {
        // Exhaustive check - TypeScript will error if we miss a case
        const _exhaustive: never = authType;
        return null;
      }
    }
  }

  /**
   * Check if an LLM connection has usable credentials.
   *
   * Thin projection of {@link resolveLlmCredential}: a connection has
   * credentials exactly when a credential resolves. Answers *presence*, not
   * *liveness* — a real request (driver validation) is the authority on whether
   * the credential actually works.
   *
   * @param connectionSlug - The connection slug
   * @param authType - The auth type to check
   * @param providerType - Optional provider type for environment resolution
   */
  async hasLlmCredentials(
    connectionSlug: string,
    authType: LlmAuthType,
    providerType?: LlmProviderType,
  ): Promise<boolean> {
    return (await this.resolveLlmCredential(connectionSlug, authType, providerType)) !== null;
  }

  /**
   * Check if a credential is expired (with 5-minute buffer).
   *
   * If expiresAt is not set:
   * - OAuth tokens (have refreshToken): treated as expired to force refresh attempt
   * - API keys (no refreshToken): treated as never expiring
   *
   * This prevents OAuth tokens from being treated as valid forever when
   * the provider doesn't return expires_in in the token response.
   */
  isExpired(credential: StoredCredential): boolean {
    if (credential.expiresAt) {
      // Consider expired if within 5 minutes of expiry
      return Date.now() > credential.expiresAt - 5 * 60 * 1000;
    }

    // No expiresAt set - behavior depends on credential type
    if (credential.refreshToken) {
      // OAuth token without expiry - treat as expired to force refresh
      // This is safer than assuming it's valid forever
      debug('[CredentialManager] OAuth token missing expiresAt - treating as expired');
      return true;
    }

    // API key without expiry - these typically don't expire
    return false;
  }

  // ============================================================
  // Health Check
  // ============================================================

  /**
   * Check the health of the credential store.
   *
   * This validates:
   * 1. The credential file can be read and decrypted (if it exists)
   * 2. The default LLM connection has valid credentials
   *
   * Use this on app startup to detect issues before users hit cryptic errors.
   *
   * @returns Health status with any issues found
   */
  async checkHealth(): Promise<CredentialHealthStatus> {
    const issues: CredentialHealthIssue[] = [];

    try {
      await this.ensureInitialized();

      // 1. Try to list credentials - this triggers decryption
      // If file is corrupted or can't be decrypted, this will throw
      await this.list({});

    } catch (error) {
      const errorMsg = error instanceof Error ? error.message : String(error);
      const lowerMsg = errorMsg.toLowerCase();

      // Detect decryption failures (usually means machine migration)
      if (lowerMsg.includes('decrypt') || lowerMsg.includes('cipher') || lowerMsg.includes('authentication tag')) {
        issues.push({
          type: 'decryption_failed',
          message: 'Credentials from another machine detected. Please re-authenticate.',
          error: errorMsg,
        });
      } else if (lowerMsg.includes('json') || lowerMsg.includes('parse') || lowerMsg.includes('unexpected')) {
        issues.push({
          type: 'file_corrupted',
          message: 'Credential file is corrupted. Please re-authenticate.',
          error: errorMsg,
        });
      } else {
        // Unknown error - treat as corruption
        issues.push({
          type: 'file_corrupted',
          message: 'Failed to read credentials. Please re-authenticate.',
          error: errorMsg,
        });
      }

      return { healthy: false, issues };
    }

    // 2. Check if default connection has credentials
    // Import lazily to avoid circular dependency
    try {
      const { getDefaultLlmConnection, getLlmConnection } = await import('../config/storage.ts');
      const defaultSlug = getDefaultLlmConnection();

      if (defaultSlug) {
        const connection = getLlmConnection(defaultSlug);
        if (connection && connection.authType !== 'none' && connection.authType !== 'environment') {
          const hasCredentials = await this.hasLlmCredentials(
            defaultSlug,
            connection.authType,
            connection.providerType
          );
          if (!hasCredentials) {
            issues.push({
              type: 'no_default_credentials',
              message: `No credentials found for default connection "${connection.name}".`,
            });
          }
        }
      }
    } catch (configError) {
      // Config not yet initialized - skip this check
      debug('[CredentialManager] Skipping default connection check - config not available');
    }

    return {
      healthy: issues.length === 0,
      issues,
    };
  }
}

// Singleton instance
let manager: CredentialManager | null = null;

export function getCredentialManager(): CredentialManager {
  if (!manager) {
    manager = new CredentialManager();
  }
  return manager;
}
