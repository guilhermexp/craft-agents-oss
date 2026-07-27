import { afterEach, describe, expect, it, spyOn } from 'bun:test';
import { anthropicDriver } from './anthropic.ts';
import { CredentialManager } from '../../../../credentials/manager.ts';
import type { CredentialBackend } from '../../../../credentials/backends/types.ts';
import type { CredentialId, StoredCredential } from '../../../../credentials/types.ts';
import { credentialIdToAccount, KEYLESS_API_KEY_PLACEHOLDER } from '../../../../credentials/types.ts';
import type { LlmConnection } from '../../../../config/llm-connections.ts';
import * as llmValidation from '../../../../config/llm-validation.ts';

/** In-memory credential backend so the driver resolves creds without disk I/O. */
class InMemoryBackend implements CredentialBackend {
  readonly name = 'in-memory-test';
  readonly priority = 100;
  private readonly store = new Map<string, StoredCredential>();
  async isAvailable() { return true; }
  async get(id: CredentialId) { return this.store.get(credentialIdToAccount(id)) ?? null; }
  async set(id: CredentialId, cred: StoredCredential) { this.store.set(credentialIdToAccount(id), cred); }
  async delete(id: CredentialId) { return this.store.delete(credentialIdToAccount(id)); }
  async list() { return [] as CredentialId[]; }
}

const originalFetch = globalThis.fetch;

afterEach(() => {
  globalThis.fetch = originalFetch;
});

describe('anthropicDriver.fetchModels', () => {
  it('filters deprecated Opus models from live startup refresh and prefers Opus 5 as default', async () => {
    globalThis.fetch = (async () => new Response(JSON.stringify({
      data: [
        { id: 'claude-opus-4-6', display_name: 'Claude Opus 4.6', created_at: '2026-01-01T00:00:00Z', type: 'model' },
        { id: 'claude-opus-5', display_name: 'Claude Opus 5', created_at: '2026-07-23T00:00:00Z', type: 'model' },
        { id: 'claude-opus-4-8', display_name: 'Claude Opus 4.8', created_at: '2026-05-01T00:00:00Z', type: 'model' },
        { id: 'claude-opus-4-7', display_name: 'Claude Opus 4.7', created_at: '2026-04-01T00:00:00Z', type: 'model' },
        { id: 'claude-opus-4-5-20251101', display_name: 'Claude Opus 4.5', created_at: '2025-11-01T00:00:00Z', type: 'model' },
        { id: 'claude-sonnet-4-6', display_name: 'Claude Sonnet 4.6', created_at: '2026-01-01T00:00:00Z', type: 'model' },
      ],
      has_more: false,
      first_id: 'claude-opus-4-6',
      last_id: 'claude-sonnet-4-6',
    }), { status: 200 })) as unknown as typeof fetch;

    const result = await anthropicDriver.fetchModels!({
      connection: {
        slug: 'anthropic',
        name: 'Anthropic',
        providerType: 'anthropic',
        authType: 'api_key',
        createdAt: Date.now(),
      } as any,
      credentials: { apiKey: 'sk-ant-test' },
      hostRuntime: {} as any,
      resolvedPaths: {} as any,
      timeoutMs: 30_000,
    });

    expect(result.serverDefault).toBe('claude-opus-5');
    expect(result.models.map(m => m.id)).toEqual([
      'claude-opus-5',
      'claude-opus-4-8',
      'claude-opus-4-7',
      'claude-sonnet-4-6',
    ]);
    expect(result.models[0]!.name).toBe('Opus 5');
    expect(result.models[0]!.contextWindow).toBe(1_000_000);
  });

  it('falls back to the newest served model when Opus 5 is not in the catalog yet', async () => {
    globalThis.fetch = (async () => new Response(JSON.stringify({
      data: [
        { id: 'claude-opus-4-8', display_name: 'Claude Opus 4.8', created_at: '2026-05-01T00:00:00Z', type: 'model' },
        { id: 'claude-sonnet-4-6', display_name: 'Claude Sonnet 4.6', created_at: '2026-01-01T00:00:00Z', type: 'model' },
      ],
      has_more: false,
      first_id: 'claude-opus-4-8',
      last_id: 'claude-sonnet-4-6',
    }), { status: 200 })) as unknown as typeof fetch;

    const result = await anthropicDriver.fetchModels!({
      connection: {
        slug: 'claude-max',
        name: 'Claude Max',
        providerType: 'anthropic',
        authType: 'oauth',
        createdAt: Date.now(),
      } as unknown as Parameters<NonNullable<typeof anthropicDriver.fetchModels>>[0]['connection'],
      credentials: { oauthAccessToken: 'oauth-test' },
      hostRuntime: {} as never,
      resolvedPaths: {} as never,
      timeoutMs: 30_000,
    });

    expect(result.serverDefault).toBe('claude-opus-4-8');
  });
});

describe('anthropicDriver.validateStoredConnection — credential arms', () => {
  function makeConnection(overrides: Partial<LlmConnection> = {}): LlmConnection {
    return {
      slug: 'anthropic',
      name: 'Anthropic',
      providerType: 'anthropic',
      authType: 'api_key',
      defaultModel: 'claude-opus-5',
      createdAt: Date.now(),
      ...overrides,
    } as LlmConnection;
  }

  async function validate(connection: LlmConnection, manager: CredentialManager) {
    return anthropicDriver.validateStoredConnection!({
      slug: connection.slug,
      connection,
      credentialManager: manager,
      hostRuntime: {} as never,
      resolvedPaths: {} as never,
    });
  }

  it('reports missing credentials for api_key with no stored key (no SDK call)', async () => {
    const manager = new CredentialManager([new InMemoryBackend()]);
    const result = await validate(makeConnection({ authType: 'api_key' }), manager);
    expect(result).toEqual({ success: false, error: 'Could not retrieve credentials' });
  });

  it('rejects iam_credentials — an arm the anthropic provider cannot use — even when stored', async () => {
    const manager = new CredentialManager([new InMemoryBackend()]);
    await manager.setLlmIamCredentials('anthropic', {
      accessKeyId: 'AKIA',
      secretAccessKey: 'secret',
    });
    const result = await validate(makeConnection({ authType: 'iam_credentials' }), manager);
    expect(result).toEqual({ success: false, error: 'Could not retrieve credentials' });
  });

  it('rejects service_account_file — an arm the anthropic provider cannot use — even when stored', async () => {
    const manager = new CredentialManager([new InMemoryBackend()]);
    await manager.setLlmServiceAccount('anthropic', {
      serviceAccountJson: '{"type":"service_account"}',
    });
    const result = await validate(makeConnection({ authType: 'service_account_file' }), manager);
    expect(result).toEqual({ success: false, error: 'Could not retrieve credentials' });
  });

  it('keyless (authType none) sends the placeholder api key — not oauth — to validation', async () => {
    const manager = new CredentialManager([new InMemoryBackend()]);
    const spy = spyOn(llmValidation, 'validateAnthropicConnection').mockResolvedValue({ success: true });
    try {
      const result = await validate(makeConnection({ authType: 'none' }), manager);
      expect(result).toEqual({ success: true });
      expect(spy).toHaveBeenCalledTimes(1);
      const arg = spy.mock.calls[0]![0];
      expect(arg.apiKey).toBe(KEYLESS_API_KEY_PLACEHOLDER);
      expect(arg.oauthToken).toBeUndefined();
    } finally {
      spy.mockRestore();
    }
  });

  it('keyless api-key connection (custom endpoint, no stored key) falls back to the placeholder — matching the session env-var path', async () => {
    const manager = new CredentialManager([new InMemoryBackend()]);
    const spy = spyOn(llmValidation, 'validateAnthropicConnection').mockResolvedValue({ success: true });
    try {
      const result = await validate(
        makeConnection({ authType: 'api_key', baseUrl: 'http://localhost:11434' }),
        manager,
      );
      expect(result).toEqual({ success: true });
      expect(spy).toHaveBeenCalledTimes(1);
      expect(spy.mock.calls[0]![0].apiKey).toBe(KEYLESS_API_KEY_PLACEHOLDER);
    } finally {
      spy.mockRestore();
    }
  });

  it('bearer_token sends the stored secret as an oauth/Bearer token, not an x-api-key', async () => {
    const manager = new CredentialManager([new InMemoryBackend()]);
    await manager.setLlmApiKey('anthropic', 'brr-secret');
    const spy = spyOn(llmValidation, 'validateAnthropicConnection').mockResolvedValue({ success: true });
    try {
      const result = await validate(makeConnection({ authType: 'bearer_token' }), manager);
      expect(result).toEqual({ success: true });
      expect(spy).toHaveBeenCalledTimes(1);
      const arg = spy.mock.calls[0]![0];
      expect(arg.oauthToken).toBe('brr-secret');
      expect(arg.apiKey).toBeUndefined();
    } finally {
      spy.mockRestore();
    }
  });

  it('environment auth with the var unset returns the ANTHROPIC_API_KEY-specific diagnostic (no SDK call)', async () => {
    const manager = new CredentialManager([new InMemoryBackend()]);
    const spy = spyOn(llmValidation, 'validateAnthropicConnection').mockResolvedValue({ success: true });
    const original = process.env.ANTHROPIC_API_KEY;
    delete process.env.ANTHROPIC_API_KEY;
    try {
      const result = await validate(makeConnection({ authType: 'environment' }), manager);
      expect(result).toEqual({ success: false, error: 'ANTHROPIC_API_KEY environment variable not set' });
      expect(spy).not.toHaveBeenCalled();
    } finally {
      if (original === undefined) delete process.env.ANTHROPIC_API_KEY;
      else process.env.ANTHROPIC_API_KEY = original;
      spy.mockRestore();
    }
  });
});
