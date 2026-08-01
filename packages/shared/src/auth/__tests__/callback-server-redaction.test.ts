import { describe, expect, test } from 'bun:test';

import { createCallbackServer } from '../callback-server.ts';

describe('OAuth callback server public errors', () => {
  test('does not render or return provider error details', async () => {
    const callback = await createCallbackServer({ appType: 'electron' });
    const providerError = [
      'token=provider-secret',
      'client_secret=client-secret',
      'Authorization: Bearer auth-secret',
      'https://user:password@example.test/private?session_token=url-secret',
    ].join(' ');

    try {
      const response = await fetch(
        `${callback.url}/callback?error=access_denied&error_description=${encodeURIComponent(providerError)}`,
      );
      const html = await response.text();
      const payload = await callback.promise;
      const evidence = `${html}\n${JSON.stringify(payload)}`;

      expect(response.status).toBe(200);
      expect(payload).toEqual({ query: { error: 'oauth-provider-error' } });
      for (const secret of ['provider-secret', 'client-secret', 'auth-secret', 'user:password', 'url-secret']) {
        expect(evidence).not.toContain(secret);
      }
    } finally {
      await callback.close();
    }
  });
});
