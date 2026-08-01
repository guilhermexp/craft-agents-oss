import { afterEach, describe, expect, test } from 'bun:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { WorkspaceObjectRepository } from '../storage.ts';

let root = '';
afterEach(() => { if (root) rmSync(root, { recursive: true, force: true }); root = ''; });

describe('workspace object read projection', () => {
  test('rebuilds a missing or stale payload from normalized rows', () => {
    root = mkdtempSync(join(tmpdir(), 'craft-projection-'));
    const repository = WorkspaceObjectRepository.open(root);
    const object = repository.defineObject({
      id: 'object_notes', slug: 'notes', name: 'Notes',
      fields: [{ id: 'field_title', name: 'Title', type: 'text' }],
    });
    repository.upsertEntries(object.id, [{ id: 'entry_one', values: { field_title: 'One' } }]);
    repository.deleteProjectionForTest(object.id);

    const rebuilt = repository.getObject(object.id);
    expect(rebuilt).toMatchObject({ revision: 2, entries: [{ values: { field_title: 'One' } }] });
    expect(repository.hasFreshProjectionForTest(object.id)).toBe(true);

    repository.markProjectionStaleForTest(object.id);
    expect(repository.getObject(object.id)?.revision).toBe(2);
    expect(repository.hasFreshProjectionForTest(object.id)).toBe(true);
    repository.close();
  });
});
