/**
 * Generic OAuth credential strategy.
 *
 * Handles any OAuth 2.0 provider configured via ApiOAuthConfig in source config.json
 * (GitHub, Linear, Notion, Spotify, etc.).
 *
 * Two sub-paths:
 *   - Static config: source has api.oauth with tokenUrl/authorizationUrl/clientId
 *   - Auto-discovery: source has api.baseUrl but no oauth block -- uses RFC 9728/8414
 *     metadata discovery + dynamic client registration (same mechanics as MCP OAuth)
 */

import type { CredentialStrategy, OAuthPrepareOptions, RefreshResult } from './types.ts';
import type { LoadedSource } from '../types.ts';
import type { StoredCredential } from '../../credentials/types.ts';
import type { PreparedOAuthFlow, OAuthExchangeParams, OAuthExchangeResult } from '../../auth/oauth-flow-types.ts';
import {
  prepareGenericOAuth,
  exchangeGenericOAuth,
  refreshGenericOAuthToken,
} from '../../auth/generic-oauth.ts';
import { CraftOAuth, prepareMcpOAuth } from '../../auth/oauth.ts';

export class GenericOAuthCredentialStrategy implements CredentialStrategy {
  readonly name = 'generic';

  /**
   * Matches API sources with OAuth auth type that are NOT handled by
   * a named-provider strategy (Google, Slack, Microsoft).
   */
  canHandle(source: LoadedSource): boolean {
    if (source.config.type !== 'api') return false;
    const api = source.config.api;
    if (!api || api.authType !== 'oauth') return false;

    // Exclude named providers -- they have their own strategies
    const provider = source.config.provider;
    if (provider === 'google' || provider === 'slack' || provider === 'microsoft') {
      return false;
    }
    return true;
  }

  /**
   * Build the authorization URL.
   *
   * Static config path: uses tokenUrl/authorizationUrl/clientId from api.oauth.
   * Auto-discovery path: hits baseUrl, discovers OAuth metadata via RFC 9728/8414,
   * dynamically registers a client -- same flow as MCP OAuth.
   */
  async prepareOAuth(
    source: LoadedSource,
    options: OAuthPrepareOptions,
  ): Promise<PreparedOAuthFlow> {
    const oauthConfig = source.config.api?.oauth;

    if (oauthConfig) {
      // Static config: endpoints provided in config.json
      return prepareGenericOAuth({
        oauthConfig,
        callbackPort: options.callbackPort,
        callbackUrl: options.providerCallbackUrl,
      });
    }

    // Auto-discovery: hit baseUrl, discover OAuth metadata via RFC 9728/8414,
    // dynamically register a client -- same flow as MCP OAuth.
    const baseUrl = source.config.api?.baseUrl;
    if (!baseUrl) {
      throw new Error(
        `Source '${source.config.slug}' missing api.baseUrl for OAuth discovery`,
      );
    }

    const prepared = await prepareMcpOAuth(baseUrl, {
      callbackPort: options.callbackPort,
      callbackUrl: options.providerCallbackUrl,
    });

    // Relabel as generic (discovery used MCP internals but this is an API source)
    return { ...prepared, provider: 'generic' };
  }

  async exchangeTokens(params: OAuthExchangeParams): Promise<OAuthExchangeResult> {
    return exchangeGenericOAuth(params);
  }

  /**
   * Refresh the access token.
   *
   * Two sub-paths mirror the prepare logic:
   *   1. Static config (tokenUrl present) -- use refreshGenericOAuthToken
   *   2. Auto-discovered (no tokenUrl, has baseUrl + clientId) -- delegate to
   *      CraftOAuth.refreshAccessToken (re-discover token endpoint from baseUrl)
   */
  async refreshToken(
    source: LoadedSource,
    credential: StoredCredential,
  ): Promise<RefreshResult | null> {
    if (!credential.refreshToken) return null;

    const oauthConfig = source.config.api?.oauth;

    // Path 1: Static config -- tokenUrl from config.json
    if (oauthConfig?.tokenUrl) {
      try {
        const result = await refreshGenericOAuthToken(
          credential.refreshToken,
          oauthConfig.tokenUrl,
          credential.clientId || oauthConfig.clientId,
          credential.clientSecret || oauthConfig.clientSecret,
        );
        return {
          accessToken: result.accessToken,
          refreshToken: result.refreshToken,
          expiresAt: result.expiresAt,
        };
      } catch {
        return null;
      }
    }

    // Path 2: Auto-discovered -- re-discover token endpoint from baseUrl via MCP OAuth
    if (source.config.api?.baseUrl && credential.clientId) {
      try {
        const oauth = new CraftOAuth(
          { mcpUrl: source.config.api.baseUrl },
          { onStatus: () => {}, onError: () => {} },
        );
        const tokens = await oauth.refreshAccessToken(
          credential.refreshToken,
          credential.clientId,
        );
        return {
          accessToken: tokens.accessToken,
          refreshToken: tokens.refreshToken,
          expiresAt: tokens.expiresAt,
        };
      } catch {
        return null;
      }
    }

    return null;
  }
}
