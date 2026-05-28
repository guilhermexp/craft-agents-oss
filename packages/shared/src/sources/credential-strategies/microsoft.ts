/**
 * Microsoft OAuth credential strategy.
 *
 * Handles Microsoft API sources (Outlook, Calendar, OneDrive, Teams,
 * SharePoint). Delegates to the microsoft-oauth module for the actual
 * PKCE/token operations.
 *
 * Note: Microsoft may rotate refresh tokens during refresh. The strategy
 * returns the new refreshToken when present so SourceCredentialManager
 * can persist it.
 */

import type { CredentialStrategy, OAuthPrepareOptions, RefreshResult } from './types.ts';
import type { LoadedSource, MicrosoftService } from '../types.ts';
import { inferMicrosoftServiceFromUrl } from '../types.ts';
import type { StoredCredential } from '../../credentials/types.ts';
import type { PreparedOAuthFlow, OAuthExchangeParams, OAuthExchangeResult } from '../../auth/oauth-flow-types.ts';
import {
  prepareMicrosoftOAuth,
  exchangeMicrosoftOAuth,
  refreshMicrosoftToken,
} from '../../auth/microsoft-oauth.ts';

export class MicrosoftCredentialStrategy implements CredentialStrategy {
  readonly name = 'microsoft';

  canHandle(source: LoadedSource): boolean {
    return source.config.provider === 'microsoft';
  }

  prepareOAuth(source: LoadedSource, options: OAuthPrepareOptions): PreparedOAuthFlow {
    const api = source.config.api;
    let service: MicrosoftService | undefined;
    let scopes: string[] | undefined;

    if (api?.microsoftScopes && api.microsoftScopes.length > 0) {
      scopes = api.microsoftScopes;
    } else if (api?.microsoftService) {
      service = api.microsoftService;
    } else {
      service = inferMicrosoftServiceFromUrl(api?.baseUrl);
      if (!service) {
        throw new Error(
          `Cannot determine Microsoft service for source '${source.config.slug}'. ` +
          `Set microsoftService in api config.`
        );
      }
    }

    return prepareMicrosoftOAuth({
      service,
      scopes,
      callbackPort: options.callbackPort,
      callbackUrl: options.providerCallbackUrl,
    });
  }

  async exchangeTokens(params: OAuthExchangeParams): Promise<OAuthExchangeResult> {
    return exchangeMicrosoftOAuth(params);
  }

  async refreshToken(_source: LoadedSource, credential: StoredCredential): Promise<RefreshResult | null> {
    if (!credential.refreshToken) return null;

    try {
      const result = await refreshMicrosoftToken(credential.refreshToken);

      return {
        accessToken: result.accessToken,
        // Microsoft may rotate refresh tokens
        refreshToken: result.refreshToken || undefined,
        expiresAt: result.expiresAt,
      };
    } catch {
      return null;
    }
  }
}
