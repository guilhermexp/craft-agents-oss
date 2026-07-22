/**
 * MCP OAuth credential strategy.
 *
 * Handles OAuth for MCP (Model Context Protocol) sources that use
 * HTTP/SSE transport with OAuth authentication.
 *
 * Two variants are dispatched internally:
 *   - CraftBridge -- Craft-product MCP sources (e.g. craft.do's own MCP)
 *     use a bridge adapter that wraps the standard MCP OAuth flow with
 *     Craft-specific endpoint resolution.
 *   - Standard MCP OAuth -- RFC 9728/8414 metadata discovery + PKCE.
 *
 * The dispatch is driven by `sourceUsesCraftBridgeAuth()`.
 */

import type { CredentialStrategy, OAuthPrepareOptions, RefreshResult } from './types.ts';
import type { LoadedSource } from '../types.ts';
import type { StoredCredential } from '../../credentials/types.ts';
import type { PreparedOAuthFlow, OAuthExchangeParams, OAuthExchangeResult } from '../../auth/oauth-flow-types.ts';
import {
  CraftOAuth,
  prepareMcpOAuth,
  exchangeMcpOAuth,
} from '../../auth/oauth.ts';
import {
  sourceUsesCraftBridgeAuth,
  prepareCraftBridgeMcpOAuth,
  createCraftBridgeOAuthClient,
} from '../../craft-bridge/auth-adapter.ts';

export class McpOAuthCredentialStrategy implements CredentialStrategy {
  readonly name = 'mcp';

  /**
   * Matches MCP sources that have a URL (HTTP/SSE transport).
   * stdio MCP sources run locally and never need OAuth.
   */
  canHandle(source: LoadedSource): boolean {
    return source.config.type === 'mcp' && !!source.config.mcp?.url;
  }

  /**
   * Build the authorization URL.
   *
   * Dispatches between CraftBridge and standard MCP OAuth
   * based on `sourceUsesCraftBridgeAuth`.
   */
  async prepareOAuth(
    source: LoadedSource,
    options: OAuthPrepareOptions,
  ): Promise<PreparedOAuthFlow> {
    if (!source.config.mcp?.url) {
      throw new Error('MCP URL not configured');
    }

    if (sourceUsesCraftBridgeAuth(source)) {
      return prepareCraftBridgeMcpOAuth(source, {
        callbackPort: options.callbackPort,
        callbackUrl: options.providerCallbackUrl,
      });
    }

    return prepareMcpOAuth(source.config.mcp.url, {
      callbackPort: options.callbackPort,
      callbackUrl: options.providerCallbackUrl,
    });
  }

  /**
   * Exchange an authorization code for tokens.
   * Both CraftBridge and standard MCP use the same exchange logic.
   */
  async exchangeTokens(params: OAuthExchangeParams): Promise<OAuthExchangeResult> {
    return exchangeMcpOAuth(params);
  }

  /**
   * Refresh the access token.
   *
   * Dispatches between CraftBridge and standard MCP OAuth clients.
   * Returns null on failure -- the caller (SourceCredentialManager) handles
   * markSourceNeedsReauth.
   */
  async refreshToken(
    source: LoadedSource,
    credential: StoredCredential,
  ): Promise<RefreshResult | null> {
    if (!credential.clientId) return null;
    if (!credential.refreshToken) return null;

    // Only HTTP/SSE transport can refresh tokens -- stdio doesn't use OAuth
    if (!source.config.mcp?.url) return null;

    try {
      const oauth = sourceUsesCraftBridgeAuth(source)
        ? createCraftBridgeOAuthClient(
            source,
            { onStatus: () => {}, onError: () => {} },
          )
        : new CraftOAuth(
            { mcpUrl: source.config.mcp.url },
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
}
