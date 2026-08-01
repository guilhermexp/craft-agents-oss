import { describe, expect, test } from 'bun:test';
import { contentTabId, contentTabsReducer, restoreContentTabs, type ContentTabsState } from '../content-tabs-state.ts';

const empty: ContentTabsState = { tabs: [], activeId: null };
const file = (path: string, sessionId = 's1') => ({ kind: 'file' as const, workspaceId: 'w1', sessionId, path });
const object = (objectId: string) => ({ kind: 'object' as const, workspaceId: 'w1', objectId });

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
});
