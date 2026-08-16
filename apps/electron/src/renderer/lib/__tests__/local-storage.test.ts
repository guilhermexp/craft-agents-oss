import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { KEYS, read } from '../local-storage.ts';

// A minimal localStorage stand-in whose getItem can be made to throw, so the
// typed `read` can be exercised for every outcome regardless of the host env.
class FakeStorage {
  private store = new Map<string, string>();
  throwOnGet = false;

  getItem(key: string): string | null {
    if (this.throwOnGet) throw new Error('storage unavailable');
    return this.store.has(key) ? this.store.get(key)! : null;
  }

  setItem(key: string, value: string): void {
    this.store.set(key, value);
  }
}

// The test swaps the ambient localStorage global. Its DOM-lib type is not in
// scope for this runtime, so a single named cast views globalThis as carrying
// an optional slot with just the two methods `read` touches.
type LocalStorageHost = { localStorage: Pick<Storage, 'getItem' | 'setItem'> | undefined };
const host = globalThis as unknown as LocalStorageHost;

let fake: FakeStorage;
const original = host.localStorage;

beforeEach(() => {
  fake = new FakeStorage();
  host.localStorage = fake;
});

afterEach(() => {
  host.localStorage = original;
});

// `read` prefixes with 'craft-' and the key value 'workspace-object-tabs'.
const rawKey = 'craft-workspace-object-tabs:w1:objects';
const suffix = 'w1:objects';

describe('local storage typed read', () => {
  test('returns the parsed value when a well-formed entry is present', () => {
    fake.setItem(rawKey, JSON.stringify({ tabs: [], activeId: null }));
    expect(read(KEYS.workspaceObjectTabs, suffix)).toEqual({
      status: 'present',
      value: { tabs: [], activeId: null },
    });
  });

  test('reports an absent key distinctly from a failure', () => {
    expect(read(KEYS.workspaceObjectTabs, suffix)).toEqual({ status: 'absent' });
  });

  test('reports corrupt JSON distinctly from a failure', () => {
    fake.setItem(rawKey, '{not json');
    expect(read(KEYS.workspaceObjectTabs, suffix)).toEqual({ status: 'corrupt' });
  });

  test('a throwing backend read surfaces as failed rather than absent', () => {
    fake.setItem(rawKey, JSON.stringify({ tabs: [], activeId: null }));
    fake.throwOnGet = true;
    // The bytes are still there; the read just could not reach them.
    expect(read(KEYS.workspaceObjectTabs, suffix)).toEqual({ status: 'failed' });
  });
});
