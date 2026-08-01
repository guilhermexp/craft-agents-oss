import { describe, expect, test } from 'bun:test';
import type { WorkspaceObjectPayload } from '@craft-agent/shared/workspace-objects/types';
import { WorkspaceObjectListLoader, type WorkspaceObjectListLoadCallbacks } from '../workspace-objects-section.tsx';

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<T>((resolvePromise, rejectPromise) => {
    resolve = resolvePromise;
    reject = rejectPromise;
  });
  return { promise, resolve, reject };
}

function object(id: string, revision: number): WorkspaceObjectPayload {
  return { id, slug: id, name: id, revision, projectionStatus: 'ready', fields: [], entries: [], savedViews: [] };
}

function stateCallbacks(state: {
  objects: WorkspaceObjectPayload[];
  loading: boolean;
  error: Error | null;
  resets: number;
}): WorkspaceObjectListLoadCallbacks {
  return {
    onStart: () => { state.loading = true; state.error = null; },
    onSuccess: objects => { state.objects = objects; },
    onError: error => { state.error = error; },
    onFinish: () => { state.loading = false; },
    onReset: () => { state.objects = []; state.loading = false; state.error = null; state.resets += 1; },
  };
}

describe('WorkspaceObjectListLoader', () => {
  test('only the latest generation applies objects and loading state', async () => {
    const first = deferred<WorkspaceObjectPayload[]>();
    const second = deferred<WorkspaceObjectPayload[]>();
    let calls = 0;
    const loader = new WorkspaceObjectListLoader(async () => (++calls === 1 ? first.promise : second.promise));
    const state = { objects: [] as WorkspaceObjectPayload[], loading: false, error: null as Error | null, resets: 0 };
    const callbacks = stateCallbacks(state);

    const oldLoad = loader.load('workspace-one', callbacks);
    const newLoad = loader.load('workspace-one', callbacks);
    second.resolve([object('new', 2)]);
    await newLoad;
    expect(state).toMatchObject({ objects: [{ id: 'new', revision: 2 }], loading: false, error: null });

    first.resolve([object('old', 1)]);
    await oldLoad;
    expect(state).toMatchObject({ objects: [{ id: 'new', revision: 2 }], loading: false, error: null });
  });

  test('empty workspace resets state and invalidates an in-flight load', async () => {
    const pending = deferred<WorkspaceObjectPayload[]>();
    const loader = new WorkspaceObjectListLoader(async () => pending.promise);
    const state = { objects: [object('stale', 1)], loading: false, error: new Error('old') as Error | null, resets: 0 };
    const callbacks = stateCallbacks(state);

    const oldLoad = loader.load('workspace-one', callbacks);
    await loader.load(null, callbacks);
    expect(state).toEqual({ objects: [], loading: false, error: null, resets: 1 });

    pending.resolve([object('late', 2)]);
    await oldLoad;
    expect(state).toEqual({ objects: [], loading: false, error: null, resets: 1 });
  });

  test('catches rejection, preserves stale objects, exposes error, and allows retry', async () => {
    let calls = 0;
    const loader = new WorkspaceObjectListLoader(async () => {
      calls += 1;
      if (calls === 1) throw new Error('list unavailable');
      return [object('recovered', 3)];
    });
    const state = { objects: [object('stale', 2)], loading: false, error: null as Error | null, resets: 0 };
    const callbacks = stateCallbacks(state);

    await loader.load('workspace-one', callbacks);
    expect(state).toMatchObject({ objects: [{ id: 'stale' }], loading: false, error: { message: 'list unavailable' } });

    await loader.load('workspace-one', callbacks);
    expect(state).toMatchObject({ objects: [{ id: 'recovered', revision: 3 }], loading: false, error: null });
  });
});
