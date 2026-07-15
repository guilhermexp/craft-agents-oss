/**
 * Secure Storage Backend
 *
 * Stores credentials in an encrypted file at ~/.craft-agent/credentials.enc
 * Uses AES-256-GCM for authenticated encryption.
 *
 * Encryption key is derived from OS-native hardware UUID using PBKDF2:
 * - macOS: IOPlatformUUID (tied to logic board, never changes)
 * - Windows: MachineGuid from registry (set at OS install)
 * - Linux: /var/lib/dbus/machine-id (set at OS install)
 *
 * This is more stable than the previous hostname-based derivation, which could
 * change with network/DHCP. Legacy credentials are auto-migrated on first load.
 *
 * File format:
 *   [Header - 64 bytes]
 *   ├── Magic: "CRAFT01\0" (8 bytes)
 *   ├── Flags: uint32 LE (4 bytes) - reserved for future use
 *   ├── Salt: 32 bytes (PBKDF2 salt)
 *   ├── Reserved: 20 bytes
 *   [Encrypted Payload]
 *   ├── IV: 12 bytes (random per write)
 *   ├── Auth Tag: 16 bytes (GCM authentication)
 *   └── Ciphertext: variable (encrypted JSON)
 */

import {
  createCipheriv,
  createDecipheriv,
  randomBytes,
  pbkdf2Sync,
  createHash,
} from 'crypto';
import { execSync } from 'child_process';
import { existsSync, readFileSync, writeFileSync, mkdirSync, unlinkSync } from 'fs';
import { hostname, userInfo, homedir } from 'os';
import { join, dirname } from 'path';

import type { CredentialBackend } from './types.ts';
import type { CredentialId, StoredCredential } from '../types.ts';
import { credentialIdToAccount, accountToCredentialId } from '../types.ts';

// File location
const CREDENTIALS_DIR = join(homedir(), '.craft-agent');

// File format constants
const MAGIC_BYTES = Buffer.from('CRAFT01\0');
const HEADER_SIZE = 64;
const MAGIC_SIZE = 8;
const FLAGS_SIZE = 4;
const SALT_SIZE = 32;
const IV_SIZE = 12;
const AUTH_TAG_SIZE = 16;
const KEY_SIZE = 32;

// PBKDF2 iterations (balance security vs startup time)
const PBKDF2_ITERATIONS = 100000;

/**
 * Get stable machine identifier using OS-native hardware UUID.
 * This is far more stable than hostname which can change with network/DHCP.
 * Falls back to username + homedir if hardware UUID unavailable.
 */
function getStableMachineId(): string {
  try {
    if (process.platform === 'darwin') {
      // macOS: IOPlatformUUID - tied to logic board, never changes
      const output = execSync(
        'ioreg -rd1 -c IOPlatformExpertDevice | grep IOPlatformUUID',
        { encoding: 'utf-8', stdio: ['pipe', 'pipe', 'pipe'] }
      );
      const match = output.match(/"IOPlatformUUID"\s*=\s*"([^"]+)"/);
      if (match?.[1]) return match[1];
    } else if (process.platform === 'win32') {
      // Windows: MachineGuid from registry - set at OS install
      const output = execSync(
        'reg query HKEY_LOCAL_MACHINE\\SOFTWARE\\Microsoft\\Cryptography /v MachineGuid',
        { encoding: 'utf-8', stdio: ['pipe', 'pipe', 'pipe'] }
      );
      const match = output.match(/MachineGuid\s+REG_SZ\s+(\S+)/);
      if (match?.[1]) return match[1];
    } else {
      // Linux: dbus machine-id - set at OS install
      const machineIdPath = '/var/lib/dbus/machine-id';
      const altPath = '/etc/machine-id';
      if (existsSync(machineIdPath)) {
        return readFileSync(machineIdPath, 'utf-8').trim();
      } else if (existsSync(altPath)) {
        return readFileSync(altPath, 'utf-8').trim();
      }
    }
  } catch {
    // Fall through to fallback
  }

  // Fallback: username + homedir (stable enough for most cases)
  return `${userInfo().username}:${homedir()}`;
}

/**
 * Optional OS-backed key protector (F4.2, opt-in).
 *
 * Implemented in the Electron main process via `electron.safeStorage`
 * (Keychain / DPAPI / libsecret). When injected and available, the store is
 * encrypted with a random master key kept OS-protected in a `credentials.key`
 * sidecar instead of the machine-id-derived key. NOT enabled by default:
 * `packages/shared` also runs in the headless server subprocess, which has no
 * Electron — flipping the default would break credential reads there until
 * main→server key distribution exists.
 */
export interface CredentialKeyProtector {
  isAvailable(): boolean;
  /** Encrypt the raw master key for at-rest storage (e.g. safeStorage.encryptString). */
  protect(data: Buffer): Buffer;
  /** Decrypt the stored master key. */
  unprotect(data: Buffer): Buffer;
}

/** Internal credential store structure */
interface CredentialStore {
  version: 1;
  credentials: Record<string, StoredCredential>;
  metadata: {
    createdAt: number;
    updatedAt: number;
  };
}

export class SecureStorageBackend implements CredentialBackend {
  readonly name = 'secure-storage';
  readonly priority = 100;

  private cachedStore: CredentialStore | null = null;
  private encryptionKey: Buffer | null = null;
  private salt: Buffer | null = null;
  private masterKey: Buffer | null = null;
  private readonly keyProtector: CredentialKeyProtector | undefined;
  private readonly credentialsDir: string;
  private readonly credentialsFile: string;
  private readonly keyFile: string;

  constructor(options?: { keyProtector?: CredentialKeyProtector; credentialsDir?: string }) {
    this.keyProtector = options?.keyProtector;
    this.credentialsDir = options?.credentialsDir ?? CREDENTIALS_DIR;
    this.credentialsFile = join(this.credentialsDir, 'credentials.enc');
    this.keyFile = join(this.credentialsDir, 'credentials.key');
  }

  async isAvailable(): Promise<boolean> {
    // File backend is always available - we can always write to filesystem
    return true;
  }

  async get(id: CredentialId): Promise<StoredCredential | null> {
    const store = await this.loadStore();
    if (!store) return null;

    const key = credentialIdToAccount(id);
    return store.credentials[key] || null;
  }

  async set(id: CredentialId, credential: StoredCredential): Promise<void> {
    let store = await this.loadStore();

    if (!store) {
      // Initialize new store
      store = {
        version: 1,
        credentials: {},
        metadata: {
          createdAt: Date.now(),
          updatedAt: Date.now(),
        },
      };
    }

    const key = credentialIdToAccount(id);
    store.credentials[key] = credential;
    store.metadata.updatedAt = Date.now();

    await this.saveStore(store);
  }

  async delete(id: CredentialId): Promise<boolean> {
    return this.deleteSync(id);
  }

  deleteSync(id: CredentialId): boolean {
    const store = this.loadStoreSync();
    if (!store) return false;

    const key = credentialIdToAccount(id);
    if (!(key in store.credentials)) return false;

    delete store.credentials[key];
    store.metadata.updatedAt = Date.now();

    this.saveStoreSync(store);
    return true;
  }

  async list(filter?: Partial<CredentialId>): Promise<CredentialId[]> {
    const store = await this.loadStore();
    if (!store) return [];

    const ids = Object.keys(store.credentials)
      .map(accountToCredentialId)
      .filter((id): id is CredentialId => id !== null);

    if (!filter) return ids;

    return ids.filter((id) => {
      if (filter.type && id.type !== filter.type) return false;
      if (filter.workspaceId && id.workspaceId !== filter.workspaceId) return false;
      if (filter.name && id.name !== filter.name) return false;
      return true;
    });
  }

  // ============================================================
  // Private Methods
  // ============================================================

  private async loadStore(): Promise<CredentialStore | null> {
    return this.loadStoreSync();
  }

  private loadStoreSync(): CredentialStore | null {
    // Return cached store if available
    if (this.cachedStore) return this.cachedStore;

    if (!existsSync(this.credentialsFile)) return null;

    let fileData: Buffer;
    try {
      fileData = readFileSync(this.credentialsFile);
    } catch {
      return null;
    }

    // Validate minimum size
    if (fileData.length < HEADER_SIZE + IV_SIZE + AUTH_TAG_SIZE) {
      // File is corrupted, delete and return null
      this.handleCorruptedFile();
      return null;
    }

    // Validate magic bytes
    if (!fileData.subarray(0, MAGIC_SIZE).equals(MAGIC_BYTES)) {
      this.handleCorruptedFile();
      return null;
    }

    // Parse header
    // const flags = fileData.readUInt32LE(MAGIC_SIZE); // Reserved for future use
    const salt = fileData.subarray(MAGIC_SIZE + FLAGS_SIZE, MAGIC_SIZE + FLAGS_SIZE + SALT_SIZE);
    this.salt = salt;

    // Extract encrypted data
    const encryptedData = fileData.subarray(HEADER_SIZE);

    // Try the OS-protected master key first (F4.2 opt-in, sidecar present)
    const masterKey = this.loadMasterKey();
    if (masterKey) {
      const masterStore = this.tryDecrypt(encryptedData, masterKey);
      if (masterStore) {
        this.cachedStore = masterStore;
        return masterStore;
      }
    }

    // Try new stable key first (v2 - hardware UUID based)
    const newKey = this.getEncryptionKey(salt);
    let store = this.tryDecrypt(encryptedData, newKey);

    if (store) {
      this.cachedStore = store;
      // Lazy migration: re-encrypt with the OS-protected master key when a
      // protector is available (no-op otherwise — saveStoreSync picks the key).
      // A failed migration must never break a successful read.
      if (this.protectorAvailable()) {
        try {
          this.saveStoreSync(store);
        } catch {
          // keep serving the successfully decrypted store
        }
      }
      return store;
    }

    // Try legacy key for migration (v1 - included hostname)
    // This handles credentials encrypted with old key derivation
    const legacyKey = this.getLegacyEncryptionKey(salt);
    store = this.tryDecrypt(encryptedData, legacyKey);

    if (store) {
      // Migration: re-save with new stable key so future loads use hardware UUID
      this.cachedStore = store;
      this.saveStoreSync(store);
      return store;
    }

    // A key sidecar exists but this process has no usable protector (e.g.
    // headless server without Electron): the file is likely master-key
    // encrypted, NOT corrupted — never delete the user's credentials here.
    if (existsSync(this.keyFile) && !this.protectorAvailable()) {
      return null;
    }

    // All keys failed - file is truly corrupted
    this.handleCorruptedFile();
    return null;
  }

  private protectorAvailable(): boolean {
    try {
      return Boolean(this.keyProtector?.isAvailable());
    } catch {
      return false;
    }
  }

  /** Read and unprotect the master key sidecar. Null when absent/unusable. */
  private loadMasterKey(): Buffer | null {
    if (!this.protectorAvailable()) return null;
    if (this.masterKey) return this.masterKey;
    try {
      if (!existsSync(this.keyFile)) return null;
      const key = this.keyProtector!.unprotect(readFileSync(this.keyFile));
      if (key.length !== KEY_SIZE) return null;
      this.masterKey = key;
      return key;
    } catch {
      return null;
    }
  }

  /** Master key for writes — creates and persists the sidecar on first use. */
  private loadOrCreateMasterKey(): Buffer | null {
    const existing = this.loadMasterKey();
    if (existing) return existing;
    if (!this.protectorAvailable()) return null;
    try {
      const key = randomBytes(KEY_SIZE);
      if (!existsSync(this.credentialsDir)) {
        mkdirSync(this.credentialsDir, { recursive: true, mode: 0o700 });
      }
      writeFileSync(this.keyFile, this.keyProtector!.protect(key), { mode: 0o600 });
      this.masterKey = key;
      return key;
    } catch {
      return null;
    }
  }

  /**
   * Attempt to decrypt data with given key.
   * Returns parsed store on success, null on failure.
   */
  private tryDecrypt(encryptedData: Buffer, key: Buffer): CredentialStore | null {
    try {
      const iv = encryptedData.subarray(0, IV_SIZE);
      const authTag = encryptedData.subarray(IV_SIZE, IV_SIZE + AUTH_TAG_SIZE);
      const ciphertext = encryptedData.subarray(IV_SIZE + AUTH_TAG_SIZE);

      const decipher = createDecipheriv('aes-256-gcm', key, iv);
      decipher.setAuthTag(authTag);
      const decrypted = Buffer.concat([decipher.update(ciphertext), decipher.final()]);
      return JSON.parse(decrypted.toString('utf8'));
    } catch {
      return null;
    }
  }

  private async saveStore(store: CredentialStore): Promise<void> {
    this.saveStoreSync(store);
  }

  private saveStoreSync(store: CredentialStore): void {
    // Ensure directory exists
    if (!existsSync(this.credentialsDir)) {
      mkdirSync(this.credentialsDir, { recursive: true, mode: 0o700 });
    }

    // Use existing salt or generate new one
    const salt = this.salt || randomBytes(SALT_SIZE);
    this.salt = salt;

    // Encryption key: OS-protected master key when a protector is available
    // (F4.2 opt-in), machine-id derivation otherwise (current default)
    const key = this.loadOrCreateMasterKey() ?? this.getEncryptionKey(salt);

    // Serialize payload
    const plaintext = Buffer.from(JSON.stringify(store), 'utf8');

    // Generate new IV for each write (critical for GCM security)
    const iv = randomBytes(IV_SIZE);

    // Encrypt
    const cipher = createCipheriv('aes-256-gcm', key, iv);
    const ciphertext = Buffer.concat([cipher.update(plaintext), cipher.final()]);
    const authTag = cipher.getAuthTag();

    // Build header
    const header = Buffer.alloc(HEADER_SIZE);
    MAGIC_BYTES.copy(header, 0);
    header.writeUInt32LE(0, MAGIC_SIZE); // Flags (reserved)
    salt.copy(header, MAGIC_SIZE + FLAGS_SIZE);

    // Combine all parts
    const fileData = Buffer.concat([header, iv, authTag, ciphertext]);

    // Write with restrictive permissions (owner read/write only)
    writeFileSync(this.credentialsFile, fileData, { mode: 0o600 });
    this.cachedStore = store;
  }

  private getEncryptionKey(salt: Buffer): Buffer {
    if (this.encryptionKey) return this.encryptionKey;

    // New stable machine ID using hardware UUID (v2)
    // This is far more stable than hostname which can change with network/DHCP
    const stableMachineId = createHash('sha256')
      .update(getStableMachineId())
      .update('craft-agent-v2') // Bumped version for new key derivation
      .digest();

    // Derive key using PBKDF2
    this.encryptionKey = pbkdf2Sync(stableMachineId, salt, PBKDF2_ITERATIONS, KEY_SIZE, 'sha256');

    return this.encryptionKey;
  }

  /**
   * Legacy key derivation for migration from v1 (included hostname).
   * Used to decrypt credentials from older versions before re-encrypting with stable key.
   */
  private getLegacyEncryptionKey(salt: Buffer): Buffer {
    const legacyMachineId = createHash('sha256')
      .update(hostname())
      .update(userInfo().username)
      .update(homedir())
      .update('craft-agent-v1')
      .digest();

    return pbkdf2Sync(legacyMachineId, salt, PBKDF2_ITERATIONS, KEY_SIZE, 'sha256');
  }

  private handleCorruptedFile(): void {
    // Delete corrupted file - user will need to re-enter credentials
    try {
      if (existsSync(this.credentialsFile)) {
        unlinkSync(this.credentialsFile);
      }
    } catch {
      // Ignore deletion errors
    }
    this.cachedStore = null;
    this.encryptionKey = null;
    this.salt = null;
    this.masterKey = null;
  }

  /** Clear cached data (for testing or forced refresh) */
  clearCache(): void {
    this.cachedStore = null;
    this.encryptionKey = null;
    this.salt = null;
    this.masterKey = null;
  }
}
