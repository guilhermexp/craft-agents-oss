import { describe, expect, test } from 'bun:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { WorkspaceObjectWatcherRegistry } from './workspace-object-watcher.ts';

describe('WorkspaceObjectWatcherRegistry', () => {
  test('refcounts one watcher per workspace, debounces paths, ignores sidecars, and tears down last client', async () => {
    let callback: ((event: string, filename: string | null) => void) | undefined;
    let closes = 0;
    const events: string[] = [];
    const registry = new WorkspaceObjectWatcherRegistry({
      watch: (_path, listener) => { callback = listener; return { close: () => { closes += 1; } }; },
      debounceMs: 1,
    });
    registry.subscribe('c1', 'w1', '/tmp/workspace', path => events.push(path));
    registry.subscribe('c2', 'w1', '/tmp/workspace', path => events.push(`second:${path}`));
    expect(registry.activeWatcherCount).toBe(1);
    callback?.('change', 'objects.sqlite-wal');
    callback?.('change', 'people/object.yaml.tmp');
    callback?.('change', 'people/object.yaml');
    callback?.('change', 'people/object.yaml');
    await Bun.sleep(10);
    expect(events).toEqual(['people/object.yaml', 'second:people/object.yaml']);
    registry.unsubscribe('c1', 'w1');
    expect(closes).toBe(0);
    registry.unsubscribe('c2', 'w1');
    expect(closes).toBe(1);
    expect(registry.activeWatcherCount).toBe(0);
  });

  test('tears down every workspace owned by a disconnected client', () => {
    const handles: Array<{ close: () => void }> = [];
    const registry = new WorkspaceObjectWatcherRegistry({ watch: () => {
      const handle = { close: () => {} };
      handles.push(handle);
      return handle;
    } });
    const root = mkdtempSync(join(tmpdir(), 'craft-watcher-'));
    try {
      registry.subscribe('client-one', 'workspace-one', root, () => {});
      registry.subscribe('client-one', 'workspace-two', root, () => {});
      expect(registry.activeWatcherCount).toBe(2);
      registry.unsubscribeClient('client-one');
      expect(registry.activeWatcherCount).toBe(0);
      expect(handles).toHaveLength(2);
    } finally {
      registry.closeAll();
      rmSync(root, { recursive: true, force: true });
    }
  });
});
