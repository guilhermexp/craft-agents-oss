import { describe, expect, test } from 'bun:test';
import { SESSION_TOOL_REGISTRY, WorkspaceObjectsSchema } from '../tool-defs.ts';

describe('workspace_objects frontier contract', () => {
  test('registers one strict generic v1 tool for native and MCP consumers', () => {
    const def = SESSION_TOOL_REGISTRY.get('workspace_objects');
    expect(def).toMatchObject({ apiVersion: 'v1', exposure: 'native-and-mcp', executionMode: 'registry' });
    expect(WorkspaceObjectsSchema.safeParse({ action: 'get-object', objectId: 'object_people' }).success).toBe(true);
    expect(WorkspaceObjectsSchema.safeParse({ action: 'get-object', objectId: 'object_people', sql: 'select *' }).success).toBe(false);
    expect(WorkspaceObjectsSchema.safeParse({
      action: 'upsert-entries', objectId: 'object_people',
      entries: [{ id: 'entry_too_large', values: { field_notes: 'x'.repeat(64_001) } }],
    }).success).toBe(false);
    expect(WorkspaceObjectsSchema.safeParse({ action: 'list-objects', limit: 20 }).success).toBe(true);
    expect(WorkspaceObjectsSchema.safeParse({ action: 'list-objects', objectId: 'cross-action' }).success).toBe(false);
    expect(WorkspaceObjectsSchema.safeParse({ action: 'get-object' }).success).toBe(false);
    expect(WorkspaceObjectsSchema.safeParse({ action: 'get-object', objectId: 'object_people', entries: [] }).success).toBe(false);
    expect(WorkspaceObjectsSchema.safeParse({ action: 'repair-projection' }).success).toBe(false);
    expect(WorkspaceObjectsSchema.safeParse({ action: 'define-object' }).success).toBe(false);
    expect(WorkspaceObjectsSchema.safeParse({
      action: 'define-object', objectId: 'cross-action',
      object: { id: 'object_people', slug: 'people', name: 'People', fields: [] },
    }).success).toBe(false);
    expect(WorkspaceObjectsSchema.safeParse({ action: 'upsert-entries', objectId: 'object_people' }).success).toBe(false);
    expect(WorkspaceObjectsSchema.safeParse({ action: 'delete-entries', objectId: 'object_people' }).success).toBe(false);
    expect(WorkspaceObjectsSchema.safeParse({ action: 'upsert-view', objectId: 'object_people' }).success).toBe(false);
    expect(WorkspaceObjectsSchema.safeParse({
      action: 'query-object', objectId: 'object_people', query: { viewId: 'view_active' },
    }).success).toBe(true);
    expect(WorkspaceObjectsSchema.safeParse({
      action: 'query-object', objectId: 'object_people', query: { viewId: 'view_active', config: {
        schemaVersion: 1, search: '', filter: null, sort: [], columnVisibility: {},
        presentation: { adapter: 'table', settings: {} },
      } },
    }).success).toBe(false);
    expect(WorkspaceObjectsSchema.safeParse({
      action: 'upsert-view', objectId: 'object_people', view: {
        id: 'view_future', name: 'Future', config: {
          schemaVersion: 2, search: '', filter: null, sort: [], columnVisibility: {},
          presentation: { adapter: 'table', settings: {} },
        },
      },
    }).success).toBe(false);
  });
});
