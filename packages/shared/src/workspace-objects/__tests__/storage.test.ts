import { afterEach, describe, expect, test } from 'bun:test';
import { mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { openSQLite } from '../../memory/sqlite-driver.ts';
import { WORKSPACE_OBJECT_SCHEMA_V1 } from '../schema.ts';
import { WorkspaceObjectRepository } from '../storage.ts';
import { DEFAULT_WORKSPACE_OBJECT_TABLE_VIEW, normalizeLegacyWorkspaceObjectSavedView } from '../view-schema.ts';

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
  test('normalizes every legacy record to a safe v1 fallback without throwing', () => {
    const oversizedId = 'x'.repeat(121);
    expect(() => normalizeLegacyWorkspaceObjectSavedView({
      id: 'view_legacy',
      name: 'Legacy',
      config: {
        schemaVersion: { arbitrary: true },
        search: 42,
        columns: ['', 'field_valid', oversizedId, 7, null],
        malformed: { nested: ['still', 'serializable'] },
      },
    })).not.toThrow();

    expect(normalizeLegacyWorkspaceObjectSavedView({
      id: 'view_legacy',
      name: 'Legacy',
      config: { schemaVersion: 'phase-a', columns: ['', 'field_valid', oversizedId] },
    }).config).toMatchObject({
      schemaVersion: 1,
      search: '',
      columnVisibility: { field_valid: true },
    });

    expect(() => normalizeLegacyWorkspaceObjectSavedView({
      id: 'view_non_serializable',
      name: 'Non serializable',
      config: { malformed: 1n },
    })).not.toThrow();
  });

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

  test('replays repository opens after a V1 upgrade without nullable or duplicate caller ids', () => {
    const root = makeRoot();
    const databasePath = join(root, 'objects', 'objects.sqlite');
    mkdirSync(join(root, 'objects'), { recursive: true });
    const v1 = openSQLite(databasePath);
    v1.pragma('foreign_keys = ON');
    v1.runSql(WORKSPACE_OBJECT_SCHEMA_V1);
    v1.close();

    const migrated = WorkspaceObjectRepository.open(root);
    migrated.defineObject({ id: 'object_people', slug: 'people', name: 'People', fields: [{ id: 'field_name', name: 'Name', type: 'text' }] });
    migrated.defineObject({ id: 'object_companies', slug: 'companies', name: 'Companies', fields: [{ id: 'field_name', name: 'Name', type: 'text' }] });
    migrated.close();

    WorkspaceObjectRepository.open(root).close();
    WorkspaceObjectRepository.open(root).close();

    const verification = openSQLite(databasePath);
    expect(verification.prepare('SELECT version FROM workspace_object_schema_version ORDER BY version').all()).toEqual([
      { version: 1 }, { version: 2 }, { version: 3 },
    ]);
    expect(verification.prepare(`SELECT object_id, caller_id FROM workspace_object_fields
      ORDER BY object_id`).all()).toEqual([
      { object_id: 'object_companies', caller_id: 'field_name' },
      { object_id: 'object_people', caller_id: 'field_name' },
    ]);
    expect(verification.prepare(`SELECT COUNT(*) AS count FROM workspace_object_fields
      WHERE caller_id IS NULL`).get()).toEqual({ count: 0 });
    verification.close();
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
    repository.upsertSavedView('object_a', { id: 'view_shared', name: 'A', config: DEFAULT_WORKSPACE_OBJECT_TABLE_VIEW });
    expect(() => repository.upsertSavedView('object_b', { id: 'view_shared', name: 'B', config: DEFAULT_WORKSPACE_OBJECT_TABLE_VIEW })).toThrow('another workspace object');
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

  test('allows the same caller-visible field id in different objects without mixing values', () => {
    const repository = WorkspaceObjectRepository.open(makeRoot());
    for (const [id, slug] of [['object_people', 'people'], ['object_companies', 'companies']] as const) {
      repository.defineObject({ id, slug, name: id, fields: [{ id: 'field_name', name: 'Name', type: 'text' }] });
    }
    repository.upsertEntries('object_people', [{ id: 'entry_person', values: { field_name: 'Ada' } }]);
    repository.upsertEntries('object_companies', [{ id: 'entry_company', values: { field_name: 'Analytical Engines' } }]);

    expect(repository.getObject('object_people')).toMatchObject({
      fields: [{ id: 'field_name' }], entries: [{ values: { field_name: 'Ada' } }],
    });
    expect(repository.getObject('object_companies')).toMatchObject({
      fields: [{ id: 'field_name' }], entries: [{ values: { field_name: 'Analytical Engines' } }],
    });
    repository.close();
  });

  test('clears relation values that point to a deleted entry', () => {
    const repository = WorkspaceObjectRepository.open(makeRoot());
    repository.defineObject({ id: 'object_companies', slug: 'companies', name: 'Companies', fields: [] });
    repository.upsertEntries('object_companies', [{ id: 'entry_acme', values: {} }]);
    repository.defineObject({
      id: 'object_people', slug: 'people', name: 'People',
      fields: [{ id: 'field_company', name: 'Company', type: 'relation', relationObjectId: 'object_companies' }],
    });
    repository.upsertEntries('object_people', [{ id: 'entry_ada', values: { field_company: 'entry_acme' } }]);

    repository.deleteEntries('object_companies', ['entry_acme']);
    repository.deleteProjectionForTest('object_people');
    expect(repository.getObject('object_people')).toMatchObject({
      entries: [{ id: 'entry_ada', values: { field_company: null } }],
    });
    repository.close();
  });

  test('does not clear relations when the requested entry belongs to another object', () => {
    const repository = WorkspaceObjectRepository.open(makeRoot());
    repository.defineObject({ id: 'object_companies', slug: 'companies', name: 'Companies', fields: [] });
    repository.upsertEntries('object_companies', [{ id: 'entry_acme', values: {} }]);
    repository.defineObject({
      id: 'object_people', slug: 'people', name: 'People',
      fields: [{ id: 'field_company', name: 'Company', type: 'relation', relationObjectId: 'object_companies' }],
    });
    repository.upsertEntries('object_people', [{ id: 'entry_ada', values: { field_company: 'entry_acme' } }]);

    repository.deleteEntries('object_people', ['entry_acme']);
    repository.deleteProjectionForTest('object_people');
    expect(repository.getObject('object_people')?.entries[0]?.values.field_company).toBe('entry_acme');
    repository.close();
  });

  test('skips corrupt saved-view JSON without hiding the canonical object', () => {
    const root = makeRoot();
    const repository = WorkspaceObjectRepository.open(root);
    repository.defineObject({ id: 'object_tasks', slug: 'tasks', name: 'Tasks', fields: [] });
    repository.upsertSavedView('object_tasks', { id: 'view_bad', name: 'Bad', config: DEFAULT_WORKSPACE_OBJECT_TABLE_VIEW });
    repository.close();

    const db = openSQLite(join(root, 'objects', 'objects.sqlite'));
    db.prepare('UPDATE workspace_object_saved_views SET config_json = ? WHERE id = ?').run('{bad json', 'view_bad');
    db.prepare('DELETE FROM workspace_object_payloads WHERE object_id = ?').run('object_tasks');
    db.close();

    const reopened = WorkspaceObjectRepository.open(root);
    expect(reopened.getObject('object_tasks')).toMatchObject({ id: 'object_tasks', savedViews: [] });
    reopened.close();
  });

  test('normalizes saved views persisted by the Phase A loose config contract when rebuilding projection', () => {
    const root = makeRoot();
    const repository = WorkspaceObjectRepository.open(root);
    repository.defineObject({ id: 'object_tasks', slug: 'tasks', name: 'Tasks', fields: [] });
    repository.upsertSavedView('object_tasks', { id: 'view_legacy', name: 'Legacy', config: DEFAULT_WORKSPACE_OBJECT_TABLE_VIEW });
    repository.close();

    const db = openSQLite(join(root, 'objects', 'objects.sqlite'));
    db.prepare('UPDATE workspace_object_saved_views SET config_json = ? WHERE id = ?')
      .run(JSON.stringify({ search: 'phase-a', columns: ['field_name'] }), 'view_legacy');
    db.prepare('DELETE FROM workspace_object_schema_version WHERE version > 2').run();
    db.prepare('DELETE FROM workspace_object_payloads WHERE object_id = ?').run('object_tasks');
    db.close();

    const reopened = WorkspaceObjectRepository.open(root);
    expect(reopened.getObject('object_tasks')?.savedViews[0]).toMatchObject({
      id: 'view_legacy',
      config: { schemaVersion: 1, search: 'phase-a', columnVisibility: { field_name: true } },
    });
    reopened.close();
  });

  test('transactionally rewrites arbitrary pre-v2 saved views to canonical schema v1 on reopen', () => {
    const root = makeRoot();
    const repository = WorkspaceObjectRepository.open(root);
    repository.defineObject({ id: 'object_tasks', slug: 'tasks', name: 'Tasks', fields: [] });
    repository.upsertSavedView('object_tasks', {
      id: 'view_seed', name: 'Seed',
      config: { schemaVersion: 1, search: '', filter: null, sort: [], columnVisibility: {}, presentation: { adapter: 'table', settings: {} } },
    });
    repository.close();
    const path = join(root, 'objects', 'objects.sqlite');
    const db = openSQLite(path);
    db.prepare('UPDATE workspace_object_saved_views SET config_json = ? WHERE id = ?')
      .run(JSON.stringify({ schemaVersion: 'phase-a-custom', search: 'legacy', columns: ['field_name'], custom: { keep: true } }), 'view_seed');
    db.prepare('DELETE FROM workspace_object_schema_version WHERE version > 2').run();
    db.close();

    const reopened = WorkspaceObjectRepository.open(root);
    expect(reopened.getObject('object_tasks')?.savedViews[0]?.config).toMatchObject({ schemaVersion: 1, search: 'legacy' });
    reopened.close();
    const persisted = openSQLite(path);
    const row = persisted.prepare('SELECT config_json FROM workspace_object_saved_views WHERE id = ?').get('view_seed') as { config_json: string };
    expect(JSON.parse(row.config_json)).toMatchObject({ schemaVersion: 1, search: 'legacy' });
    expect(persisted.prepare('SELECT MAX(version) AS version FROM workspace_object_schema_version').get()).toEqual({ version: 3 });
    persisted.close();
  });

  test('isolates malformed migration rows while reopening and normalizing valid legacy siblings', () => {
    const root = makeRoot();
    const repository = WorkspaceObjectRepository.open(root);
    repository.defineObject({ id: 'object_tasks', slug: 'tasks', name: 'Tasks', fields: [] });
    for (const [id, name] of [['view_legacy', 'Legacy'], ['view_malformed', 'Malformed']] as const) {
      repository.upsertSavedView('object_tasks', { id, name, config: DEFAULT_WORKSPACE_OBJECT_TABLE_VIEW });
    }
    repository.close();

    const path = join(root, 'objects', 'objects.sqlite');
    const db = openSQLite(path);
    db.prepare('UPDATE workspace_object_saved_views SET config_json = ? WHERE id = ?').run(
      JSON.stringify({ schemaVersion: 999, columns: ['', 'field_valid', 'x'.repeat(121)] }),
      'view_legacy',
    );
    db.prepare('UPDATE workspace_object_saved_views SET config_json = ? WHERE id = ?').run('{broken', 'view_malformed');
    db.prepare('DELETE FROM workspace_object_schema_version WHERE version > 2').run();
    db.close();

    const reopened = WorkspaceObjectRepository.open(root);
    expect(reopened.getObject('object_tasks')?.savedViews).toEqual([
      expect.objectContaining({
        id: 'view_legacy',
        config: expect.objectContaining({ schemaVersion: 1, columnVisibility: { field_valid: true } }),
      }),
      expect.objectContaining({
        id: 'view_malformed',
        config: DEFAULT_WORKSPACE_OBJECT_TABLE_VIEW,
      }),
    ]);
    reopened.close();

    const verification = openSQLite(path);
    expect(verification.prepare('SELECT MAX(version) AS version FROM workspace_object_schema_version').get()).toEqual({ version: 3 });
    verification.close();
  });

  test('keeps relation revision and option reads on one atomic snapshot while a writer commits', () => {
    const root = makeRoot();
    const repository = WorkspaceObjectRepository.open(root);
    repository.defineObject({
      id: 'object_companies', slug: 'companies', name: 'Companies',
      fields: [{ id: 'field_name', name: 'Name', type: 'text' }],
    });
    repository.upsertEntries('object_companies', [{ id: 'entry_acme', values: { field_name: 'Acme' } }]);
    const writer = openSQLite(join(root, 'objects', 'objects.sqlite'));
    writer.pragma('journal_mode = WAL');

    const observed = repository.withReadSnapshot(() => {
      const before = repository.listRelationOptions('object_companies', { limit: 10 });
      writer.prepare('UPDATE workspace_objects SET revision = revision + 1 WHERE id = ?').run('object_companies');
      const after = repository.listRelationOptions('object_companies', { limit: 10 });
      return { before, after };
    });

    expect(observed.before).toEqual(observed.after);
    expect(observed.before).toMatchObject({ revision: 2, options: [{ id: 'entry_acme', label: 'Acme' }] });
    expect(repository.listRelationOptions('object_companies', { limit: 10 }).revision).toBe(3);
    writer.close();
    repository.close();
  });

  test('supports nested projection transactions with savepoints', () => {
    const repository = WorkspaceObjectRepository.open(makeRoot());
    expect(() => repository.withProjectionLock(() => {
      repository.defineObject({ id: 'object_notes', slug: 'notes', name: 'Notes', fields: [] });
      repository.setProjectionStatus('object_notes', 'projection-error', 'nested');
    })).not.toThrow();
    expect(repository.getObject('object_notes')?.projectionStatus).toBe('projection-error');
    repository.close();
  });

  test('rolls back projection status when payload persistence fails', () => {
    const root = makeRoot();
    const repository = WorkspaceObjectRepository.open(root);
    repository.defineObject({ id: 'object_atomic', slug: 'atomic', name: 'Atomic', fields: [] });
    const db = openSQLite(join(root, 'objects', 'objects.sqlite'));
    db.runSql(`CREATE TRIGGER fail_payload_update BEFORE UPDATE ON workspace_object_payloads
      BEGIN SELECT RAISE(ABORT, 'payload write failed'); END;`);
    db.close();

    expect(() => repository.setProjectionStatus('object_atomic', 'projection-error', 'should rollback')).toThrow('payload write failed');
    const verificationDb = openSQLite(join(root, 'objects', 'objects.sqlite'));
    expect(verificationDb.prepare('SELECT status FROM workspace_object_projection_state WHERE object_id = ?')
      .get('object_atomic')).toEqual({ status: 'ready' });
    verificationDb.close();
    repository.close();
  });
});
