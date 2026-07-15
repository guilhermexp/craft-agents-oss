import { afterEach, beforeEach, describe, expect, it } from 'bun:test';
import { existsSync, mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { createCipheriv, createDecipheriv, randomBytes } from 'node:crypto';

import { SecureStorageBackend, type CredentialKeyProtector } from './secure-storage.ts';
import type { CredentialId, StoredCredential } from '../types.ts';

// Fake OS protector: XOR-with-pad stand-in for electron.safeStorage. Real
// protection comes from the OS; the backend only needs protect/unprotect to
// round-trip.
function fakeProtector(available = true): CredentialKeyProtector {
  const pad = Buffer.alloc(32, 0x5a);
  const xor = (data: Buffer) => Buffer.from(data.map((b, i) => b ^ pad[i % pad.length]!));
  return {
    isAvailable: () => available,
    protect: xor,
    unprotect: xor,
  };
}

const id: CredentialId = { type: 'llm_api_key', connectionSlug: 'openai' };
const credential: StoredCredential = { value: 'sk-test-123' };

describe('SecureStorageBackend key protector (F4.2)', () => {
  let dir = '';

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'craft-secure-storage-'));
  });

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  it('round-trips without a protector (current default format)', async () => {
    const backend = new SecureStorageBackend({ credentialsDir: dir });
    await backend.set(id, credential);

    const fresh = new SecureStorageBackend({ credentialsDir: dir });
    const loaded = await fresh.get(id);
    expect(loaded).toEqual(credential);
    expect(existsSync(join(dir, 'credentials.key'))).toBe(false);
  });

  it('reads a store written in the current format and lazily migrates when a protector appears', async () => {
    // Write with the current (machine-id) format
    const legacyBackend = new SecureStorageBackend({ credentialsDir: dir });
    await legacyBackend.set(id, credential);

    // Load with protector: existing credentials MUST still be readable
    const protectedBackend = new SecureStorageBackend({ credentialsDir: dir, keyProtector: fakeProtector() });
    const loaded = await protectedBackend.get(id);
    expect(loaded).toEqual(credential);

    // Lazy migration happened: sidecar created and store re-encrypted with it
    expect(existsSync(join(dir, 'credentials.key'))).toBe(true);
    const reload = new SecureStorageBackend({ credentialsDir: dir, keyProtector: fakeProtector() });
    expect(await reload.get(id)).toEqual(credential);
  });

  it('round-trips with a protector from scratch', async () => {
    const backend = new SecureStorageBackend({ credentialsDir: dir, keyProtector: fakeProtector() });
    await backend.set(id, credential);
    expect(existsSync(join(dir, 'credentials.key'))).toBe(true);

    const fresh = new SecureStorageBackend({ credentialsDir: dir, keyProtector: fakeProtector() });
    expect(await fresh.get(id)).toEqual(credential);
  });

  it('falls back to machine-id key when the protector reports unavailable', async () => {
    const backend = new SecureStorageBackend({ credentialsDir: dir, keyProtector: fakeProtector(false) });
    await backend.set(id, credential);
    expect(existsSync(join(dir, 'credentials.key'))).toBe(false);

    // Readable by a plain backend (same machine-id derivation)
    const plain = new SecureStorageBackend({ credentialsDir: dir });
    expect(await plain.get(id)).toEqual(credential);
  });

  it('does NOT delete a master-key-encrypted store when the protector is unavailable', async () => {
    // Write with protector (master-key encrypted + sidecar)
    const protectedBackend = new SecureStorageBackend({ credentialsDir: dir, keyProtector: fakeProtector() });
    await protectedBackend.set(id, credential);

    // Headless process without protector cannot decrypt — but must not
    // destroy the user's credentials as "corrupted"
    const headless = new SecureStorageBackend({ credentialsDir: dir });
    expect(await headless.get(id)).toBeNull();
    expect(existsSync(join(dir, 'credentials.enc'))).toBe(true);

    // A protector-capable process can still read everything afterwards
    const recovered = new SecureStorageBackend({ credentialsDir: dir, keyProtector: fakeProtector() });
    expect(await recovered.get(id)).toEqual(credential);
  });

  it('keeps AES-GCM round-trip sanity for the fake protector', () => {
    // Guard the test double itself: protect/unprotect must round-trip a key
    const protector = fakeProtector();
    const key = randomBytes(32);
    expect(protector.unprotect(protector.protect(key)).equals(key)).toBe(true);

    // And a key that round-trips must work as an AES-256-GCM key
    const iv = randomBytes(12);
    const cipher = createCipheriv('aes-256-gcm', key, iv);
    const ct = Buffer.concat([cipher.update('payload'), cipher.final()]);
    const tag = cipher.getAuthTag();
    const decipher = createDecipheriv('aes-256-gcm', key, iv);
    decipher.setAuthTag(tag);
    expect(Buffer.concat([decipher.update(ct), decipher.final()]).toString()).toBe('payload');
  });
});
