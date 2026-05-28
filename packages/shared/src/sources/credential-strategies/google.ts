/**
 * Google OAuth credential strategy.
 *
 * Handles Google API sources (Gmail, Calendar, Drive, Docs, Sheets, YouTube,
 * Search Console). Delegates to the google-oauth module for the actual
 * PKCE/token operations.
 */

import type { CredentialStrategy, OAuthPrepareOptions, RefreshResult } from './types.ts';
import type { LoadedSource, GoogleService } from '../types.ts';
import { inferGoogleServiceFromUrl } from '../types.ts';
import type { StoredCredential } from '../../credentials/types.ts';
import type { PreparedOAuthFlow, OAuthExchangeParams, OAuthExchangeResult } from '../../auth/oauth-flow-types.ts';
import {
  prepareGoogleOAuth,
  exchangeGoogleOAuth,
  refreshGoogleToken,
} from '../../auth/google-oauth.ts';

export class GoogleCredentialStrategy implements CredentialStrategy {
  readonly name = 'google';

  canHandle(source: LoadedSource): boolean {
    return source.config.provider === 'google';
  }

  prepareOAuth(source: LoadedSource, options: OAuthPrepareOptions): PreparedOAuthFlow {
    const api = source.config.api;
    let service: GoogleService | undefined;
    let scopes: string[] | undefined;

    if (api?.googleScopes && api.googleScopes.length > 0) {
      scopes = api.googleScopes;
    } else if (api?.googleService) {
      service = api.googleService;
    } else {
      service = inferGoogleServiceFromUrl(api?.baseUrl);
      if (!service) {
        throw new Error(
          `Cannot determine Google service for source '${source.config.slug}'. ` +
          `Set googleService in api config.`
        );
      }
    }

    return prepareGoogleOAuth({
      service,
      scopes,
      callbackPort: options.callbackPort,
      callbackUrl: options.providerCallbackUrl,
      clientId: api?.googleOAuthClientId,
      clientSecret: api?.googleOAuthClientSecret,
    });
  }

  async exchangeTokens(params: OAuthExchangeParams): Promise<OAuthExchangeResult> {
    return exchangeGoogleOAuth(params);
  }

  async refreshToken(_source: LoadedSource, credential: StoredCredential): Promise<RefreshResult | null> {
    if (!credential.refreshToken) return null;

    try {
      const result = await refreshGoogleToken(
        credential.refreshToken,
        credential.clientId,
        credential.clientSecret,
      );

      return {
        accessToken: result.accessToken,
        expiresAt: result.expiresAt,
      };
    } catch {
      return null;
    }
  }
}
