import { describe, expect, test } from 'bun:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { WORKSPACE_OBJECT_WATCH_ALL, WorkspaceObjectWatcherRegistry } from './workspace-object-watcher.ts';

describe('WorkspaceObjectWatcherRegistry', () => {
  test('refcounts one watcher per workspace, debounces paths, ignores sidecars, and tears down last client', async () => {
    let callback: ((event: string, filename: string | null) => void) | undefined;
    let closes = 0;
    const events: string[] = [];
    const reconciliations: string[] = [];
    const registry = new WorkspaceObjectWatcherRegistry({
      watch: (_path, listener) => { callback = listener; return { close: () => { closes += 1; } }; },
      debounceMs: 1,
    });
    registry.subscribe('c1', 'w1', '/tmp/workspace', path => events.push(path), path => reconciliations.push(path));
    registry.subscribe('c2', 'w1', '/tmp/workspace', path => events.push(`second:${path}`));
    expect(registry.activeWatcherCount).toBe(1);
    callback?.('change', 'objects.sqlite-wal');
    callback?.('change', 'objects.sqlite-journal');
    callback?.('change', 'people/object.yaml.tmp');
    callback?.('change', 'people/object.yaml');
    callback?.('change', 'people/object.yaml');
    callback?.('change', '.events/object_people.json');
    await Bun.sleep(10);
    expect(events).toEqual([
      'people/object.yaml', 'second:people/object.yaml',
      '.events/object_people.json', 'second:.events/object_people.json',
    ]);
    expect(reconciliations).toEqual(['people/object.yaml', '.events/object_people.json']);
    registry.unsubscribe('c1', 'w1');
    expect(closes).toBe(0);
    registry.unsubscribe('c2', 'w1');
    expect(closes).toBe(1);
    expect(registry.activeWatcherCount).toBe(0);
  });

  test('tears down every handle and pending timer owned by a disconnected client', async () => {
    const callbacks: Array<(event: string, filename: string | null) => void> = [];
    const closes = [0, 0];
    const events: string[] = [];
    const reconciliations: string[] = [];
    const registry = new WorkspaceObjectWatcherRegistry({ watch: (_path, listener) => {
      const handleIndex = callbacks.length;
      callbacks.push(listener);
      const handle = { close: () => { closes[handleIndex] += 1; } };
      return handle;
    }, debounceMs: 20 });
    const root = mkdtempSync(join(tmpdir(), 'craft-watcher-'));
    try {
      registry.subscribe('client-one', 'workspace-one', root, path => events.push(path), path => reconciliations.push(path));
      registry.subscribe('client-one', 'workspace-two', root, path => events.push(path), path => reconciliations.push(path));
      expect(registry.activeWatcherCount).toBe(2);
      callbacks[0]?.('change', 'people/object.yaml');
      callbacks[1]?.('change', 'tasks/object.yaml');
      registry.unsubscribeClient('client-one');
      expect(registry.activeWatcherCount).toBe(0);
      expect(closes).toEqual([1, 1]);
      await Bun.sleep(30);
      expect(events).toEqual([]);
      expect(reconciliations).toEqual([]);
    } finally {
      registry.closeAll();
      rmSync(root, { recursive: true, force: true });
    }
  });

  test('treats an unnamed filesystem event as a workspace-wide reconciliation', async () => {
    let callback: ((event: string, filename: string | null) => void) | undefined;
    const events: string[] = [];
    const reconciliations: string[] = [];
    const registry = new WorkspaceObjectWatcherRegistry({
      watch: (_path, listener) => { callback = listener; return { close: () => {} }; },
      debounceMs: 1,
    });

    registry.subscribe('client', 'workspace', '/tmp/workspace', path => events.push(path), path => reconciliations.push(path));
    callback?.('rename', null);
    await Bun.sleep(10);

    expect(events).toEqual([WORKSPACE_OBJECT_WATCH_ALL]);
    expect(reconciliations).toEqual([WORKSPACE_OBJECT_WATCH_ALL]);
    registry.closeAll();
  });

  test('contains watcher creation and asynchronous errors with workspace-wide recovery', () => {
    const creationEvents: string[] = [];
    const creationReconciliations: string[] = [];
    const creationFailure = new WorkspaceObjectWatcherRegistry({
      watch: () => { throw new Error('watch unavailable'); },
    });

    expect(() => creationFailure.subscribe(
      'client',
      'workspace',
      '/tmp/workspace',
      path => creationEvents.push(path),
      path => creationReconciliations.push(path),
    )).not.toThrow();
    expect(creationEvents).toEqual([WORKSPACE_OBJECT_WATCH_ALL]);
    expect(creationReconciliations).toEqual([WORKSPACE_OBJECT_WATCH_ALL]);
    expect(creationFailure.activeWatcherCount).toBe(0);

    let errorListener: ((error: Error) => void) | undefined;
    let closes = 0;
    const asyncEvents: string[] = [];
    const asyncReconciliations: string[] = [];
    const asyncFailure = new WorkspaceObjectWatcherRegistry({
      watch: () => ({
        close: () => { closes += 1; },
        on: (_event, listener) => { errorListener = listener; },
      }),
    });
    asyncFailure.subscribe(
      'client',
      'workspace',
      '/tmp/workspace',
      path => asyncEvents.push(path),
      path => asyncReconciliations.push(path),
    );

    expect(() => errorListener?.(new Error('watch failed'))).not.toThrow();
    expect(asyncEvents).toEqual([WORKSPACE_OBJECT_WATCH_ALL]);
    expect(asyncReconciliations).toEqual([WORKSPACE_OBJECT_WATCH_ALL]);
    expect(closes).toBe(1);
    expect(asyncFailure.activeWatcherCount).toBe(0);
  });
});
