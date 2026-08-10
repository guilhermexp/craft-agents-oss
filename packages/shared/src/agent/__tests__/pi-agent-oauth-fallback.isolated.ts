/**
 * PiAgent.getPiAuth — expired-OAuth fallback preserves provider routing.
 *
 * resolveLlmCredential returns null for an OAuth token that is expired with no
 * refresh token. If getPiAuth simply returned null, spawnSubprocess would fall
 * back to getApiKey(), which resurrects that same token as a bare `legacyApiKey`
 * WITHOUT the `provider` field the subprocess needs for piAuthProvider routing.
 * getPiAuth must instead map the stored token itself, keeping the provider.
 *
 * Isolated: mock.module replaces the credential manager for the whole process.
 */

import { describe, test, expect, mock } from 'bun:test';
import * as realManager from '../../credentials/manager.ts';
import type { BackendConfig } from '../backend/types.ts';

const EXPIRED_TOKEN = 'expired-access-token';
const REFRESH_TOKEN = 'gh-refresh-token';

// An expired OAuth token with a stored refresh token. resolveLlmCredential is
// stubbed to null (the "expired, unrefreshable through the resolver" outcome);
// getLlmOAuth still surfaces the raw token so getPiAuth can preserve routing.
const fakeManager = {
  resolveLlmCredential: async () => null,
  getLlmOAuth: async () => ({
    accessToken: EXPIRED_TOKEN,
    refreshToken: REFRESH_TOKEN,
    expiresAt: Date.now() - 1000,
  }),
};

mock.module('../../credentials/manager.ts', () => ({
  ...realManager,
  getCredentialManager: () => fakeManager,
}));

// Dynamic import is required: the module-under-test must be loaded *after*
// mock.module registers the credential-manager stub (test-only module-loading
// boundary — a static import would bind the real getCredentialManager first).
const { PiAgent } = await import('../pi-agent.ts');

/** Mirror of getPiAuth's private return shape, for the typed test probe below. */
type PiAuth = {
  provider: string;
  credential:
    | { type: 'api_key'; key: string }
    | { type: 'oauth'; access: string; refresh: string; expires: number }
    | { type: 'iam'; accessKeyId: string; secretAccessKey: string; region?: string; sessionToken?: string };
} | null;

function createConfig(overrides: Record<string, unknown> = {}): BackendConfig {
  // Structural test fixture: only the fields getPiAuth reads are populated;
  // cast to BackendConfig since the full shape is irrelevant to this unit.
  return {
    provider: 'pi',
    workspace: { id: 'ws-test', name: 'Test Workspace', rootPath: '/tmp/craft-agent-test' },
    session: {
      id: 'session-test',
      workspaceRootPath: '/tmp/craft-agent-test',
      createdAt: Date.now(),
      lastUsedAt: Date.now(),
    },
    isHeadless: true,
    authType: 'oauth',
    connectionSlug: 'pi',
    ...overrides,
  } as unknown as BackendConfig;
}

describe('PiAgent.getPiAuth — expired OAuth fallback', () => {
  test('preserves provider routing (api_key) when the resolver drops an expired OAuth token', async () => {
    const agent = new PiAgent(createConfig({ runtime: { piAuthProvider: 'anthropic' } }));
    // getPiAuth is private; reach it through a typed structural probe (a runtime
    // shape check is meaningless for a method we statically know exists).
    const probe = agent as unknown as { getPiAuth(): Promise<PiAuth> };
    const piAuth = await probe.getPiAuth();
    expect(piAuth).toEqual({
      provider: 'anthropic',
      credential: { type: 'api_key', key: EXPIRED_TOKEN },
    });
    agent.destroy();
  });

  test('copilot keeps the full oauth credential (provider + refresh) on the fallback path', async () => {
    const agent = new PiAgent(createConfig({ runtime: { piAuthProvider: 'github-copilot' } }));
    const probe = agent as unknown as { getPiAuth(): Promise<PiAuth> };
    const piAuth = await probe.getPiAuth();
    expect(piAuth).toEqual({
      provider: 'github-copilot',
      credential: {
        type: 'oauth',
        access: EXPIRED_TOKEN,
        refresh: REFRESH_TOKEN,
        expires: expect.any(Number),
      },
    });
    agent.destroy();
  });
});
