import { describe, expect, test } from 'bun:test';
import {
  contentTabId,
  contentTabsReducer,
  type ContentTab,
  type ContentTabsState,
  type ContentTarget,
} from '../content-tabs-state.ts';
import { type ContentTabsScope } from '../content-tabs-scope.ts';
import { blockedFromReads, planPersist } from '../content-tabs-persistence.ts';

const fileTarget = (path: string, sessionId = 's1', workspaceId = 'w1'): ContentTarget => ({
  kind: 'file',
  workspaceId,
  sessionId,
  path,
});
const objectTarget = (objectId: string, workspaceId = 'w1'): ContentTarget => ({
  kind: 'object',
  workspaceId,
  objectId,
});
const browserTarget = (instanceId: string, workspaceId = 'w1'): ContentTarget => ({
  kind: 'browser',
  workspaceId,
  instanceId,
});

const tab = (target: ContentTarget): ContentTab => ({
  id: contentTabId(target),
  target,
  mode: 'permanent',
  pinned: false,
});

const state = (tabs: ContentTab[], activeId: string | null = null): ContentTabsState => ({ tabs, activeId });
const scope = (sessionId: string | null = 's1', workspaceId = 'w1'): ContentTabsScope => ({ workspaceId, sessionId });

const UNBLOCKED = { object: false, file: false };

describe('content tabs persistence policy', () => {
  test('a bucket blocks only when its read actually failed', () => {
    expect(blockedFromReads('ok', 'ok')).toEqual({ object: false, file: false });
    expect(blockedFromReads('failed', 'ok')).toEqual({ object: true, file: false });
    expect(blockedFromReads('ok', 'failed')).toEqual({ object: false, file: true });
    // A scope with no file bucket never blocks the file side.
    expect(blockedFromReads('failed', null)).toEqual({ object: true, file: false });
  });

  test('plans only the buckets that belong to the scope that produced the state', () => {
    const mixed = state([
      tab(objectTarget('doc')),
      tab(fileTarget('src/a.ts')),
      tab(fileTarget('src/a.ts', 's2')), // foreign session
      tab(objectTarget('doc2', 'w2')), // foreign workspace
    ]);
    const plan = planPersist(scope('s1'), mixed, UNBLOCKED);
    expect(plan.object?.tabs.map(t => t.id)).toEqual([tab(objectTarget('doc')).id]);
    expect(plan.file?.tabs.map(t => t.id)).toEqual([tab(fileTarget('src/a.ts')).id]);
  });

  test('a blocked object read suppresses only the object bucket write', () => {
    const live = state([tab(objectTarget('doc')), tab(fileTarget('src/a.ts'))]);
    const plan = planPersist(scope('s1'), live, { object: true, file: false });
    expect(plan.object).toBeNull();
    expect(plan.file?.tabs.map(t => t.id)).toEqual([tab(fileTarget('src/a.ts')).id]);
  });

  test('a blocked file read suppresses only the file bucket write', () => {
    const live = state([tab(objectTarget('doc')), tab(fileTarget('src/a.ts'))]);
    const plan = planPersist(scope('s1'), live, { object: false, file: true });
    expect(plan.file).toBeNull();
    expect(plan.object?.tabs.map(t => t.id)).toEqual([tab(objectTarget('doc')).id]);
  });

  test('a scope with no session never plans a file bucket', () => {
    const plan = planPersist(scope(null), state([tab(objectTarget('doc')), tab(fileTarget('src/a.ts'))]), UNBLOCKED);
    expect(plan.file).toBeNull();
    expect(plan.object?.tabs.map(t => t.id)).toEqual([tab(objectTarget('doc')).id]);
  });

  test('browser tabs never reach a plan', () => {
    const browser = tab(browserTarget('b1'));
    const plan = planPersist(scope('s1'), state([tab(objectTarget('doc')), browser], browser.id), UNBLOCKED);
    const planned = [...(plan.object?.tabs ?? []), ...(plan.file?.tabs ?? [])];
    expect(planned.map(t => t.id)).not.toContain(browser.id);
    // The active tab was the live browser, which no bucket may claim.
    expect(plan.object?.activeId).toBeNull();
    expect(plan.file?.activeId).toBeNull();
  });

  test('a mutation is planned under the scope that produced it, not a later scope', () => {
    // Model the hook's wrapped dispatch: reduce the action against the on-screen
    // state, then plan the result under the on-screen scope. A close in scope A
    // must land in A's buckets even if the caller is about to switch to B.
    const a = scope('sA');
    const before = state([tab(fileTarget('src/a.ts', 'sA')), tab(fileTarget('src/b.ts', 'sA'))]);
    const next = contentTabsReducer(before, { type: 'close', id: tab(fileTarget('src/a.ts', 'sA')).id });
    const plan = planPersist(a, next, UNBLOCKED);
    expect(plan.file?.tabs.map(t => t.id)).toEqual([tab(fileTarget('src/b.ts', 'sA')).id]);
    // Planning the same outgoing state against the incoming scope B writes an
    // empty file bucket for B — never A's surviving tab — so nothing leaks.
    const b = scope('sB');
    const leaked = planPersist(b, next, UNBLOCKED);
    expect(leaked.file?.tabs).toEqual([]);
  });
});
