import { afterEach, describe, expect, it } from 'bun:test';
import { getToolDefsAsJsonSchema } from '@craft-agent/session-tools-core';
import { getSessionToolProxyDefs } from './session-tool-defs.ts';

const PREFIX = 'mcp__session__';

// The Pi backend advertises the canonical catalog to its subprocess via
// getSessionToolProxyDefs(). This used to be checked only by name-set coverage,
// which could not have caught a hand-rolled description or a schema that dropped a
// field. Assert full catalog equality against the canonical JSON-schema catalog
// (modulo the mcp__session__ prefix Pi adds), in both directions.
describe('Pi backend session tool catalog equals the canonical catalog', () => {
  afterEach(() => {
    delete process.env.CRAFT_FEATURE_DEVELOPER_FEEDBACK;
    delete process.env.CRAFT_FEATURE_MEMORY;
  });

  it('exposes every canonical tool with identical description, schemas, and apiVersion', () => {
    process.env.CRAFT_FEATURE_DEVELOPER_FEEDBACK = '1';
    process.env.CRAFT_FEATURE_MEMORY = '1';

    const canonical = new Map(
      getToolDefsAsJsonSchema({ includeDeveloperFeedback: true, includeMemory: true, useNativeInputSchemas: true }).map((tool) => [tool.name, tool]),
    );
    const proxy = getSessionToolProxyDefs();

    // Both directions: identical tool set once the prefix is stripped.
    expect(proxy.map((def) => def.name).sort()).toEqual(
      [...canonical.keys()].map((name) => `${PREFIX}${name}`).sort(),
    );

    for (const def of proxy) {
      const name = def.name.startsWith(PREFIX) ? def.name.slice(PREFIX.length) : def.name;
      const canon = canonical.get(name);
      expect(canon).toBeDefined();
      expect(def.description).toBe(canon!.description);
      expect(def.inputSchema).toEqual(canon!.inputSchema);
      expect(def.outputSchema).toEqual(canon!.outputSchema);
      expect(def.apiVersion).toBe(canon!.apiVersion);
    }
  });

  it('drops feature-flagged tools from the proxy catalog when the flags are off', () => {
    process.env.CRAFT_FEATURE_DEVELOPER_FEEDBACK = '0';
    process.env.CRAFT_FEATURE_MEMORY = '0';

    const names = new Set(getSessionToolProxyDefs().map((def) => def.name));

    // Feature-gated tools must disappear from the proxy catalog when off — the
    // proxy is not a static list, it derives from the same feature filter as the
    // canonical catalog.
    expect(names.has(`${PREFIX}memory_store`)).toBe(false);
    expect(names.has(`${PREFIX}memory_recall`)).toBe(false);
    expect(names.has(`${PREFIX}send_developer_feedback`)).toBe(false);

    // A non-gated tool stays present (guards against an over-broad filter).
    expect(names.has(`${PREFIX}call_llm`)).toBe(true);
  });
});
