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

  test('drops the watcher on creation failure but re-arms it after an asynchronous error', async () => {
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
    let fsListener: ((event: string, filename: string | null) => void) | undefined;
    let closes = 0;
    let armCount = 0;
    const asyncEvents: string[] = [];
    const asyncReconciliations: string[] = [];
    const asyncFailure = new WorkspaceObjectWatcherRegistry({
      watch: (_path, listener) => {
        armCount += 1;
        fsListener = listener;
        return {
          close: () => { closes += 1; },
          on: (_event, onError) => { errorListener = onError; },
        };
      },
      debounceMs: 1,
    });
    asyncFailure.subscribe(
      'client',
      'workspace',
      '/tmp/workspace',
      path => asyncEvents.push(path),
      path => asyncReconciliations.push(path),
    );
    expect(armCount).toBe(1);

    expect(() => errorListener?.(new Error('watch failed'))).not.toThrow();
    // Recovery notifies once for the workspace and re-arms a fresh watcher.
    expect(asyncEvents).toEqual([WORKSPACE_OBJECT_WATCH_ALL]);
    expect(asyncReconciliations).toEqual([WORKSPACE_OBJECT_WATCH_ALL]);
    expect(closes).toBe(1);
    expect(armCount).toBe(2);
    expect(asyncFailure.activeWatcherCount).toBe(1);

    // The re-armed watcher keeps observing changes for the active subscriber.
    fsListener?.('change', 'people/object.yaml');
    await Bun.sleep(10);
    expect(asyncEvents).toEqual([WORKSPACE_OBJECT_WATCH_ALL, 'people/object.yaml']);
    expect(asyncReconciliations).toEqual([WORKSPACE_OBJECT_WATCH_ALL, 'people/object.yaml']);

    asyncFailure.closeAll();
  });

  test('re-arms across an error, then tears down after the last client unsubscribes', () => {
    let errorListener: ((error: Error) => void) | undefined;
    let closes = 0;
    let armCount = 0;
    const registry = new WorkspaceObjectWatcherRegistry({
      watch: () => {
        armCount += 1;
        return { close: () => { closes += 1; }, on: (_event, onError) => { errorListener = onError; } };
      },
    });
    registry.subscribe('c1', 'w1', '/tmp/workspace', () => {});
    registry.subscribe('c2', 'w1', '/tmp/workspace', () => {});
    expect(armCount).toBe(1);

    errorListener?.(new Error('watcher died'));
    expect(armCount).toBe(2);
    expect(closes).toBe(1);
    expect(registry.activeWatcherCount).toBe(1);

    registry.unsubscribe('c1', 'w1');
    expect(registry.activeWatcherCount).toBe(1);
    expect(closes).toBe(1);
    registry.unsubscribe('c2', 'w1');
    expect(registry.activeWatcherCount).toBe(0);
    expect(closes).toBe(2);
  });

  test('drops the workspace when a re-arm fails synchronously without looping', () => {
    let errorListener: ((error: Error) => void) | undefined;
    let armCount = 0;
    const events: string[] = [];
    const reconciliations: string[] = [];
    const registry = new WorkspaceObjectWatcherRegistry({
      watch: () => {
        armCount += 1;
        if (armCount >= 2) throw new Error('watch unavailable on re-arm');
        return { close: () => {}, on: (_event, onError) => { errorListener = onError; } };
      },
    });
    registry.subscribe('c1', 'w1', '/tmp/workspace', path => events.push(path), path => reconciliations.push(path));
    expect(registry.activeWatcherCount).toBe(1);

    expect(() => errorListener?.(new Error('watcher died'))).not.toThrow();
    // One recovery notification, one failed re-arm attempt, entry dropped.
    expect(armCount).toBe(2);
    expect(events).toEqual([WORKSPACE_OBJECT_WATCH_ALL]);
    expect(reconciliations).toEqual([WORKSPACE_OBJECT_WATCH_ALL]);
    expect(registry.activeWatcherCount).toBe(0);
  });

  test('ignores a stale error from a replaced handle after re-arm', async () => {
    interface FakeHandle { errorListener?: (error: Error) => void; fsListener: (event: string, filename: string | null) => void; closes: number }
    const handles: FakeHandle[] = [];
    const events: string[] = [];
    const registry = new WorkspaceObjectWatcherRegistry({
      watch: (_path, listener) => {
        const handle: FakeHandle = { fsListener: listener, closes: 0 };
        handles.push(handle);
        return {
          close: () => { handle.closes += 1; },
          on: (_event, onError) => { handle.errorListener = onError; },
        };
      },
      debounceMs: 1,
    });
    registry.subscribe('c1', 'w1', '/tmp/workspace', path => events.push(path));
    expect(handles).toHaveLength(1);

    // First handle dies and is replaced by a re-armed second handle.
    handles[0].errorListener?.(new Error('first watcher died'));
    expect(handles).toHaveLength(2);
    expect(registry.activeWatcherCount).toBe(1);
    expect(handles[1].closes).toBe(0);

    // A late duplicate error from the already-replaced first handle must not
    // close the live second handle or re-arm a third watcher.
    handles[0].errorListener?.(new Error('first watcher died again'));
    expect(handles).toHaveLength(2);
    expect(handles[1].closes).toBe(0);
    expect(registry.activeWatcherCount).toBe(1);

    // The live second handle keeps observing changes.
    handles[1].fsListener('change', 'people/object.yaml');
    await Bun.sleep(10);
    expect(events).toEqual([WORKSPACE_OBJECT_WATCH_ALL, 'people/object.yaml']);

    registry.closeAll();
  });

});
