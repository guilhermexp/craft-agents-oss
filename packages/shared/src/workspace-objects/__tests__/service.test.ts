import { afterEach, describe, expect, test } from 'bun:test';
import { existsSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { getWorkspaceObjectEventProjectionPath, readWorkspaceObjectEventProjection } from '../event-projection.ts';
import { WorkspaceObjectService } from '../service.ts';

const roots: string[] = [];
const makeRoot = () => { const root = mkdtempSync(join(tmpdir(), 'craft-object-service-')); roots.push(root); return root; };
afterEach(() => { for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }); });

describe('WorkspaceObjectService', () => {
  test('publishes one ready event after canonical commit and writes a matching manifest', () => {
    const root = makeRoot();
    const events: unknown[] = [];
    const service = WorkspaceObjectService.open({ workspaceId: 'ws_one', workspaceRootPath: root });
    service.events.subscribe(event => events.push(event));
    const result = service.execute({ action: 'define-object', object: {
      id: 'object_people', slug: 'people', name: 'People', fields: [],
    }});
    expect(result).toMatchObject({ objectId: 'object_people', revision: 1, projectionStatus: 'ready' });
    const manifest = readFileSync(join(root, 'objects', 'people', 'object.yaml'), 'utf8');
    expect(manifest).toContain('id: object_people');
    expect(manifest).toContain('revision: 1');
    expect(events).toEqual([{ workspaceId: 'ws_one', objectId: 'object_people', revision: 1, changeKind: 'defined', projectionStatus: 'ready' }]);
    service.close();
  });

  test('keeps canonical visibility and emits projection-error when manifest write fails', () => {
    const root = makeRoot();
    const events: unknown[] = [];
    const service = WorkspaceObjectService.open({
      workspaceId: 'ws_two', workspaceRootPath: root,
      writeManifest: () => { throw new Error('disk unavailable'); },
    });
    service.events.subscribe(event => events.push(event));
    const result = service.execute({ action: 'define-object', object: {
      id: 'object_tasks', slug: 'tasks', name: 'Tasks', fields: [],
    }});
    expect(result).toMatchObject({ revision: 1, projectionStatus: 'projection-error' });
    expect(service.execute({ action: 'get-object', objectId: 'object_tasks' })).toMatchObject({ payload: { id: 'object_tasks', revision: 1 } });
    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({ projectionStatus: 'projection-error' });
    const durableEventPath = getWorkspaceObjectEventProjectionPath(root, 'object_tasks');
    expect(readWorkspaceObjectEventProjection(durableEventPath)).toMatchObject({
      workspaceId: 'ws_two', objectId: 'object_tasks', revision: 1, projectionStatus: 'projection-error',
    });
    service.close();
  });

  test('reports projection-error without ambiguous rollback when durable event projection fails after commit', () => {
    const root = makeRoot();
    const events: unknown[] = [];
    const service = WorkspaceObjectService.open({
      workspaceId: 'ws_event_failure',
      workspaceRootPath: root,
      writeEventProjection: () => { throw new Error('event sidecar unavailable'); },
    });
    service.events.subscribe(event => events.push(event));

    expect(service.execute({ action: 'define-object', object: {
      id: 'object_committed', slug: 'committed', name: 'Committed', fields: [],
    } })).toEqual({ objectId: 'object_committed', revision: 1, projectionStatus: 'projection-error' });
    expect(service.execute({ action: 'get-object', objectId: 'object_committed' })).toMatchObject({
      payload: { id: 'object_committed', revision: 1, projectionStatus: 'projection-error' },
    });
    expect(events).toEqual([{
      workspaceId: 'ws_event_failure', objectId: 'object_committed', revision: 1,
      changeKind: 'defined', projectionStatus: 'projection-error',
    }]);
    service.close();
  });

  test('repairs a deleted manifest without changing revision and refuses identity or slug conflicts', () => {
    const root = makeRoot();
    const service = WorkspaceObjectService.open({ workspaceId: 'ws_three', workspaceRootPath: root });
    service.execute({ action: 'define-object', object: { id: 'object_notes', slug: 'notes', name: 'Notes', fields: [] } });
    const manifestPath = join(root, 'objects', 'notes', 'object.yaml');
    rmSync(manifestPath);
    expect(service.execute({ action: 'repair-projection', objectId: 'object_notes' })).toMatchObject({ revision: 1, projectionStatus: 'ready' });
    expect(existsSync(manifestPath)).toBe(true);
    const canonical = readFileSync(manifestPath, 'utf8');
    writeFileSync(manifestPath, canonical.replace('id: object_notes', 'id: object_other'));
    expect(() => service.execute({ action: 'repair-projection', objectId: 'object_notes' })).toThrow('identity conflict');

    writeFileSync(manifestPath, canonical.replace('slug: notes', 'slug: other-notes'));
    expect(() => service.execute({ action: 'repair-projection', objectId: 'object_notes' })).toThrow('slug conflict');
    expect(service.execute({ action: 'get-object', objectId: 'object_notes' })).toMatchObject({ payload: { id: 'object_notes' } });
    service.close();
  });

  test('supports generic entry removal and saved-view upsert through the same revision envelope', () => {
    const service = WorkspaceObjectService.open({ workspaceId: 'ws_four', workspaceRootPath: makeRoot() });
    service.execute({ action: 'define-object', object: {
      id: 'object_deals', slug: 'deals', name: 'Deals',
      fields: [{ id: 'field_name', name: 'Name', type: 'text' }],
    } });
    service.execute({ action: 'upsert-entries', objectId: 'object_deals', entries: [
      { id: 'entry_one', values: { field_name: 'One' } },
    ] });
    expect(() => service.execute({ action: 'upsert-view', objectId: 'object_deals', view: {
      id: 'view_loose', name: 'Loose', config: { search: 'One', columns: ['field_name'] },
    } } as never)).toThrow();
    expect(service.execute({ action: 'upsert-view', objectId: 'object_deals', view: {
      id: 'view_open', name: 'Open', config: {
        schemaVersion: 1, search: 'One', filter: null, sort: [], columnVisibility: { field_name: true },
        presentation: { adapter: 'table', settings: {} },
      },
    } })).toMatchObject({ objectId: 'object_deals', revision: 3, projectionStatus: 'ready' });
    expect(service.execute({ action: 'delete-entries', objectId: 'object_deals', entryIds: ['entry_one'] }))
      .toMatchObject({ revision: 4 });
    expect(service.execute({ action: 'get-object', objectId: 'object_deals' })).toMatchObject({
      payload: { entries: [], savedViews: [{ id: 'view_open', name: 'Open' }] },
    });
    service.close();
  });

  test('does not rewrite an already matching manifest during repair', () => {
    const root = makeRoot();
    const service = WorkspaceObjectService.open({ workspaceId: 'ws_five', workspaceRootPath: root });
    service.execute({ action: 'define-object', object: { id: 'object_loop', slug: 'loop', name: 'Loop', fields: [] } });
    const manifestPath = join(root, 'objects', 'loop', 'object.yaml');
    const before = statSync(manifestPath).mtimeMs;
    service.execute({ action: 'repair-projection', objectId: 'object_loop' });
    expect(statSync(manifestPath).mtimeMs).toBe(before);
    service.close();
  });

  test('returns the same deterministic query for an agent-saved view and an inline UI view', () => {
    const service = WorkspaceObjectService.open({ workspaceId: 'ws_query', workspaceRootPath: makeRoot() });
    service.execute({ action: 'define-object', object: {
      id: 'object_query', slug: 'query', name: 'Query',
      fields: [
        { id: 'field_name', name: 'Name', type: 'text' },
        { id: 'field_score', name: 'Score', type: 'number' },
      ],
    } });
    service.execute({ action: 'upsert-entries', objectId: 'object_query', entries: [
      { id: 'entry_a', values: { field_name: 'Alpha', field_score: 10 } },
      { id: 'entry_b', values: { field_name: 'Beta', field_score: 20 } },
    ] });
    const config = {
      schemaVersion: 1 as const,
      search: 'a',
      filter: { type: 'rule' as const, fieldId: 'field_score', operator: 'gte' as const, value: 10 },
      sort: [{ fieldId: 'field_score', direction: 'desc' as const }],
      columnVisibility: { field_score: false },
      presentation: { adapter: 'table' as const, settings: {} },
    };
    service.execute({ action: 'upsert-view', objectId: 'object_query', view: { id: 'view_agent', name: 'Agent', config } });

    const agent = service.execute({ action: 'query-object', objectId: 'object_query', query: { viewId: 'view_agent' } });
    const ui = service.execute({ action: 'query-object', objectId: 'object_query', query: { config } });

    expect(agent).toEqual(ui);
    expect(agent).toMatchObject({
      query: { objectId: 'object_query', fields: [{ id: 'field_name' }], entries: [{ id: 'entry_b' }, { id: 'entry_a' }] },
    });
    service.close();
  });

  test('queries relations by their current labels while returning the stored stable id', () => {
    const service = WorkspaceObjectService.open({ workspaceId: 'ws_relation_query', workspaceRootPath: makeRoot() });
    service.execute({ action: 'define-object', object: {
      id: 'object_companies', slug: 'companies', name: 'Companies',
      fields: [{ id: 'field_company_name', name: 'Name', type: 'text' }],
    } });
    service.execute({ action: 'upsert-entries', objectId: 'object_companies', entries: [
      { id: 'entry_acme', values: { field_company_name: 'Acme Renamed' } },
    ] });
    service.execute({ action: 'define-object', object: {
      id: 'object_people', slug: 'people', name: 'People',
      fields: [{ id: 'field_company', name: 'Company', type: 'relation', relationObjectId: 'object_companies' }],
    } });
    service.execute({ action: 'upsert-entries', objectId: 'object_people', entries: [
      { id: 'entry_ada', values: { field_company: 'entry_acme' } },
    ] });
    const config = {
      schemaVersion: 1 as const, search: 'renamed',
      filter: { type: 'rule' as const, fieldId: 'field_company', operator: 'contains' as const, value: 'acme' },
      sort: [{ fieldId: 'field_company', direction: 'asc' as const }], columnVisibility: {},
      presentation: { adapter: 'table' as const, settings: {} },
    };

    expect(service.execute({ action: 'query-object', objectId: 'object_people', query: { config } })).toMatchObject({
      query: {
        entries: [{ id: 'entry_ada', values: { field_company: 'entry_acme' } }],
        displayValues: { entry_ada: { field_company: 'Acme Renamed' } },
        relationLabels: { entry_acme: 'Acme Renamed' },
      },
    });
    service.close();
  });

  test('paginates relation options while including referenced stable ids beyond the page', () => {
    const service = WorkspaceObjectService.open({ workspaceId: 'ws_relation_options', workspaceRootPath: makeRoot() });
    service.execute({ action: 'define-object', object: {
      id: 'object_companies', slug: 'companies', name: 'Companies',
      fields: [{ id: 'field_name', name: 'Name', type: 'text' }],
    } });
    const entries = Array.from({ length: 250 }, (_, index) => ({
      id: `entry_${String(index).padStart(3, '0')}`,
      values: { field_name: `Company ${index}` },
    }));
    service.execute({ action: 'upsert-entries', objectId: 'object_companies', entries: entries.slice(0, 200) });
    service.execute({ action: 'upsert-entries', objectId: 'object_companies', entries: entries.slice(200) });

    const result = service.execute({
      action: 'list-relation-options', objectId: 'object_companies', limit: 10,
      after: 'entry_010', includeEntryIds: ['entry_249'],
    });
    expect('relationOptions' in result).toBe(true);
    if (!('relationOptions' in result)) throw new Error('Expected relation options result');
    expect(result.relationOptions).toContainEqual({ id: 'entry_249', label: 'Company 249' });
    expect(result.relationOptions).toHaveLength(11);
    expect(result.nextCursor).toBe('entry_020');
    service.close();
  });
});
