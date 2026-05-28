/**
 * CredentialStrategy — Strategy interface for provider-specific OAuth logic.
 *
 * Each strategy encapsulates prepare, exchange, and refresh for a single
 * OAuth provider (Google, Slack, Microsoft, etc.). The dispatcher in
 * SourceCredentialManager delegates to the matching strategy.
 *
 * Strategies handle only provider-specific logic. Cross-cutting concerns
 * (relay wrapping, credential save/load, dedup, markSourceNeedsReauth)
 * stay in SourceCredentialManager.
 */

import type { LoadedSource } from '../types.ts';
import type { StoredCredential } from '../../credentials/types.ts';
import type { PreparedOAuthFlow, OAuthExchangeParams, OAuthExchangeResult } from '../../auth/oauth-flow-types.ts';

/**
 * Options for preparing an OAuth flow.
 * callbackPort is for Electron local callback; callbackUrl is for WebUI relay.
 * providerCallbackUrl is the relay-stable redirect URI (when using WebUI).
 */
export interface OAuthPrepareOptions {
  callbackPort?: number;
  /** Provider-facing callback URL (OAUTH_RELAY_CALLBACK_URL for WebUI, undefined for Electron) */
  providerCallbackUrl?: string;
}

/**
 * Result of a token refresh. The strategy returns null to signal failure
 * (SourceCredentialManager handles markSourceNeedsReauth).
 */
export interface RefreshResult {
  accessToken: string;
  refreshToken?: string;
  expiresAt?: number;
}

export interface CredentialStrategy {
  /** Human-readable provider name (e.g. 'google', 'slack', 'microsoft') */
  readonly name: string;

  /** Returns true if this strategy handles the given source */
  canHandle(source: LoadedSource): boolean;

  /**
   * Build the authorization URL + PKCE state for this provider.
   * Returns a PreparedOAuthFlow ready for the client to open.
   */
  prepareOAuth(source: LoadedSource, options: OAuthPrepareOptions): PreparedOAuthFlow | Promise<PreparedOAuthFlow>;

  /**
   * Exchange the authorization code for tokens.
   * Delegates to the provider-specific exchange function.
   */
  exchangeTokens(params: OAuthExchangeParams): Promise<OAuthExchangeResult>;

  /**
   * Refresh an expired access token.
   * Returns the new token info, or null if refresh fails (caller handles reauth marking).
   */
  refreshToken(source: LoadedSource, credential: StoredCredential): Promise<RefreshResult | null>;
}
