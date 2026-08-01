import { afterEach, describe, expect, test } from 'bun:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { WorkspaceObjectRepository } from '../storage.ts';

const roots: string[] = [];

function makeRoot(): string {
  const root = mkdtempSync(join(tmpdir(), 'craft-objects-'));
  roots.push(root);
  return root;
}

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

describe('WorkspaceObjectRepository', () => {
  test('initializes idempotently and preserves typed fields and stable ids', () => {
    const root = makeRoot();
    const first = WorkspaceObjectRepository.open(root);
    first.close();
    const repository = WorkspaceObjectRepository.open(root);
    const companies = repository.defineObject({
      id: 'object_companies',
      slug: 'companies',
      name: 'Companies',
      fields: [{ id: 'field_company_name', name: 'Name', type: 'text', required: true }],
    });
    repository.upsertEntries(companies.id, [{
      id: 'entry_acme',
      values: { field_company_name: 'Acme' },
    }]);
    const people = repository.defineObject({
      id: 'object_people',
      slug: 'people',
      name: 'People',
      fields: [
        { id: 'field_name', name: 'Name', type: 'text', required: true },
        { id: 'field_score', name: 'Score', type: 'number' },
        { id: 'field_active', name: 'Active', type: 'boolean' },
        { id: 'field_birthday', name: 'Birthday', type: 'date' },
        { id: 'field_seen', name: 'Seen', type: 'datetime' },
        { id: 'field_stage', name: 'Stage', type: 'status', options: ['Lead', 'Won'] },
        { id: 'field_kind', name: 'Kind', type: 'select', options: ['Customer'] },
        { id: 'field_company', name: 'Company', type: 'relation', relationObjectId: companies.id },
        { id: 'field_file', name: 'File', type: 'file' },
      ],
    });
    repository.upsertEntries(people.id, [{
      id: 'entry_ada',
      values: {
        field_name: 'Ada', field_score: 9.5, field_active: true,
        field_birthday: '1815-12-10', field_seen: '2026-08-01T12:00:00.000Z',
        field_stage: 'Lead', field_kind: 'Customer', field_company: 'entry_acme',
        field_file: 'docs/ada.md',
      },
    }]);

    expect(repository.getObject(people.id)).toMatchObject({
      id: 'object_people', slug: 'people', revision: 2,
      entries: [{ id: 'entry_ada', values: { field_score: 9.5, field_active: true } }],
    });
    repository.close();
  });

  test('rolls back an invalid multi-entry mutation', () => {
    const repository = WorkspaceObjectRepository.open(makeRoot());
    const object = repository.defineObject({
      id: 'object_tasks', slug: 'tasks', name: 'Tasks',
      fields: [{ id: 'field_status', name: 'Status', type: 'select', options: ['Todo'] }],
    });
    expect(() => repository.upsertEntries(object.id, [
      { id: 'entry_valid', values: { field_status: 'Todo' } },
      { id: 'entry_invalid', values: { field_status: 'Missing' } },
    ])).toThrow('field_status');
    expect(repository.getObject(object.id)?.entries).toEqual([]);
    repository.close();
  });

  test('rejects databases from an unsupported future migration', () => {
    const root = makeRoot();
    const repository = WorkspaceObjectRepository.open(root);
    repository.setSchemaVersionForTest(999);
    repository.close();
    expect(() => WorkspaceObjectRepository.open(root)).toThrow('newer schema version');
  });

  test('rejects cross-object entry and view ownership collisions', () => {
    const repository = WorkspaceObjectRepository.open(makeRoot());
    for (const [id, slug] of [['object_a', 'a'], ['object_b', 'b']] as const) {
      repository.defineObject({ id, slug, name: id, fields: [{ id: `field_${slug}`, name: 'Name', type: 'text' }] });
    }
    repository.upsertEntries('object_a', [{ id: 'entry_shared', values: { field_a: 'A' } }]);
    expect(() => repository.upsertEntries('object_b', [{ id: 'entry_shared', values: { field_b: 'B' } }])).toThrow('another workspace object');
    repository.upsertSavedView('object_a', { id: 'view_shared', name: 'A', config: {} });
    expect(() => repository.upsertSavedView('object_b', { id: 'view_shared', name: 'B', config: {} })).toThrow('another workspace object');
    expect(repository.getObject('object_a')?.entries[0]?.values).toEqual({ field_a: 'A' });
    expect(repository.getObject('object_b')?.entries).toEqual([]);
    repository.close();
  });

  test('rejects impossible dates and non-ISO datetimes', () => {
    const repository = WorkspaceObjectRepository.open(makeRoot());
    repository.defineObject({
      id: 'object_dates', slug: 'dates', name: 'Dates',
      fields: [
        { id: 'field_date', name: 'Date', type: 'date' },
        { id: 'field_datetime', name: 'Datetime', type: 'datetime' },
      ],
    });
    expect(() => repository.upsertEntries('object_dates', [{ id: 'bad_date', values: { field_date: '2026-99-99' } }])).toThrow('valid YYYY-MM-DD');
    expect(() => repository.upsertEntries('object_dates', [{ id: 'bad_datetime', values: { field_datetime: 'August 1, 2026' } }])).toThrow('ISO datetime');
    repository.close();
  });
});
