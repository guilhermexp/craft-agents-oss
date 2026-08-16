import { afterEach, describe, expect, test } from 'bun:test';
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { WorkspaceObjectEvent } from '../types.ts';
import { executeWorkspaceObjectAction, repairWorkspaceObjectProjections } from '../service.ts';

const roots: string[] = [];
const makeRoot = () => { const root = mkdtempSync(join(tmpdir(), 'craft-object-lifecycle-')); roots.push(root); return root; };
afterEach(() => { for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }); });

describe('workspace object lifecycle runner', () => {
  test('commits a mutation and emits exactly one post-commit event', () => {
    const root = makeRoot();
    const events: WorkspaceObjectEvent[] = [];
    const result = executeWorkspaceObjectAction(
      { workspaceId: 'ws_lifecycle', workspaceRootPath: root },
      { action: 'define-object', object: { id: 'object_people', slug: 'people', name: 'People', fields: [] } },
      event => events.push(event),
    );

    expect(result).toEqual({ objectId: 'object_people', revision: 1, projectionStatus: 'ready' });
    expect(readFileSync(join(root, 'objects', 'people', 'object.yaml'), 'utf8')).toContain('id: object_people');
    expect(events).toEqual([{
      workspaceId: 'ws_lifecycle', objectId: 'object_people', revision: 1,
      changeKind: 'defined', projectionStatus: 'ready',
    }]);
  });

  test('opens, commits and closes each action so a follow-up mutation observes the prior revision', () => {
    const root = makeRoot();
    const options = { workspaceId: 'ws_seq', workspaceRootPath: root };
    executeWorkspaceObjectAction(options, {
      action: 'define-object', object: { id: 'object_people', slug: 'people', name: 'People', fields: [] },
    });

    const events: WorkspaceObjectEvent[] = [];
    const second = executeWorkspaceObjectAction(options, {
      action: 'upsert-entries', objectId: 'object_people', entries: [{ id: 'entry_one', values: {} }],
    }, event => events.push(event));

    expect(second).toEqual({ objectId: 'object_people', revision: 2, projectionStatus: 'ready' });
    expect(events).toEqual([{
      workspaceId: 'ws_seq', objectId: 'object_people', revision: 2,
      changeKind: 'entries-upserted', projectionStatus: 'ready',
    }]);
  });

  test('read actions run through the runner without forming a post-commit event', () => {
    const root = makeRoot();
    const options = { workspaceId: 'ws_read', workspaceRootPath: root };
    executeWorkspaceObjectAction(options, {
      action: 'define-object', object: { id: 'object_people', slug: 'people', name: 'People', fields: [] },
    });

    const events: WorkspaceObjectEvent[] = [];
    const read = executeWorkspaceObjectAction(options, { action: 'get-object', objectId: 'object_people' }, event => events.push(event));

    expect(read).toMatchObject({ payload: { id: 'object_people', revision: 1, projectionStatus: 'ready' } });
    expect(events).toEqual([]);
  });

  test('repair runner reconciles a dropped manifest and emits a repaired event without changing revision', () => {
    const root = makeRoot();
    const options = { workspaceId: 'ws_repair', workspaceRootPath: root };
    executeWorkspaceObjectAction(options, {
      action: 'define-object', object: { id: 'object_notes', slug: 'notes', name: 'Notes', fields: [] },
    });
    const manifestPath = join(root, 'objects', 'notes', 'object.yaml');
    rmSync(manifestPath);

    const events: WorkspaceObjectEvent[] = [];
    repairWorkspaceObjectProjections(options, undefined, event => events.push(event));

    expect(existsSync(manifestPath)).toBe(true);
    expect(events).toEqual([{
      workspaceId: 'ws_repair', objectId: 'object_notes', revision: 1,
      changeKind: 'projection-repaired', projectionStatus: 'ready',
    }]);
  });
});
