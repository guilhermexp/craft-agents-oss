import { describe, it, expect } from 'bun:test';
import {
  SESSION_TOOL_DEFS,
  getSessionToolDefs,
  getSessionToolNames,
  getSessionToolRegistry,
  getSessionSafeAllowedToolNames,
  getSessionSafeBlockedToolNames,
  getToolDefsAsJsonSchema,
  validateSessionToolInput,
  validateSessionToolOutput,
} from './tool-defs.ts';

describe('session tool filtering helpers', () => {
  it('excludes developer feedback tool when includeDeveloperFeedback is false', () => {
    const defs = getSessionToolDefs({ includeDeveloperFeedback: false });
    const names = defs.map(d => d.name);

    expect(names.includes('send_developer_feedback')).toBe(false);
  });

  it('includes developer feedback tool when includeDeveloperFeedback is true', () => {
    const defs = getSessionToolDefs({ includeDeveloperFeedback: true });
    const names = defs.map(d => d.name);

    expect(names.includes('send_developer_feedback')).toBe(true);
  });

  it('name set and registry stay aligned for filtered output', () => {
    const names = getSessionToolNames({ includeDeveloperFeedback: false });
    const registry = getSessionToolRegistry({ includeDeveloperFeedback: false });

    expect(registry.has('send_developer_feedback')).toBe(false);
    expect(names.has('send_developer_feedback')).toBe(false);

    for (const name of names) {
      expect(registry.has(name)).toBe(true);
    }
  });

  it('json schema conversion respects includeDeveloperFeedback filter', () => {
    const defs = getToolDefsAsJsonSchema({ includeDeveloperFeedback: false });
    const names = defs.map(d => d.name);

    expect(names.includes('send_developer_feedback')).toBe(false);
  });

  it('excludes memory tools when includeMemory is false', () => {
    const defs = getSessionToolDefs({ includeMemory: false });
    const names = defs.map(d => d.name);

    expect(names.includes('memory_store')).toBe(false);
    expect(names.includes('memory_recall')).toBe(false);
  });

  it('includes memory tools when includeMemory is true', () => {
    const defs = getSessionToolDefs({ includeMemory: true });
    const names = defs.map(d => d.name);

    expect(names.includes('memory_store')).toBe(true);
    expect(names.includes('memory_recall')).toBe(true);
  });

  it('json schema conversion respects includeMemory filter', () => {
    const defs = getToolDefsAsJsonSchema({ includeMemory: true });
    const names = defs.map(d => d.name);

    expect(names.includes('memory_store')).toBe(true);
    expect(names.includes('memory_recall')).toBe(true);
  });

  it('all canonical session tools declare safeMode metadata', () => {
    for (const def of SESSION_TOOL_DEFS) {
      expect(def.safeMode === 'allow' || def.safeMode === 'block').toBe(true);
    }
  });

  it('all canonical session tools declare the v1 frontier contract', () => {
    for (const def of SESSION_TOOL_DEFS) {
      expect(def.apiVersion).toBe('v1');
      expect(def.exposure).toBe('native-and-mcp');
      expect(def.inputSchema).toBeDefined();
      expect(def.outputSchema).toBeDefined();
    }
  });

  it('json schema conversion includes versioned input and output schemas', () => {
    const defs = getToolDefsAsJsonSchema({ includeMemory: true });
    const configValidate = defs.find(def => def.name === 'config_validate');

    expect(configValidate?.apiVersion).toBe('v1');
    expect(configValidate?.inputSchema.type).toBe('object');
    expect(configValidate?.outputSchema.type).toBe('object');
    expect(configValidate?.exposure).toBe('native-and-mcp');
  });

  it('validates inputs and outputs through the canonical schemas', () => {
    const def = SESSION_TOOL_DEFS.find(tool => tool.name === 'config_validate');
    expect(def).toBeDefined();
    if (!def) return;

    expect(validateSessionToolInput(def, { target: 'config' })).toEqual({ target: 'config' });
    expect(() => validateSessionToolInput(def, { target: 'unknown' })).toThrow();
    expect(validateSessionToolOutput(def, { content: [{ type: 'text', text: 'ok' }] })).toEqual({
      content: [{ type: 'text', text: 'ok' }],
    });
    expect(() => validateSessionToolOutput(def, { content: [{ type: 'text' }] })).toThrow();
  });

  it('safe-mode helper sets classify expected tools', () => {
    const allowed = getSessionSafeAllowedToolNames();
    const blocked = getSessionSafeBlockedToolNames();

    expect(allowed.has('send_developer_feedback')).toBe(true);
    expect(allowed.has('call_llm')).toBe(true);
    expect(allowed.has('browser_tool')).toBe(true);
    expect(allowed.has('script_sandbox')).toBe(true);

    expect(blocked.has('source_oauth_trigger')).toBe(true);
    expect(blocked.has('source_credential_prompt')).toBe(true);
    expect(blocked.has('spawn_session')).toBe(true);
  });

  it('safe-mode helpers support MCP prefixing', () => {
    const allowedPrefixed = getSessionSafeAllowedToolNames({ prefix: 'mcp__session__' });
    const blockedPrefixed = getSessionSafeBlockedToolNames({ prefix: 'mcp__session__' });

    expect(allowedPrefixed.has('mcp__session__send_developer_feedback')).toBe(true);
    expect(allowedPrefixed.has('mcp__session__call_llm')).toBe(true);
    expect(allowedPrefixed.has('mcp__session__script_sandbox')).toBe(true);
    expect(blockedPrefixed.has('mcp__session__source_oauth_trigger')).toBe(true);
    expect(blockedPrefixed.has('mcp__session__spawn_session')).toBe(true);
  });
});
