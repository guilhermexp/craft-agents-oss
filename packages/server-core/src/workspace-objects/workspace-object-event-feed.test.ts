import { describe, expect, test } from 'bun:test';
import type { WorkspaceObjectEvent } from '@craft-agent/shared/workspace-objects/types';
import { WorkspaceObjectEventFeed } from './workspace-object-event-feed.ts';
import { WORKSPACE_OBJECT_WATCH_ALL } from './workspace-object-watcher.ts';

type WatchListener = (event: string, filename: string | null) => void;

interface FakeWatch {
  path: string;
  listener: WatchListener;
  errorListener?: (error: Error) => void;
  closed: number;
}

const makeEvent = (overrides: Partial<WorkspaceObjectEvent> = {}): WorkspaceObjectEvent => ({
  workspaceId: 'w1', objectId: 'o1', revision: 2, changeKind: 'defined', projectionStatus: 'ready', ...overrides,
});

function harness() {
  const watches: FakeWatch[] = [];
  const reconciled: Array<{ workspaceId: string; changedPath: string }> = [];
  let durable: WorkspaceObjectEvent | null = null;
  const feed = new WorkspaceObjectEventFeed({
    debounceMs: 0,
    watch: (path: string, listener: WatchListener) => {
      const record: FakeWatch = { path, listener, closed: 0 };
      watches.push(record);
      return {
        close() { record.closed += 1; },
        on(event: 'error', errorListener: (error: Error) => void) {
          if (event === 'error') record.errorListener = errorListener;
        },
      };
    },
    readEventProjection: () => durable,
    reconcile: (workspaceId: string, _workspaceRootPath: string, changedPath: string) => {
      reconciled.push({ workspaceId, changedPath });
    },
  });
  return { feed, watches, reconciled, setDurable: (event: WorkspaceObjectEvent | null) => { durable = event; } };
}

describe('WorkspaceObjectEventFeed', () => {
  test('delivers a durable marker and its local echo exactly once per subscribed client', async () => {
    const { feed, watches, setDurable } = harness();
    const c1: WorkspaceObjectEvent[] = [];
    const c2: WorkspaceObjectEvent[] = [];
    const delivered1 = new Promise<void>(resolve => {
      feed.subscribe({ clientId: 'c1', workspaceId: 'w1', workspaceRootPath: '/tmp/w1', deliver: e => { c1.push(e); resolve(); }, reload: () => {} });
    });
    const delivered2 = new Promise<void>(resolve => {
      feed.subscribe({ clientId: 'c2', workspaceId: 'w1', workspaceRootPath: '/tmp/w1', deliver: e => { c2.push(e); resolve(); }, reload: () => {} });
    });
    expect(feed.activeWatcherCount).toBe(1);
    expect(watches).toHaveLength(1);

    const event = makeEvent();
    setDurable(event);
    watches[0].listener('change', '.events/o1.json');
    await Promise.all([delivered1, delivered2]);

    feed.publishLocal('w1', event);

    expect(c1).toEqual([event]);
    expect(c2).toEqual([event]);
  });

  test('delivers a same-revision projection-error followed by ready to a client', () => {
    const { feed } = harness();
    const received: WorkspaceObjectEvent[] = [];
    feed.subscribe({ clientId: 'c1', workspaceId: 'w1', workspaceRootPath: '/tmp/w1', deliver: e => received.push(e), reload: () => {} });

    feed.publishLocal('w1', makeEvent({ revision: 3, projectionStatus: 'projection-error' }));
    feed.publishLocal('w1', makeEvent({ revision: 3, projectionStatus: 'ready' }));

    expect(received).toEqual([
      makeEvent({ revision: 3, projectionStatus: 'projection-error' }),
      makeEvent({ revision: 3, projectionStatus: 'ready' }),
    ]);
  });

  test('ignores an older or exactly duplicated revision per client', () => {
    const { feed } = harness();
    const received: WorkspaceObjectEvent[] = [];
    feed.subscribe({ clientId: 'c1', workspaceId: 'w1', workspaceRootPath: '/tmp/w1', deliver: e => received.push(e), reload: () => {} });

    feed.publishLocal('w1', makeEvent({ revision: 5 }));
    feed.publishLocal('w1', makeEvent({ revision: 5 }));
    feed.publishLocal('w1', makeEvent({ revision: 4 }));

    expect(received).toEqual([makeEvent({ revision: 5 })]);
  });

  test('reloads every client and reconciles the workspace when the watcher recovers', () => {
    const { feed, watches, reconciled } = harness();
    let reload1 = 0;
    let reload2 = 0;
    const c1: WorkspaceObjectEvent[] = [];
    const c2: WorkspaceObjectEvent[] = [];
    feed.subscribe({ clientId: 'c1', workspaceId: 'w1', workspaceRootPath: '/tmp/w1', deliver: e => c1.push(e), reload: () => { reload1 += 1; } });
    feed.subscribe({ clientId: 'c2', workspaceId: 'w1', workspaceRootPath: '/tmp/w1', deliver: e => c2.push(e), reload: () => { reload2 += 1; } });

    watches[0].errorListener?.(new Error('watcher died'));

    expect(reload1).toBe(1);
    expect(reload2).toBe(1);
    expect(reconciled).toContainEqual({ workspaceId: 'w1', changedPath: WORKSPACE_OBJECT_WATCH_ALL });
    expect(watches[0].closed).toBeGreaterThanOrEqual(1);
    expect(c1).toEqual([]);
    expect(c2).toEqual([]);
  });

  test('keeps one watcher per workspace and closes it after the last client unsubscribes', () => {
    const { feed, watches } = harness();
    feed.subscribe({ clientId: 'c1', workspaceId: 'w1', workspaceRootPath: '/tmp/w1', deliver: () => {}, reload: () => {} });
    feed.subscribe({ clientId: 'c2', workspaceId: 'w1', workspaceRootPath: '/tmp/w1', deliver: () => {}, reload: () => {} });
    expect(feed.activeWatcherCount).toBe(1);

    feed.unsubscribe('c1', 'w1');
    expect(feed.activeWatcherCount).toBe(1);
    expect(watches[0].closed).toBe(0);

    feed.unsubscribe('c2', 'w1');
    expect(feed.activeWatcherCount).toBe(0);
    expect(watches[0].closed).toBe(1);
  });

  test('delivers to siblings when one client throws and retries the failed client', () => {
    const { feed } = harness();
    const boom: WorkspaceObjectEvent[] = [];
    const ok: WorkspaceObjectEvent[] = [];
    let failNext = true;
    feed.subscribe({
      clientId: 'boom', workspaceId: 'w1', workspaceRootPath: '/tmp/w1',
      deliver: e => { if (failNext) { failNext = false; throw new Error('client blew up'); } boom.push(e); },
      reload: () => {},
    });
    feed.subscribe({ clientId: 'ok', workspaceId: 'w1', workspaceRootPath: '/tmp/w1', deliver: e => ok.push(e), reload: () => {} });

    const event = makeEvent();
    feed.publishLocal('w1', event);
    // The throwing client does not block its sibling.
    expect(ok).toEqual([event]);
    expect(boom).toEqual([]);

    // The failed client is retried on the next publish (its revision was never
    // recorded), while the healthy client is not double-delivered.
    feed.publishLocal('w1', event);
    expect(boom).toEqual([event]);
    expect(ok).toEqual([event]);
  });

  test('delivers a durable event through a watcher re-armed after recovery', async () => {
    const { feed, watches, setDurable } = harness();
    const received: WorkspaceObjectEvent[] = [];
    let reloads = 0;
    feed.subscribe({ clientId: 'c1', workspaceId: 'w1', workspaceRootPath: '/tmp/w1', deliver: e => received.push(e), reload: () => { reloads += 1; } });
    expect(watches).toHaveLength(1);

    watches[0].errorListener?.(new Error('watcher died'));
    expect(reloads).toBe(1);
    // A fresh watcher was armed for the still-active subscriber.
    expect(watches).toHaveLength(2);
    expect(feed.activeWatcherCount).toBe(1);

    const event = makeEvent({ revision: 7 });
    setDurable(event);
    watches[1].listener('change', '.events/o1.json');
    await Bun.sleep(1);
    expect(received).toEqual([event]);
  });

});
