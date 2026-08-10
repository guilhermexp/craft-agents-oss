import { describe, expect, test } from 'bun:test';
import { bindWorkspaceObjectSubscription, onWorkspaceObjectsReload, requestWorkspaceObjectsReload } from '../workspace-object-reconnect.ts';

describe('workspace object reconnect reload', () => {
  test('notifies each mounted consumer exactly once for the active workspace', () => {
    const received: string[] = [];
    const unsubscribe = onWorkspaceObjectsReload(workspaceId => received.push(workspaceId));

    requestWorkspaceObjectsReload('workspace-one');
    expect(received).toEqual(['workspace-one']);

    unsubscribe();
    requestWorkspaceObjectsReload('workspace-one');
    expect(received).toEqual(['workspace-one']);
  });

  test('isolates reload listeners so one failure does not block the others', () => {
    const received: string[] = [];
    const stopFailing = onWorkspaceObjectsReload(() => { throw new Error('listener failed'); });
    const stopHealthy = onWorkspaceObjectsReload(workspaceId => received.push(workspaceId));

    expect(() => requestWorkspaceObjectsReload('workspace-one')).not.toThrow();
    expect(received).toEqual(['workspace-one']);
    stopFailing();
    stopHealthy();
  });

  test('reloads only after a successful resubscribe and contains async failures', async () => {
    let reconnect: (() => void) | undefined;
    let subscribeShouldFail = false;
    const errors: string[] = [];
    const reloads: string[] = [];
    const stopReload = onWorkspaceObjectsReload(id => reloads.push(id));
    const cleanup = bindWorkspaceObjectSubscription({
      subscribeWorkspaceObjects: async () => {
        if (subscribeShouldFail) throw new Error('subscribe failed');
      },
      unsubscribeWorkspaceObjects: async () => { throw new Error('unsubscribe failed'); },
      onReconnected: listener => { reconnect = listener; return () => { reconnect = undefined; }; },
    }, 'w1', error => errors.push(error.message));
    await Bun.sleep(0);

    reconnect?.();
    await Bun.sleep(0);
    expect(reloads).toEqual(['w1']);

    subscribeShouldFail = true;
    reconnect?.();
    await Bun.sleep(0);
    expect(reloads).toEqual(['w1']);
    expect(errors).toContain('subscribe failed');

    cleanup();
    await Bun.sleep(0);
    expect(errors).toContain('unsubscribe failed');
    expect(reconnect).toBeUndefined();
    stopReload();
  });

  test('waits for initial and reconnect subscriptions before unsubscribing', async () => {
    let reconnect: (() => void) | undefined;
    const calls: string[] = [];
    const resolvers: Array<() => void> = [];
    const cleanup = bindWorkspaceObjectSubscription({
      subscribeWorkspaceObjects: () => new Promise<void>(resolve => {
        calls.push('subscribe');
        resolvers.push(resolve);
      }),
      unsubscribeWorkspaceObjects: async () => { calls.push('unsubscribe'); },
      onReconnected: listener => { reconnect = listener; return () => { reconnect = undefined; }; },
    }, 'w1');
    await Bun.sleep(0);

    reconnect?.();
    cleanup();
    await Bun.sleep(0);
    expect(calls).toEqual(['subscribe']);

    resolvers.shift()?.();
    await Bun.sleep(0);
    expect(calls).toEqual(['subscribe', 'subscribe']);
    expect(reconnect).toBeUndefined();

    resolvers.shift()?.();
    await Bun.sleep(0);
    expect(calls).toEqual(['subscribe', 'subscribe', 'unsubscribe']);
  });
});
