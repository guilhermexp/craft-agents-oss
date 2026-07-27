/**
 * Interface tests for CredentialManager.resolveLlmCredential and its thin
 * projection hasLlmCredentials.
 *
 * These exercise the single `authType -> credential` map through the public API
 * only: an in-memory backend is injected via the constructor (a supported DI
 * seam) and credentials are stored via the public setters. No private state is
 * touched.
 */

import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { CredentialManager } from './manager.ts';
import type { CredentialBackend } from './backends/types.ts';
import type { CredentialId, StoredCredential } from './types.ts';
import { credentialIdToAccount, KEYLESS_API_KEY_PLACEHOLDER } from './types.ts';

/** Minimal in-memory backend so tests never touch disk or the OS keychain. */
class InMemoryBackend implements CredentialBackend {
  readonly name = 'in-memory-test';
  readonly priority = 100;
  private readonly store = new Map<string, StoredCredential>();

  async isAvailable(): Promise<boolean> {
    return true;
  }
  async get(id: CredentialId): Promise<StoredCredential | null> {
    return this.store.get(credentialIdToAccount(id)) ?? null;
  }
  async set(id: CredentialId, credential: StoredCredential): Promise<void> {
    this.store.set(credentialIdToAccount(id), credential);
  }
  async delete(id: CredentialId): Promise<boolean> {
    return this.store.delete(credentialIdToAccount(id));
  }
  async list(): Promise<CredentialId[]> {
    return [];
  }
}

const SLUG = 'test-connection';

let manager: CredentialManager;

beforeEach(() => {
  manager = new CredentialManager([new InMemoryBackend()]);
});

describe('resolveLlmCredential — keyless (none)', () => {
  test('resolves to kind "none" without any stored credential', async () => {
    const resolved = await manager.resolveLlmCredential(SLUG, 'none');
    expect(resolved).toEqual({ kind: 'none' });
    expect(await manager.hasLlmCredentials(SLUG, 'none')).toBe(true);
  });
});

describe('resolveLlmCredential — api key family', () => {
  for (const authType of ['api_key', 'api_key_with_endpoint', 'bearer_token'] as const) {
    test(`${authType}: resolves the stored key`, async () => {
      await manager.setLlmApiKey(SLUG, 'sk-secret');
      expect(await manager.resolveLlmCredential(SLUG, authType)).toEqual({
        kind: 'api_key',
        value: 'sk-secret',
      });
      expect(await manager.hasLlmCredentials(SLUG, authType)).toBe(true);
    });

    test(`${authType}: resolves to null when no key is stored`, async () => {
      expect(await manager.resolveLlmCredential(SLUG, authType)).toBeNull();
      expect(await manager.hasLlmCredentials(SLUG, authType)).toBe(false);
    });
  }
});

describe('resolveLlmCredential — oauth', () => {
  test('resolves a stored, unexpired token', async () => {
    await manager.setLlmOAuth(SLUG, {
      accessToken: 'access',
      refreshToken: 'refresh',
      expiresAt: Date.now() + 10 * 60 * 1000,
    });
    expect(await manager.resolveLlmCredential(SLUG, 'oauth')).toEqual({
      kind: 'oauth',
      accessToken: 'access',
      refreshToken: 'refresh',
      expiresAt: expect.any(Number),
    });
    expect(await manager.hasLlmCredentials(SLUG, 'oauth')).toBe(true);
  });

  test('resolves to null when no token is stored', async () => {
    expect(await manager.resolveLlmCredential(SLUG, 'oauth')).toBeNull();
    expect(await manager.hasLlmCredentials(SLUG, 'oauth')).toBe(false);
  });

  test('an expired token with a refresh token is still usable', async () => {
    await manager.setLlmOAuth(SLUG, {
      accessToken: 'access',
      refreshToken: 'refresh',
      expiresAt: Date.now() - 1000,
    });
    expect(await manager.hasLlmCredentials(SLUG, 'oauth')).toBe(true);
  });

  test('an expired token without a refresh token resolves to null', async () => {
    await manager.setLlmOAuth(SLUG, {
      accessToken: 'access',
      expiresAt: Date.now() - 1000,
    });
    expect(await manager.resolveLlmCredential(SLUG, 'oauth')).toBeNull();
    expect(await manager.hasLlmCredentials(SLUG, 'oauth')).toBe(false);
  });
});

describe('resolveLlmCredential — iam_credentials', () => {
  test('resolves stored IAM credentials', async () => {
    await manager.setLlmIamCredentials(SLUG, {
      accessKeyId: 'AKIA',
      secretAccessKey: 'secret',
      region: 'us-east-1',
      sessionToken: 'session',
    });
    expect(await manager.resolveLlmCredential(SLUG, 'iam_credentials')).toEqual({
      kind: 'iam',
      accessKeyId: 'AKIA',
      secretAccessKey: 'secret',
      region: 'us-east-1',
      sessionToken: 'session',
    });
    expect(await manager.hasLlmCredentials(SLUG, 'iam_credentials')).toBe(true);
  });

  test('resolves to null when no IAM credentials are stored', async () => {
    expect(await manager.resolveLlmCredential(SLUG, 'iam_credentials')).toBeNull();
    expect(await manager.hasLlmCredentials(SLUG, 'iam_credentials')).toBe(false);
  });
});

describe('resolveLlmCredential — service_account_file', () => {
  test('resolves the stored service account payload', async () => {
    await manager.setLlmServiceAccount(SLUG, {
      serviceAccountJson: '{"type":"service_account"}',
      projectId: 'proj',
    });
    expect(await manager.resolveLlmCredential(SLUG, 'service_account_file')).toEqual({
      kind: 'service_account',
      path: '{"type":"service_account"}',
    });
    expect(await manager.hasLlmCredentials(SLUG, 'service_account_file')).toBe(true);
  });

  test('resolves to null when no service account is stored', async () => {
    expect(await manager.resolveLlmCredential(SLUG, 'service_account_file')).toBeNull();
    expect(await manager.hasLlmCredentials(SLUG, 'service_account_file')).toBe(false);
  });
});

describe('resolveLlmCredential — environment', () => {
  const original = process.env.ANTHROPIC_API_KEY;

  afterEach(() => {
    if (original === undefined) {
      delete process.env.ANTHROPIC_API_KEY;
    } else {
      process.env.ANTHROPIC_API_KEY = original;
    }
  });

  test('anthropic: resolves the env var when set', async () => {
    process.env.ANTHROPIC_API_KEY = 'from-env';
    expect(await manager.resolveLlmCredential(SLUG, 'environment', 'anthropic')).toEqual({
      kind: 'environment',
      value: 'from-env',
    });
    expect(await manager.hasLlmCredentials(SLUG, 'environment', 'anthropic')).toBe(true);
  });

  test('anthropic: resolves to null when the env var is unset', async () => {
    delete process.env.ANTHROPIC_API_KEY;
    expect(await manager.resolveLlmCredential(SLUG, 'environment', 'anthropic')).toBeNull();
    // Divergence fix: previously hasLlmCredentials returned true unconditionally.
    expect(await manager.hasLlmCredentials(SLUG, 'environment', 'anthropic')).toBe(false);
  });

  test('non-anthropic (credential chain) is present even without a single env var', async () => {
    delete process.env.ANTHROPIC_API_KEY;
    expect(await manager.resolveLlmCredential(SLUG, 'environment', 'pi')).toEqual({
      kind: 'environment',
      value: '',
    });
    expect(await manager.hasLlmCredentials(SLUG, 'environment', 'pi')).toBe(true);
  });
});

describe('keyless placeholder constant', () => {
  test('is a single non-empty token', () => {
    expect(KEYLESS_API_KEY_PLACEHOLDER).toBe('not-needed');
    expect(KEYLESS_API_KEY_PLACEHOLDER.length).toBeGreaterThan(0);
  });
});

describe('ephemeral LLM API key (validate-without-persisting)', () => {
  test('is resolvable by slug but never written to a backend', async () => {
    manager.setEphemeralLlmApiKey(SLUG, 'ephemeral-key');

    expect(await manager.getLlmApiKey(SLUG)).toBe('ephemeral-key');
    expect(await manager.resolveLlmCredential(SLUG, 'api_key')).toEqual({
      kind: 'api_key',
      value: 'ephemeral-key',
    });

    manager.clearEphemeralLlmApiKey(SLUG);
    expect(await manager.getLlmApiKey(SLUG)).toBeNull();
  });

  test('takes precedence over a persisted key while set', async () => {
    await manager.setLlmApiKey(SLUG, 'persisted');
    manager.setEphemeralLlmApiKey(SLUG, 'ephemeral');
    expect(await manager.getLlmApiKey(SLUG)).toBe('ephemeral');

    manager.clearEphemeralLlmApiKey(SLUG);
    expect(await manager.getLlmApiKey(SLUG)).toBe('persisted');
  });
});
