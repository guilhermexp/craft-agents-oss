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
});
