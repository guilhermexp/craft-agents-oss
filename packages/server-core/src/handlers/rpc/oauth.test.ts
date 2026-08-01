import { describe, expect, mock, test } from 'bun:test';
import { completeOAuthFlow } from './oauth.ts';

describe('completeOAuthFlow public failures', () => {
  test('does not forward credential-bearing provider errors to sessions or renderer', async () => {
    const providerFailure = 'token=oauth-secret client_secret=client-secret Authorization: Bearer auth-secret https://user:pass@example.test/private?credential=url-secret arbitrary-provider-text';
    const completed: unknown[] = [];
    const flow = {
      source: {},
      provider: 'generic',
      sourceSlug: 'custom-oauth',
      workspaceId: 'ws-1',
      ownerClientId: 'client-1',
      sessionId: 'session-1',
      authRequestId: 'auth-1',
      codeVerifier: 'verifier',
      tokenEndpoint: 'https://auth.example.test/token',
      clientId: 'client-id',
      redirectUri: 'http://localhost/callback',
    };

    const result = await completeOAuthFlow({
      code: 'code',
      state: 'state',
      flowStore: { getByState: () => flow, remove: mock(() => {}) },
      credManager: { exchangeAndStore: mock(() => Promise.resolve({ success: false, error: providerFailure })) },
      sessionManager: { completeAuthRequest: mock((_sessionId, payload) => { completed.push(payload); return Promise.resolve(); }) },
      pushSourcesChanged: mock(() => {}),
      logger: { info: mock(() => {}) },
      clientId: 'client-1',
      workspaceId: 'ws-1',
    });
    const publicEvidence = JSON.stringify({ result, completed });

    expect(result).toEqual({
      success: false,
      error: 'OAuth authentication failed',
      errorCode: 'oauth-token-exchange-failed',
    });
    expect(completed).toEqual([{
      requestId: 'auth-1',
      sourceSlug: 'custom-oauth',
      success: false,
      email: undefined,
      error: 'OAuth authentication failed',
    }]);
    for (const secret of ['oauth-secret', 'client-secret', 'auth-secret', 'user:pass', 'url-secret', 'arbitrary-provider-text']) {
      expect(publicEvidence).not.toContain(secret);
    }
  });
});
