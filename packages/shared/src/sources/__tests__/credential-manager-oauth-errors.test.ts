import { afterEach, describe, expect, mock, spyOn, test } from 'bun:test';
import { CraftOAuth } from '../../auth/oauth.ts';
import * as googleOAuth from '../../auth/google-oauth.ts';
import * as slackOAuth from '../../auth/slack-oauth.ts';
import * as microsoftOAuth from '../../auth/microsoft-oauth.ts';
import { SourceCredentialManager } from '../credential-manager.ts';
import type { FolderSourceConfig, LoadedSource } from '../types.ts';

const providerFailure = 'token=oauth-secret client_secret=client-secret Authorization: Bearer auth-secret https://user:pass@example.test/private?credential=url-secret arbitrary-provider-text';
const activeSpies: Array<{ mockRestore(): void }> = [];

function createSource(config: Partial<FolderSourceConfig>): LoadedSource {
  return {
    config: {
      id: 'source-id',
      slug: 'source-slug',
      name: 'Source',
      enabled: true,
      type: 'api',
      isAuthenticated: false,
      ...config,
    } as FolderSourceConfig,
    guide: null,
    folderPath: '/tmp/workspace/sources/source-slug',
    workspaceRootPath: '/tmp/workspace',
    workspaceId: 'workspace-id',
  };
}

function callbacks() {
  const errors: string[] = [];
  return {
    errors,
    value: {
      onStatus: mock(() => {}),
      onError: mock((error: string) => errors.push(error)),
    },
  };
}

function expectStableFailure(result: unknown, callbackErrors: string[]): void {
  expect(result).toEqual({
    success: false,
    error: 'OAuth authentication failed',
    errorCode: 'source-oauth-authentication-failed',
  });
  const evidence = JSON.stringify({ result, callbackErrors });
  for (const secret of ['oauth-secret', 'client-secret', 'auth-secret', 'user:pass', 'url-secret', 'arbitrary-provider-text']) {
    expect(evidence).not.toContain(secret);
  }
}

afterEach(() => {
  while (activeSpies.length > 0) activeSpies.pop()?.mockRestore();
});

describe('SourceCredentialManager source OAuth public failures', () => {
  test('fails closed when MCP OAuth throws a credential-bearing error', async () => {
    activeSpies.push(spyOn(CraftOAuth.prototype, 'authenticate').mockRejectedValue(new Error(providerFailure)));
    const cb = callbacks();
    const source = createSource({
      type: 'mcp',
      provider: 'custom-mcp',
      mcp: { transport: 'http', url: 'https://mcp.example.test', authType: 'oauth' },
    });

    const result = await new SourceCredentialManager().authenticate(source, cb.value);

    expectStableFailure(result, cb.errors);
    expect(cb.errors).toEqual(['OAuth authentication failed']);
  });

  const providerCases = [
    {
      name: 'Google',
      source: () => createSource({
        provider: 'google',
        api: { baseUrl: 'https://gmail.googleapis.com', authType: 'oauth', googleService: 'gmail' },
      }),
      resultFailure: () => spyOn(googleOAuth, 'startGoogleOAuth').mockResolvedValue({ success: false, error: providerFailure }),
      caughtFailure: () => spyOn(googleOAuth, 'startGoogleOAuth').mockRejectedValue(new Error(providerFailure)),
    },
    {
      name: 'Slack',
      source: () => createSource({
        provider: 'slack',
        api: { baseUrl: 'https://slack.com/api', authType: 'oauth', slackService: 'full' },
      }),
      resultFailure: () => spyOn(slackOAuth, 'startSlackOAuth').mockResolvedValue({ success: false, error: providerFailure }),
      caughtFailure: () => spyOn(slackOAuth, 'startSlackOAuth').mockRejectedValue(new Error(providerFailure)),
    },
    {
      name: 'Microsoft',
      source: () => createSource({
        provider: 'microsoft',
        api: { baseUrl: 'https://graph.microsoft.com', authType: 'oauth', microsoftService: 'outlook' },
      }),
      resultFailure: () => spyOn(microsoftOAuth, 'startMicrosoftOAuth').mockResolvedValue({ success: false, error: providerFailure }),
      caughtFailure: () => spyOn(microsoftOAuth, 'startMicrosoftOAuth').mockRejectedValue(new Error(providerFailure)),
    },
  ] as const;

  for (const providerCase of providerCases) {
    test(`fails closed when ${providerCase.name} returns a credential-bearing provider error`, async () => {
      activeSpies.push(providerCase.resultFailure());
      const cb = callbacks();

      const result = await new SourceCredentialManager().authenticate(providerCase.source(), cb.value);

      expectStableFailure(result, cb.errors);
    });

    test(`fails closed when ${providerCase.name} throws a credential-bearing error`, async () => {
      activeSpies.push(providerCase.caughtFailure());
      const cb = callbacks();

      const result = await new SourceCredentialManager().authenticate(providerCase.source(), cb.value);

      expectStableFailure(result, cb.errors);
      expect(cb.errors).toEqual(['OAuth authentication failed']);
    });
  }

  test('preserves local configuration errors without assigning a provider failure code', async () => {
    const source = createSource({
      type: 'mcp',
      provider: 'custom-mcp',
      mcp: { transport: 'http', authType: 'oauth' },
    });

    const result = await new SourceCredentialManager().authenticate(source, callbacks().value);

    expect(result).toEqual({ success: false, error: 'MCP URL not configured' });
  });
});
