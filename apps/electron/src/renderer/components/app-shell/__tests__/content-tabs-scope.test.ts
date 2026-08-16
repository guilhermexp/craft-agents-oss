import { describe, expect, test } from 'bun:test';
import { contentTabId, type ContentTab, type ContentTabsState, type ContentTarget } from '../content-tabs-state.ts';
import { readScopedContentTabs, serializeScopedContentTabs, type ContentTabsScope } from '../content-tabs-scope.ts';

const fileTarget = (path: string, sessionId = 's1', workspaceId = 'w1'): ContentTarget => ({
  kind: 'file',
  workspaceId,
  sessionId,
  path,
});
const objectTarget = (objectId: string, viewId?: string, workspaceId = 'w1'): ContentTarget => ({
  kind: 'object',
  workspaceId,
  objectId,
  ...(viewId !== undefined ? { viewId } : {}),
});
const browserTarget = (instanceId: string, workspaceId = 'w1'): ContentTarget => ({
  kind: 'browser',
  workspaceId,
  instanceId,
});

const tab = (
  target: ContentTarget,
  mode: 'preview' | 'permanent' = 'permanent',
  pinned = false,
): ContentTab => ({ id: contentTabId(target), target, mode, pinned });

const bucket = (tabs: ContentTab[], activeId: string | null = null): ContentTabsState => ({ tabs, activeId });

const scope = (sessionId: string | null = 's1', workspaceId = 'w1'): ContentTabsScope => ({ workspaceId, sessionId });

describe('content tabs scope', () => {
  test('merges object and file buckets, objects first, with file-active precedence', () => {
    const objTab = tab(objectTarget('doc'));
    const fileTab = tab(fileTarget('src/a.ts'));
    const state = readScopedContentTabs(scope(), {
      object: bucket([objTab], objTab.id),
      file: bucket([fileTab], fileTab.id),
    });
    expect(state.tabs.map(t => t.id)).toEqual([objTab.id, fileTab.id]);
    // Both buckets carry an active tab; the file bucket's selection wins.
    expect(state.activeId).toBe(fileTab.id);
  });

  test('falls back to the object bucket active when the file bucket has no selection', () => {
    const objTab = tab(objectTarget('doc'));
    const state = readScopedContentTabs(scope(), {
      object: bucket([objTab], objTab.id),
      file: bucket([]),
    });
    expect(state.activeId).toBe(objTab.id);
  });

  test('serializes only targets belonging to the current scope', () => {
    const state = bucket([
      tab(objectTarget('doc')),
      tab(fileTarget('src/a.ts')),
      tab(fileTarget('src/a.ts', 's2')), // foreign session
      tab(objectTarget('doc2', undefined, 'w2')), // foreign workspace
    ]);
    const { object, file } = serializeScopedContentTabs(scope('s1'), state);
    expect(object.tabs.map(t => t.id)).toEqual([tab(objectTarget('doc')).id]);
    expect(file?.tabs.map(t => t.id)).toEqual([tab(fileTarget('src/a.ts')).id]);
  });

  test('never serializes browser targets and never claims an unpersistable active', () => {
    const browser = tab(browserTarget('b1'));
    const state = bucket([tab(objectTarget('doc')), browser, tab(fileTarget('src/a.ts'))], browser.id);
    const { object, file } = serializeScopedContentTabs(scope('s1'), state);
    const persistedIds = [...object.tabs, ...(file?.tabs ?? [])].map(t => t.id);
    expect(persistedIds).not.toContain(browser.id);
    expect(object.tabs.every(t => t.target.kind === 'object')).toBe(true);
    expect(file?.tabs.every(t => t.target.kind === 'file')).toBe(true);
    // The active tab was the live browser, which no bucket may persist.
    expect(object.activeId).toBeNull();
    expect(file?.activeId).toBeNull();
  });

  test('routes the active selection to the single bucket that owns it', () => {
    const fileTab = tab(fileTarget('src/a.ts'));
    const state = bucket([tab(objectTarget('doc')), fileTab], fileTab.id);
    const { object, file } = serializeScopedContentTabs(scope('s1'), state);
    expect(object.activeId).toBeNull();
    expect(file?.activeId).toBe(fileTab.id);
  });

  test('omits the file bucket when the scope has no session', () => {
    const { object, file } = serializeScopedContentTabs(
      scope(null),
      bucket([tab(objectTarget('doc')), tab(fileTarget('src/a.ts'))]),
    );
    expect(file).toBeNull();
    expect(object.tabs.map(t => t.id)).toEqual([tab(objectTarget('doc')).id]);
  });

  test('drops file targets when reading a scope that has no session', () => {
    const fileTab = tab(fileTarget('src/a.ts'));
    const state = readScopedContentTabs(scope(null), {
      object: bucket([tab(objectTarget('doc'))]),
      file: bucket([fileTab], fileTab.id),
    });
    expect(state.tabs.map(t => t.target.kind)).toEqual(['object']);
  });

  test('a bucket restored for one scope cannot leak into another scope', () => {
    const foreignFile = tab(fileTarget('src/a.ts', 's2'));
    const state = readScopedContentTabs(scope('s1'), {
      object: bucket([]),
      file: bucket([foreignFile], foreignFile.id),
    });
    expect(state.tabs).toEqual([]);
    expect(state.activeId).toBeNull();
  });

  test('a scoped serialize round-tripped into a different scope restores nothing', () => {
    const fileTab = tab(fileTarget('src/a.ts', 's1'));
    const { file: fileBucketS1 } = serializeScopedContentTabs(scope('s1'), bucket([fileTab], fileTab.id));
    const restoredIntoS2 = readScopedContentTabs(scope('s2'), {
      object: bucket([]),
      file: fileBucketS1,
    });
    expect(restoredIntoS2.tabs).toEqual([]);
  });

  test('corrupt storage input falls back to an empty scoped state', () => {
    const corruptInputs: unknown[] = [
      null,
      undefined,
      42,
      'nope',
      {},
      { tabs: 'no' },
      { tabs: [null, 7, { mode: 'x' }] },
    ];
    for (const corrupt of corruptInputs) {
      const state = readScopedContentTabs(scope('s1'), { object: corrupt, file: corrupt });
      expect(state).toEqual({ tabs: [], activeId: null });
    }
  });
});
