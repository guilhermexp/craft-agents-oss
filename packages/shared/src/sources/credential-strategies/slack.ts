/**
 * Slack OAuth credential strategy.
 *
 * Handles Slack API sources (messaging, channels, users, files, full).
 * Delegates to the slack-oauth module for the actual PKCE/token operations.
 */

import type { CredentialStrategy, OAuthPrepareOptions, RefreshResult } from './types.ts';
import type { LoadedSource, SlackServiceScope } from '../types.ts';
import { inferSlackServiceFromUrl } from '../types.ts';
import type { StoredCredential } from '../../credentials/types.ts';
import type { PreparedOAuthFlow, OAuthExchangeParams, OAuthExchangeResult } from '../../auth/oauth-flow-types.ts';
import {
  prepareSlackOAuth,
  exchangeSlackOAuth,
  refreshSlackToken,
} from '../../auth/slack-oauth.ts';

export class SlackCredentialStrategy implements CredentialStrategy {
  readonly name = 'slack';

  canHandle(source: LoadedSource): boolean {
    return source.config.provider === 'slack';
  }

  prepareOAuth(source: LoadedSource, options: OAuthPrepareOptions): PreparedOAuthFlow {
    const api = source.config.api;
    let service: SlackServiceScope | undefined;
    let userScopes: string[] | undefined;

    if (api?.slackUserScopes && api.slackUserScopes.length > 0) {
      userScopes = api.slackUserScopes;
    } else if (api?.slackService) {
      service = api.slackService;
    } else {
      service = inferSlackServiceFromUrl(api?.baseUrl) || 'full';
    }

    return prepareSlackOAuth({
      service,
      userScopes,
      callbackPort: options.callbackPort,
      callbackUrl: options.providerCallbackUrl,
    });
  }

  async exchangeTokens(params: OAuthExchangeParams): Promise<OAuthExchangeResult> {
    return exchangeSlackOAuth(params);
  }

  async refreshToken(_source: LoadedSource, credential: StoredCredential): Promise<RefreshResult | null> {
    if (!credential.refreshToken) return null;

    try {
      const result = await refreshSlackToken(credential.refreshToken, credential.clientId);

      return {
        accessToken: result.accessToken,
        expiresAt: result.expiresAt,
      };
    } catch {
      return null;
    }
  }
}
