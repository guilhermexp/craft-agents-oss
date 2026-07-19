import { afterEach, beforeEach, describe, expect, it } from 'bun:test';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { loadChannelKanbanWatch, saveChannelKanbanWatch } from '../kanban-watches.ts';

let workspaceRoot: string;

beforeEach(() => {
  workspaceRoot = mkdtempSync(join(tmpdir(), 'channel-kanban-watches-test-'));
});

afterEach(() => {
  rmSync(workspaceRoot, { recursive: true, force: true });
});

describe('channel kanban watch list', () => {
  it('returns no watched tasks for a channel with no persisted watch list', () => {
    expect(loadChannelKanbanWatch(workspaceRoot, 'architecture')).toEqual([]);
  });

  it('persists and reads back watched task ids', () => {
    saveChannelKanbanWatch(workspaceRoot, 'architecture', ['task-1', 'task-2']);

    expect(loadChannelKanbanWatch(workspaceRoot, 'architecture')).toEqual(['task-1', 'task-2']);
  });

  it('overwrites the watch list when tasks leave the watch set', () => {
    saveChannelKanbanWatch(workspaceRoot, 'architecture', ['task-1', 'task-2']);
    saveChannelKanbanWatch(workspaceRoot, 'architecture', ['task-2']);

    expect(loadChannelKanbanWatch(workspaceRoot, 'architecture')).toEqual(['task-2']);
  });

  it('keeps watch lists from different channels isolated', () => {
    saveChannelKanbanWatch(workspaceRoot, 'architecture', ['task-1']);
    saveChannelKanbanWatch(workspaceRoot, 'product', ['task-2']);

    expect(loadChannelKanbanWatch(workspaceRoot, 'architecture')).toEqual(['task-1']);
    expect(loadChannelKanbanWatch(workspaceRoot, 'product')).toEqual(['task-2']);
  });

  it('tolerates a corrupt watch file and reports no watched tasks', () => {
    const dir = join(workspaceRoot, 'channels', 'watches');
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, `${encodeURIComponent('architecture')}.json`), '{not valid json', 'utf-8');

    expect(loadChannelKanbanWatch(workspaceRoot, 'architecture')).toEqual([]);
  });

  it('ignores a watch file whose channelId does not match', () => {
    const dir = join(workspaceRoot, 'channels', 'watches');
    mkdirSync(dir, { recursive: true });
    writeFileSync(
      join(dir, `${encodeURIComponent('architecture')}.json`),
      JSON.stringify({ channelId: 'other', taskIds: ['task-1'] }),
      'utf-8',
    );

    expect(loadChannelKanbanWatch(workspaceRoot, 'architecture')).toEqual([]);
  });
});
