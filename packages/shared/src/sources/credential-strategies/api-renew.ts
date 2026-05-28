/**
 * API Renew credential strategy.
 *
 * Handles non-OAuth token refresh via a custom renew endpoint.
 * Uses the current access token for renewal -- no separate refresh token needed.
 *
 * This strategy has the **highest priority** in canHandle because
 * api.renewEndpoint should be checked BEFORE provider type routing.
 * A source with both a provider and a renewEndpoint should use the
 * renew endpoint path.
 */

import type { CredentialStrategy, OAuthPrepareOptions, RefreshResult } from './types.ts';
import { hasRenewEndpoint, type LoadedSource } from '../types.ts';
import { buildAuthorizationHeader } from '../api-tools.ts';
import type { StoredCredential } from '../../credentials/types.ts';
import type { PreparedOAuthFlow, OAuthExchangeParams, OAuthExchangeResult } from '../../auth/oauth-flow-types.ts';

// ============================================================
// Token substitution helpers (extracted from credential-manager.ts)
// ============================================================

/**
 * Recursively substitute {{token}} in string leaves of an object.
 * Supports nested objects and arrays.
 */
function substituteTokenInBody(
  obj: Record<string, unknown>,
  token: string,
): Record<string, unknown> {
  const result: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(obj)) {
    if (typeof value === 'string') {
      result[key] = value.replace(/\{\{token\}\}/g, token);
    } else if (Array.isArray(value)) {
      result[key] = value.map((item) =>
        typeof item === 'string'
          ? item.replace(/\{\{token\}\}/g, token)
          : item && typeof item === 'object'
            ? substituteTokenInBody(item as Record<string, unknown>, token)
            : item,
      );
    } else if (value && typeof value === 'object') {
      result[key] = substituteTokenInBody(
        value as Record<string, unknown>,
        token,
      );
    } else {
      result[key] = value;
    }
  }
  return result;
}

/**
 * Substitute {{token}} in header values.
 */
function substituteTokenInHeaders(
  headers: Record<string, string> | undefined,
  token: string,
): Record<string, string> {
  if (!headers) return {};
  const result: Record<string, string> = {};
  for (const [key, value] of Object.entries(headers)) {
    result[key] = value.replace(/\{\{token\}\}/g, token);
  }
  return result;
}

export class ApiRenewCredentialStrategy implements CredentialStrategy {
  readonly name = 'api-renew';

  /**
   * Matches any source that has api.renewEndpoint configured.
   * This check runs BEFORE provider-type checks so that a source
   * with both a named provider and a renew endpoint uses this path.
   */
  canHandle(source: LoadedSource): boolean {
    return hasRenewEndpoint(source);
  }

  /**
   * API Renew has no OAuth prepare step.
   */
  prepareOAuth(
    _source: LoadedSource,
    _options: OAuthPrepareOptions,
  ): PreparedOAuthFlow {
    throw new Error(
      'API Renew sources do not support OAuth -- tokens are refreshed via the renew endpoint',
    );
  }

  /**
   * API Renew has no OAuth exchange step.
   */
  async exchangeTokens(
    _params: OAuthExchangeParams,
  ): Promise<OAuthExchangeResult> {
    return {
      success: false,
      error: 'API Renew sources do not support OAuth token exchange',
    };
  }

  /**
   * Refresh the token by calling the configured renew endpoint.
   *
   * Steps:
   *   1. Resolve the full URL (absolute path or relative to baseUrl)
   *   2. Build headers (defaultHeaders < renewEndpoint.headers < Authorization)
   *   3. Build body with {{token}} substitution
   *   4. Execute the request
   *   5. Extract the new token from the response
   *   6. Extract expiry (expires_in field or fallbackTtlSecs)
   */
  async refreshToken(
    source: LoadedSource,
    credential: StoredCredential,
  ): Promise<RefreshResult | null> {
    const renewConfig = source.config.api?.renewEndpoint;
    if (!renewConfig?.path) return null;

    const baseUrl = source.config.api!.baseUrl;
    const authScheme = source.config.api!.authScheme;
    const currentToken = credential.value;

    try {
      // 1. Resolve URL
      const url = renewConfig.path.startsWith('http')
        ? renewConfig.path
        : new URL(
            renewConfig.path,
            baseUrl.endsWith('/') ? baseUrl : `${baseUrl}/`,
          ).toString();

      // 2. Build headers: defaultHeaders < renewEndpoint.headers < Authorization
      const headers: Record<string, string> = {
        'Content-Type': 'application/json',
        ...source.config.api!.defaultHeaders,
        ...substituteTokenInHeaders(renewConfig.headers, currentToken),
      };
      // Add Authorization unless explicitly overridden in renewEndpoint.headers
      if (
        !renewConfig.headers?.['Authorization'] &&
        !renewConfig.headers?.['authorization']
      ) {
        headers['Authorization'] = buildAuthorizationHeader(
          authScheme,
          currentToken,
        );
      }

      // 3. Build body with {{token}} substitution
      const method = renewConfig.method ?? 'POST';
      const fetchOptions: RequestInit = { method, headers };
      if (renewConfig.body && method !== 'GET') {
        fetchOptions.body = JSON.stringify(
          substituteTokenInBody(renewConfig.body, currentToken),
        );
      }

      // 4. Execute
      const response = await fetch(url, fetchOptions);

      if (!response.ok) {
        const errorText = await response.text().catch(() => '');
        throw new Error(
          `Renew endpoint returned ${response.status}: ${errorText.slice(0, 200)}`,
        );
      }

      const json = (await response.json()) as Record<string, unknown>;

      // 5. Extract new token
      const tokenField = renewConfig.tokenField ?? 'access_token';
      const newToken = json[tokenField];
      if (typeof newToken !== 'string' || !newToken) {
        throw new Error(`Renew response missing "${tokenField}" field`);
      }

      // 6. Extract expiry
      const expiresInField = renewConfig.expiresInField ?? 'expires_in';
      const expiresInRaw = json[expiresInField];
      let expiresAt: number | undefined;
      if (typeof expiresInRaw === 'number' && expiresInRaw > 0) {
        expiresAt = Date.now() + expiresInRaw * 1000;
      } else if (renewConfig.fallbackTtlSecs) {
        expiresAt = Date.now() + renewConfig.fallbackTtlSecs * 1000;
      }
      // If neither is available, expiresAt stays undefined -- needsRefresh() will
      // trigger refresh on next session start (safe but noisy).

      return {
        accessToken: newToken,
        expiresAt,
      };
    } catch {
      return null;
    }
  }
}
