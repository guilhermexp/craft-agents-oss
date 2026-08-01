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
