import { afterEach, describe, expect, mock, test } from 'bun:test';
import { exchangeGenericOAuth, refreshGenericOAuthToken } from '../generic-oauth.ts';

const originalFetch = globalThis.fetch;
const providerFailure = 'token=oauth-secret client_secret=client-secret Authorization: Bearer auth-secret https://user:pass@example.test/private?credential=url-secret arbitrary-provider-text';

afterEach(() => {
  globalThis.fetch = originalFetch;
});

function exchangeParams() {
  return {
    code: 'code',
    codeVerifier: 'verifier',
    tokenEndpoint: 'https://auth.example.test/token',
    clientId: 'client-id',
    redirectUri: 'http://localhost/callback',
  };
}

describe('generic OAuth public failures', () => {
  test('fails closed on a credential-bearing token exchange response', async () => {
    globalThis.fetch = mock(() => Promise.resolve(new Response(providerFailure, { status: 400 }))) as unknown as typeof fetch;

    const result = await exchangeGenericOAuth(exchangeParams());

    expect(result).toEqual({
      success: false,
      error: 'OAuth token exchange failed',
      errorCode: 'oauth-token-exchange-failed',
    });
    expect(JSON.stringify(result)).not.toContain(providerFailure);
  });

  test('fails closed on a credential-bearing provider JSON error', async () => {
    globalThis.fetch = mock(() => Promise.resolve(new Response(JSON.stringify({
      error: 'invalid_grant',
      error_description: providerFailure,
    }), { status: 200, headers: { 'content-type': 'application/json' } }))) as unknown as typeof fetch;

    const result = await exchangeGenericOAuth(exchangeParams());

    expect(result).toEqual({
      success: false,
      error: 'OAuth token exchange failed',
      errorCode: 'oauth-token-exchange-failed',
    });
    expect(JSON.stringify(result)).not.toContain(providerFailure);
  });

  test('fails closed on a credential-bearing caught exchange error', async () => {
    globalThis.fetch = mock(() => Promise.reject(new Error(providerFailure))) as unknown as typeof fetch;

    const result = await exchangeGenericOAuth(exchangeParams());

    expect(result).toEqual({
      success: false,
      error: 'OAuth token exchange failed',
      errorCode: 'oauth-token-exchange-failed',
    });
    expect(JSON.stringify(result)).not.toContain(providerFailure);
  });

  test('throws only a stable reason code for refresh failures', async () => {
    globalThis.fetch = mock(() => Promise.resolve(new Response(providerFailure, { status: 400 }))) as unknown as typeof fetch;

    const rejection = refreshGenericOAuthToken('refresh-token', 'https://auth.example.test/token', 'client-id')
      .then(() => null, (error: unknown) => error);

    expect(await rejection).toEqual(new Error('oauth-token-refresh-failed'));
    expect(JSON.stringify(await rejection)).not.toContain(providerFailure);
  });
});
