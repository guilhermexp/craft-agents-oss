import { afterEach, describe, expect, it } from 'bun:test';
import { getSessionToolProxyDefs } from './session-tool-defs.ts';

describe('getSessionToolProxyDefs', () => {
  afterEach(() => {
    delete process.env.CRAFT_FEATURE_MEMORY;
  });

  it('includes memory tools when the memory feature flag is enabled', () => {
    process.env.CRAFT_FEATURE_MEMORY = '1';

    const defs = getSessionToolProxyDefs();
    const names = defs.map(def => def.name);

    expect(names).toContain('mcp__session__memory_store');
    expect(names).toContain('mcp__session__memory_recall');
  });

  it('excludes memory tools when the memory feature flag is disabled', () => {
    process.env.CRAFT_FEATURE_MEMORY = '0';

    const defs = getSessionToolProxyDefs();
    const names = defs.map(def => def.name);

    expect(names).not.toContain('mcp__session__memory_store');
    expect(names).not.toContain('mcp__session__memory_recall');
  });

  it('passes Pi Anthropic and Copilot an object-only workspace tool envelope', () => {
    const workspaceObjects = getSessionToolProxyDefs().find(def => def.name === 'mcp__session__workspace_objects');
    const schema = workspaceObjects?.inputSchema as {
      type?: unknown;
      anyOf?: unknown;
      properties?: Record<string, unknown>;
      required?: unknown;
    } | undefined;

    expect(schema?.type).toBe('object');
    expect(schema?.anyOf).toBeUndefined();
    expect(schema?.required).toContain('action');
    expect(Object.keys(schema?.properties ?? {})).toEqual(expect.arrayContaining([
      'action', 'object', 'objectId', 'entries', 'entryIds', 'view', 'limit', 'after', 'includeEntryIds', 'query',
    ]));
    expect(schema?.properties?.action).toMatchObject({
      type: 'string',
      enum: expect.arrayContaining(['define-object', 'upsert-entries', 'query-object', 'list-relation-options']),
    });
    expect(schema?.properties?.object).toMatchObject({ type: 'object' });
    expect(schema?.properties?.entries).toMatchObject({ type: 'array' });
    expect(schema?.properties?.query).toMatchObject({ anyOf: expect.any(Array) });
  });
});
