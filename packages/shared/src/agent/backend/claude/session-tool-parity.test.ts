import { describe, it, expect } from 'bun:test';
import {
  CallLlmSchema,
  SpawnSessionSchema,
  BrowserToolSchema,
  TOOL_DESCRIPTIONS,
  SESSION_TOOL_REGISTRY,
} from '@craft-agent/session-tools-core';
import { createLLMTool } from '../../llm-tool.ts';
import { createSpawnSessionTool } from '../../spawn-session-tool.ts';
import { createBrowserTools } from '../../browser-tools.ts';

// The Claude backend-mode adapters used to re-type the description and Zod schema
// of each tool by hand — which is how call_llm lost `thinkingBudget`, spawn_session
// silently gained an undeclared `projectId`, and browser_tool advertised a `drag`
// command the canonical description never mentioned. These tests pin the adapters
// to the single canonical source: same description string, and the *same* schema
// shape object. Object.is (not toBe) is used for the shape because session-tools-core
// is pinned to zod v3 while this package is on zod v4 — the reference is identical at
// runtime, but the two zod type identities differ at compile time.
describe('Claude backend-mode adapters derive their catalog from the canonical registry', () => {
  it('call_llm uses the canonical description + input schema', () => {
    const t = createLLMTool({ sessionId: 's', getQueryFn: () => undefined });
    expect(t.name).toBe('call_llm');
    expect(t.description).toBe(TOOL_DESCRIPTIONS.call_llm);
    expect(Object.is(t.inputSchema, CallLlmSchema.shape)).toBe(true);
    // The v1 contract the adapter honors is backend-executed in the canonical registry.
    expect(SESSION_TOOL_REGISTRY.get('call_llm')?.executionMode).toBe('backend');
  });

  it('spawn_session uses the canonical description + input schema', () => {
    const t = createSpawnSessionTool({ sessionId: 's', getSpawnSessionFn: () => undefined });
    expect(t.name).toBe('spawn_session');
    expect(t.description).toBe(TOOL_DESCRIPTIONS.spawn_session);
    expect(Object.is(t.inputSchema, SpawnSessionSchema.shape)).toBe(true);
  });

  it('browser_tool uses the canonical description + input schema', () => {
    const [t] = createBrowserTools({ sessionId: 's', getBrowserPaneFns: () => undefined });
    expect(t?.name).toBe('browser_tool');
    expect(t?.description).toBe(TOOL_DESCRIPTIONS.browser_tool);
    expect(Object.is(t?.inputSchema, BrowserToolSchema.shape)).toBe(true);
  });
});
