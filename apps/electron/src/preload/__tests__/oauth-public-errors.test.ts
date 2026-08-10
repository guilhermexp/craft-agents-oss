import { describe, expect, test } from 'bun:test';
import { getPublicOAuthFlowError, getPublicOAuthProviderError } from '../oauth-public-errors.ts';

const privateFailure = 'token=preload-secret client_secret=client-secret Authorization: Bearer auth-secret https://user:pass@example.test/private?credential=url-secret arbitrary-provider-text';

describe('preload OAuth public errors', () => {
  test('fails closed for provider callback errors', () => {
    const result = getPublicOAuthProviderError(privateFailure, privateFailure);

    expect(result).toBe('OAuth authorization failed');
    expect(result).not.toContain(privateFailure);
  });

  test('fails closed for caught transport errors', () => {
    const result = getPublicOAuthFlowError(new Error(privateFailure));

    expect(result).toBe('OAuth flow failed');
    expect(result).not.toContain(privateFailure);
  });
});
