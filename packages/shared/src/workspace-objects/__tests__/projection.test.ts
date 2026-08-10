import { afterEach, describe, expect, test } from 'bun:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { openSQLite } from '../../memory/sqlite-driver.ts';
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

  test('rebuilds a structurally valid projection whose payload identity or revision is corrupt', () => {
    root = mkdtempSync(join(tmpdir(), 'craft-projection-corrupt-'));
    const repository = WorkspaceObjectRepository.open(root);
    const object = repository.defineObject({
      id: 'object_notes', slug: 'notes', name: 'Notes',
      fields: [{ id: 'field_title', name: 'Title', type: 'text' }],
    });
    repository.upsertEntries(object.id, [{ id: 'entry_one', values: { field_title: 'Canonical' } }]);
    repository.close();

    const db = openSQLite(join(root, 'objects', 'objects.sqlite'));
    const row = db.prepare('SELECT payload_json FROM workspace_object_payloads WHERE object_id = ?').get(object.id) as { payload_json: string };
    const corrupt = { ...JSON.parse(row.payload_json), id: 'object_other', revision: 99, entries: [{ id: 'entry_fake', values: { field_title: 'Corrupt' } }] };
    db.prepare('UPDATE workspace_object_payloads SET payload_json = ? WHERE object_id = ?').run(JSON.stringify(corrupt), object.id);
    db.close();

    const reopened = WorkspaceObjectRepository.open(root);
    expect(reopened.getObject(object.id)).toMatchObject({
      id: object.id,
      revision: 2,
      entries: [{ id: 'entry_one', values: { field_title: 'Canonical' } }],
    });
    reopened.close();
  });

  test('rebuilds a projection that is valid JSON but violates the payload schema', () => {
    root = mkdtempSync(join(tmpdir(), 'craft-projection-schema-'));
    const repository = WorkspaceObjectRepository.open(root);
    const object = repository.defineObject({ id: 'object_tasks', slug: 'tasks', name: 'Tasks', fields: [] });
    repository.close();

    const db = openSQLite(join(root, 'objects', 'objects.sqlite'));
    db.prepare('UPDATE workspace_object_payloads SET payload_json = ? WHERE object_id = ?')
      .run(JSON.stringify({ id: object.id, revision: 1, entries: 'not-an-array' }), object.id);
    db.close();

    const reopened = WorkspaceObjectRepository.open(root);
    expect(reopened.getObject(object.id)).toMatchObject({ id: object.id, revision: 1, entries: [] });
    reopened.close();
  });
});
