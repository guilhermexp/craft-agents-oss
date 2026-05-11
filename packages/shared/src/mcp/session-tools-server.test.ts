import { afterEach, beforeEach, describe, expect, it } from 'bun:test';
import { mkdtempSync, rmSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';

import { CraftSessionToolsMcpServer } from './session-tools-server.ts';
import { getToolDefsAsJsonSchema } from '@craft-agent/session-tools-core';
import {
  mergeSessionScopedToolCallbacks,
  unregisterSessionScopedToolCallbacks,
} from '../agent/session-scoped-tools.ts';

describe('CraftSessionToolsMcpServer', () => {
  let workspaceRootPath = '';
  const sessionId = 'test-hermes-session-tools';

  beforeEach(() => {
    workspaceRootPath = mkdtempSync(join(tmpdir(), 'craft-session-tools-'));
    mkdirSync(join(workspaceRootPath, 'sessions', sessionId), { recursive: true });
    unregisterSessionScopedToolCallbacks(sessionId);
  });

  afterEach(() => {
    unregisterSessionScopedToolCallbacks(sessionId);
    delete process.env.CRAFT_FEATURE_DEVELOPER_FEEDBACK;
    delete process.env.CRAFT_FEATURE_MEMORY;
    if (workspaceRootPath) rmSync(workspaceRootPath, { recursive: true, force: true });
  });

  it('lists canonical session tools for Hermes over MCP', () => {
    const server = new CraftSessionToolsMcpServer({ sessionId, workspaceRootPath, workspaceId: 'ws-test' });

    const toolNames = server.getToolDefinitions().map((tool) => tool.name);

    expect(toolNames).toContain('config_validate');
    expect(toolNames).toContain('call_llm');
    expect(toolNames).toContain('spawn_session');
    expect(toolNames).toContain('get_session_info');
    expect(toolNames).toContain('meeting_tool');
  });

  it('keeps the Hermes MCP bridge catalog aligned with the native v1 catalog', () => {
    process.env.CRAFT_FEATURE_DEVELOPER_FEEDBACK = '1';
    process.env.CRAFT_FEATURE_MEMORY = '1';
    const server = new CraftSessionToolsMcpServer({ sessionId, workspaceRootPath, workspaceId: 'ws-test' });
    const bridgeTools = new Map(server.getToolDefinitions().map((tool) => [tool.name, tool]));
    const nativeTools = getToolDefsAsJsonSchema({
      includeDeveloperFeedback: true,
      includeMemory: true,
    }).filter((tool) => tool.name !== 'browser_tool');

    for (const nativeTool of nativeTools) {
      const bridgeTool = bridgeTools.get(nativeTool.name);
      expect(bridgeTool).toBeDefined();
      expect(bridgeTool?.description).toBe(nativeTool.description);
      expect(bridgeTool?.inputSchema).toEqual(nativeTool.inputSchema);
      expect(bridgeTool?.outputSchema).toEqual(nativeTool.outputSchema);
      expect(bridgeTool?._meta?.craftApiVersion).toBe(nativeTool.apiVersion);
    }
  });

  it('serves session tools through the Streamable HTTP MCP bridge', async () => {
    const server = new CraftSessionToolsMcpServer({ sessionId, workspaceRootPath, workspaceId: 'ws-test' });
    const url = await server.start();
    const client = new Client({ name: 'craft-session-tools-test', version: '0.0.1' });

    try {
      await client.connect(new StreamableHTTPClientTransport(new URL(url)));
      const listed = await client.listTools();
      const toolNames = listed.tools.map((tool) => tool.name);

      expect(toolNames).toContain('browser_tool');
      expect(toolNames).toContain('call_llm');
      expect(toolNames).toContain('spawn_session');
      expect(toolNames).toContain('meeting_tool');
      const callLlmTool = listed.tools.find((tool) => tool.name === 'call_llm');
      expect(callLlmTool?.outputSchema?.type).toBe('object');
    } finally {
      await client.close().catch(() => {});
      await server.stop();
    }
  });

  it('executes call_llm through the session callback registry', async () => {
    const seenPrompts: string[] = [];
    mergeSessionScopedToolCallbacks(sessionId, {
      queryFn: async (request) => {
        seenPrompts.push(request.prompt);
        return { text: 'mini result', model: request.model };
      },
    });
    const server = new CraftSessionToolsMcpServer({ sessionId, workspaceRootPath, workspaceId: 'ws-test' });

    const result = await server.callTool('call_llm', { prompt: 'summarize this', model: 'gpt-5.1' });

    expect(result.isError).toBeUndefined();
    expect(result.content[0]).toEqual({ type: 'text', text: 'mini result' });
    expect(seenPrompts).toEqual(['summarize this']);
  });

  it('executes spawn_session through the session callback registry', async () => {
    mergeSessionScopedToolCallbacks(sessionId, {
      spawnSessionFn: async (input) => ({
        sessionId: 'child-session',
        name: String(input.prompt),
        status: 'started',
      }),
    });
    const server = new CraftSessionToolsMcpServer({ sessionId, workspaceRootPath, workspaceId: 'ws-test' });

    const result = await server.callTool('spawn_session', { prompt: 'research Hermes' });

    expect(result.isError).toBeUndefined();
    expect(result.content[0]?.type).toBe('text');
    expect((result.content[0] as { text: string }).text).toContain('child-session');
  });

  it('returns a clear unavailable error when meeting callbacks are not registered', async () => {
    const server = new CraftSessionToolsMcpServer({ sessionId, workspaceRootPath, workspaceId: 'ws-test' });

    const result = await server.callTool('meeting_tool', { command: 'status' });

    expect(result.isError).toBe(true);
    expect((result.content[0] as { text: string }).text).toContain('Craft native meeting callbacks are not registered');
  });

  it('executes meeting_tool through the session callback registry', async () => {
    const seenCommands: string[] = [];
    mergeSessionScopedToolCallbacks(sessionId, {
      meetingToolFn: async (request) => {
        seenCommands.push(request.command);
        return { ok: true, meetingId: request.meetingId ?? 'meeting-1', status: 'recording' };
      },
    });
    const server = new CraftSessionToolsMcpServer({ sessionId, workspaceRootPath, workspaceId: 'ws-test' });

    const result = await server.callTool('meeting_tool', { command: 'start', meetingId: 'meeting-1', title: 'Planning' });

    expect(result.isError).toBeUndefined();
    expect(seenCommands).toEqual(['start']);
    expect(JSON.parse((result.content[0] as { text: string }).text)).toEqual({ ok: true, meetingId: 'meeting-1', status: 'recording' });
  });

  it('executes registry session-management tools with late-bound callbacks', async () => {
    mergeSessionScopedToolCallbacks(sessionId, {
      getSessionInfoFn: (requestedSessionId) => ({
        id: requestedSessionId ?? sessionId,
        name: 'Hermes test session',
        status: 'todo',
        labels: [],
        permissionMode: 'safe',
        createdAt: Date.UTC(2026, 3, 29),
        updatedAt: Date.UTC(2026, 3, 29),
        workingDirectory: workspaceRootPath,
        isActive: true,
      }),
    });
    const server = new CraftSessionToolsMcpServer({ sessionId, workspaceRootPath, workspaceId: 'ws-test' });

    const result = await server.callTool('get_session_info', {});

    expect(result.isError).toBeUndefined();
    expect((result.content[0] as { text: string }).text).toContain('Hermes test session');
  });

  it('creates, toggles, lists, and deletes Craft-native scheduled automations', async () => {
    let reloadCount = 0;
    const server = new CraftSessionToolsMcpServer({
      sessionId,
      workspaceRootPath,
      workspaceId: 'ws-test',
      defaultLlmConnection: 'hermes',
      defaultModel: 'openrouter:gpt-5.5',
      automationSystem: { reloadConfig: () => { reloadCount += 1; return { success: true, automationCount: 1, errors: [] }; } },
    });

    const created = await server.callTool('automation_tool', {
      command: 'create_scheduled',
      name: 'Hermes daily check',
      cron: '0 9 * * *',
      timezone: 'America/Sao_Paulo',
      prompt: 'Run the daily Hermes check',
      labels: ['daily'],
    });
    expect(created.isError).toBeUndefined();
    const createdPayload = JSON.parse((created.content[0] as { text: string }).text);
    const id = createdPayload.automation.id as string;
    expect(createdPayload.automation.actions[0].llmConnection).toBe('hermes');
    expect(createdPayload.automation.actions[0].model).toBe('openrouter:gpt-5.5');
    expect(createdPayload.automation.labels).toEqual(['hermes', 'scheduled', 'daily']);

    const listed = await server.callTool('automation_tool', { command: 'list' });
    expect((listed.content[0] as { text: string }).text).toContain('Hermes daily check');

    const toggled = await server.callTool('automation_tool', { command: 'toggle', id, enabled: false });
    expect(JSON.parse((toggled.content[0] as { text: string }).text).enabled).toBe(false);

    const deleted = await server.callTool('automation_tool', { command: 'delete', id });
    expect(JSON.parse((deleted.content[0] as { text: string }).text).deleted).toBe(id);
    expect(reloadCount).toBe(3);
  });

});
