import { describe, expect, test } from 'bun:test';
import { contentTabId, contentTabsReducer, restoreContentTabs, type ContentTabsState } from '../content-tabs-state.ts';

const empty: ContentTabsState = { tabs: [], activeId: null };
const file = (path: string, sessionId = 's1') => ({ kind: 'file' as const, workspaceId: 'w1', sessionId, path });
const object = (objectId: string, viewId?: string) => ({
  kind: 'object' as const,
  workspaceId: 'w1',
  objectId,
  ...(viewId !== undefined ? { viewId } : {}),
});

describe('content tabs state', () => {
  test('replaces only the scoped preview while permanent and pinned tabs survive', () => {
    let state = contentTabsReducer(empty, { type: 'open', target: file('one.md'), mode: 'preview' });
    state = contentTabsReducer(state, { type: 'promote', id: contentTabId(file('one.md')) });
    state = contentTabsReducer(state, { type: 'open', target: file('two.md'), mode: 'preview' });
    state = contentTabsReducer(state, { type: 'pin', id: contentTabId(file('two.md')) });
    state = contentTabsReducer(state, { type: 'open', target: file('three.md'), mode: 'preview' });
    state = contentTabsReducer(state, { type: 'open', target: file('four.md'), mode: 'preview' });
    expect(state.tabs.map(tab => tab.target.kind === 'file' ? tab.target.path : '')).toEqual(['one.md', 'two.md', 'four.md']);
    expect(state.activeId).toBe(contentTabId(file('four.md')));
  });

  test('upgrades an existing preview when it is reopened as permanent', () => {
    const preview = contentTabsReducer(empty, { type: 'open', target: object('object_people'), mode: 'preview' });
    const permanent = contentTabsReducer(preview, { type: 'open', target: object('object_people'), mode: 'permanent' });

    expect(permanent.tabs).toHaveLength(1);
    expect(permanent.tabs[0]).toMatchObject({ id: contentTabId(object('object_people')), mode: 'permanent', pinned: false });
    expect(permanent.activeId).toBe(contentTabId(object('object_people')));
  });

  test('repairs active selection and restores only the active workspace/session scope', () => {
    const serialized: ContentTabsState = {
      tabs: [
        { id: contentTabId(file('one.md')), target: file('one.md'), mode: 'permanent', pinned: false },
        { id: contentTabId(file('other.md', 's2')), target: file('other.md', 's2'), mode: 'permanent', pinned: false },
        { id: contentTabId(object('object_people')), target: object('object_people'), mode: 'permanent', pinned: false },
      ],
      activeId: 'missing',
    };
    const restored = restoreContentTabs(serialized, 'w1', 's1');
    expect(restored.tabs).toHaveLength(2);
    expect(restored.activeId).toBe(restored.tabs[0]?.id ?? null);
  });

  test('restores object tabs without a session and rejects malformed persisted state', () => {
    const serialized: ContentTabsState = {
      tabs: [
        { id: 'stale', target: object('object_people'), mode: 'permanent', pinned: false },
        { id: 'file', target: file('one.md'), mode: 'permanent', pinned: false },
      ],
      activeId: 'stale',
    };
    expect(restoreContentTabs(serialized, 'w1', null).tabs.map(tab => tab.target.kind)).toEqual(['object']);
    expect(restoreContentTabs({ tabs: [{ target: { kind: 'object', workspaceId: 12 } }] }, 'w1', null)).toEqual(empty);
    expect(restoreContentTabs(null, 'w1', null)).toEqual(empty);
  });

  test('skips a malformed persisted tab without discarding valid siblings', () => {
    const valid = { id: 'stale', target: object('object_people'), mode: 'permanent' as const, pinned: false };
    const restored = restoreContentTabs({ tabs: [{ target: null }, valid], activeId: 'stale' }, 'w1', null);
    expect(restored.tabs).toHaveLength(1);
    expect(restored.tabs[0]?.id).toBe(contentTabId(object('object_people')));
  });

  test('distinguishes an absent object view from an explicitly empty view and restores its presence', () => {
    const absentView = object('object_people');
    const emptyView = object('object_people', '');

    expect(contentTabId(absentView)).not.toBe(contentTabId(emptyView));

    const restored = restoreContentTabs({
      tabs: [{ id: 'legacy', target: emptyView, mode: 'permanent', pinned: false }],
      activeId: 'legacy',
    }, 'w1', null);
    expect(restored.tabs[0]?.target).toEqual(emptyView);
    expect(restored.activeId).toBe(contentTabId(emptyView));
  });

  test('keeps file preview scopes distinct when workspace and session ids contain colons', () => {
    const first = { kind: 'file' as const, workspaceId: 'workspace:one', sessionId: 'session', path: 'one.md' };
    const second = { kind: 'file' as const, workspaceId: 'workspace', sessionId: 'one:session', path: 'two.md' };

    const withFirst = contentTabsReducer(empty, { type: 'open', target: first, mode: 'preview' });
    const withSecond = contentTabsReducer(withFirst, { type: 'open', target: second, mode: 'preview' });

    expect(withSecond.tabs.map(tab => tab.id)).toEqual([contentTabId(first), contentTabId(second)]);
  });

  test('preserves relative traversal above the root without colliding with an in-root path', () => {
    expect(contentTabId(file('../outside.md'))).not.toBe(contentTabId(file('outside.md')));
    expect(contentTabId(file('folder/../../outside.md'))).toBe(contentTabId(file('../outside.md')));
  });

  test('deduplicates canonical ids on restore and maps a persisted active id to the canonical tab', () => {
    const canonical = file('one.md');
    const restored = restoreContentTabs({
      tabs: [
        { id: 'legacy-first', target: file('folder/../one.md'), mode: 'permanent', pinned: false },
        { id: 'legacy-active', target: canonical, mode: 'permanent', pinned: false },
      ],
      activeId: 'legacy-active',
    }, 'w1', 's1');

    expect(restored.tabs).toHaveLength(1);
    expect(restored.tabs[0]?.id).toBe(contentTabId(canonical));
    expect(restored.activeId).toBe(contentTabId(canonical));
  });

  test('prefers the legacy active-id alias when it collides with another new canonical id', () => {
    const noView = object('object_people');
    const namedAbsentView = object('object_people', 'absent');
    const restored = restoreContentTabs({
      tabs: [
        { id: 'object:w1:object_people:', target: noView, mode: 'permanent', pinned: false },
        { id: 'object:w1:object_people:absent', target: namedAbsentView, mode: 'permanent', pinned: false },
      ],
      activeId: 'object:w1:object_people:absent',
    }, 'w1', null);

    expect(restored.activeId).toBe(contentTabId(namedAbsentView));
  });

  test('retargets an object tab to its selected saved view so persistence survives restart', () => {
    const target = object('object_people');
    const opened = contentTabsReducer(empty, { type: 'open', target, mode: 'permanent' });
    const selected = object('object_people', 'view_active');
    const retargeted = contentTabsReducer(opened, { type: 'retarget', id: contentTabId(target), target: selected });

    expect(retargeted.activeId).toBe(contentTabId(selected));
    expect(retargeted.tabs[0]?.target).toEqual(selected);
    expect(restoreContentTabs(retargeted, 'w1', null)).toEqual(retargeted);
  });

  test('deduplicates when retargeting to a saved view that already has a tab', () => {
    const base = object('object_people');
    const saved = object('object_people', 'view_active');
    let state = contentTabsReducer(empty, { type: 'open', target: base, mode: 'permanent' });
    state = contentTabsReducer(state, { type: 'open', target: saved, mode: 'permanent' });
    state = contentTabsReducer(state, { type: 'retarget', id: contentTabId(base), target: saved });

    expect(state.tabs).toHaveLength(1);
    expect(state.tabs[0]?.id).toBe(contentTabId(saved));
    expect(state.activeId).toBe(contentTabId(saved));
  });

  test('retargets an unpinned preview into a new scope without duplicating its destination preview', () => {
    const source = file('source.md', 's1');
    const destinationPreview = file('old-preview.md', 's2');
    const destinationPermanent = file('permanent.md', 's2');
    const destinationPinned = file('pinned.md', 's2');
    const target = file('new-preview.md', 's2');
    const state: ContentTabsState = {
      tabs: [
        { id: contentTabId(source), target: source, mode: 'preview', pinned: false },
        { id: contentTabId(destinationPreview), target: destinationPreview, mode: 'preview', pinned: false },
        { id: contentTabId(destinationPermanent), target: destinationPermanent, mode: 'permanent', pinned: false },
        { id: contentTabId(destinationPinned), target: destinationPinned, mode: 'permanent', pinned: true },
      ],
      activeId: contentTabId(destinationPinned),
    };

    const retargeted = contentTabsReducer(state, { type: 'retarget', id: contentTabId(source), target });

    expect(retargeted.tabs.map(tab => tab.id)).toEqual([
      contentTabId(target),
      contentTabId(destinationPermanent),
      contentTabId(destinationPinned),
    ]);
    expect(retargeted.tabs.filter(tab => tab.mode === 'preview' && !tab.pinned)).toHaveLength(1);
    expect(retargeted.activeId).toBe(contentTabId(destinationPinned));
  });

  test('maps an active source preview to one cross-scope target while removing both old preview ids', () => {
    const source = file('source.md', 's1');
    const destinationPreview = file('old-preview.md', 's2');
    const target = file('new-preview.md', 's2');
    const state: ContentTabsState = {
      tabs: [
        { id: contentTabId(source), target: source, mode: 'preview', pinned: false },
        { id: contentTabId(destinationPreview), target: destinationPreview, mode: 'preview', pinned: false },
      ],
      activeId: contentTabId(source),
    };

    const retargeted = contentTabsReducer(state, { type: 'retarget', id: contentTabId(source), target });
    const ids = retargeted.tabs.map(tab => tab.id);

    expect(ids).not.toContain(contentTabId(source));
    expect(ids).not.toContain(contentTabId(destinationPreview));
    expect(ids.filter(id => id === contentTabId(target))).toHaveLength(1);
    expect(retargeted.activeId).toBe(contentTabId(target));
  });

  test('maps an active disposable destination preview to the cross-scope target', () => {
    const source = file('source.md', 's1');
    const destinationPreview = file('old-preview.md', 's2');
    const destinationPermanent = file('permanent.md', 's2');
    const destinationPinned = file('pinned.md', 's2');
    const target = file('new-preview.md', 's2');
    const state: ContentTabsState = {
      tabs: [
        { id: contentTabId(destinationPermanent), target: destinationPermanent, mode: 'permanent', pinned: false },
        { id: contentTabId(destinationPinned), target: destinationPinned, mode: 'permanent', pinned: true },
        { id: contentTabId(source), target: source, mode: 'preview', pinned: false },
        { id: contentTabId(destinationPreview), target: destinationPreview, mode: 'preview', pinned: false },
      ],
      activeId: contentTabId(destinationPreview),
    };

    const retargeted = contentTabsReducer(state, { type: 'retarget', id: contentTabId(source), target });

    expect(retargeted.activeId).toBe(contentTabId(target));
  });
});
