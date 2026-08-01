import { describe, expect, test } from 'bun:test';
import { SESSION_TOOL_REGISTRY, WorkspaceObjectsSchema } from '../tool-defs.ts';

describe('workspace_objects frontier contract', () => {
  test('registers one strict generic v1 tool for native and MCP consumers', () => {
    const def = SESSION_TOOL_REGISTRY.get('workspace_objects');
    expect(def).toMatchObject({ apiVersion: 'v1', exposure: 'native-and-mcp', executionMode: 'registry' });
    expect(WorkspaceObjectsSchema.safeParse({ action: 'get-object', objectId: 'object_people' }).success).toBe(true);
    expect(WorkspaceObjectsSchema.safeParse({ action: 'get-object', objectId: 'object_people', sql: 'select *' }).success).toBe(false);
  });
});
