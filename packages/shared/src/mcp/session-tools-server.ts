/**
 * Craft Session Tools MCP Server
 *
 * Local-only Streamable HTTP MCP bridge used by external agent runtimes that
 * cannot consume the in-process Claude SDK tool adapter. Hermes uses this to
 * access Craft-native session tools (plan/auth/config/session helpers,
 * call_llm, spawn_session, and the built-in browser) without patching Hermes
 * Python code or changing Claude/Pi execution paths.
 */

import { randomUUID } from 'node:crypto';
import { createServer, type IncomingMessage, type Server as HttpServer, type ServerResponse } from 'node:http';
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import {
  CallToolRequestSchema,
  isInitializeRequest,
  ListToolsRequestSchema,
} from '@modelcontextprotocol/sdk/types.js';
import {
  executeSessionTool,
  getSessionToolRegistry,
  getToolDefsAsJsonSchema,
  toJsonSchemaToolDef,
  validateSessionToolInput,
  validateSessionToolOutput,
  MCP_ONLY_TOOL_DEFS,
  type ToolResult as SessionToolResult,
} from '@craft-agent/session-tools-core';
import { createClaudeContext } from '../agent/claude-context.ts';
import { attachSessionSelfManagementBindings } from '../agent/session-self-management-bindings.ts';
import {
  getSessionScopedToolCallbacks,
  setLastPlanFilePath,
  type AuthRequest,
} from '../agent/session-scoped-tools.ts';
import { buildCallLlmRequest } from '../agent/llm-tool.ts';
import { executeBrowserToolCommand } from '../agent/browser-tool-runtime.ts';
import { getSessionPath } from '../sessions/storage.ts';
import { enforceLoopbackRequest } from './loopback-guard.ts';
import { FEATURE_FLAGS } from '../feature-flags.ts';
import { getBrowserToolEnabled } from '../config/storage.ts';
import { AUTOMATIONS_HISTORY_FILE } from '../automations/constants.ts';
import { generateShortId, resolveAutomationsConfigPath } from '../automations/resolve-config-path.ts';
import { validateAutomationsConfig } from '../automations/validation.ts';
import type { AutomationEvent, AutomationMatcher, AutomationsConfig, AutomationSystem } from '../automations/index.ts';
import type { PermissionMode } from '../agent/mode-types.ts';

export interface CraftSessionToolsMcpServerOptions {
  sessionId: string;
  workspaceRootPath: string;
  workspaceId?: string;
  debug?: (msg: string) => void;
  defaultLlmConnection?: string;
  defaultModel?: string;
  automationSystem?: Pick<AutomationSystem, 'reloadConfig'>;
  /**
   * Opt-in bearer auth (F4.3b). When set, every request must present
   * `Authorization: Bearer <authToken>`. Left unset by default — enabling it
   * for Hermes requires validating that its MCP client forwards the header
   * configured via ACP `session.mcpServers[].headers`.
   */
  authToken?: string;
}

type McpContent =
  | { type: 'text'; text: string }
  | { type: 'image'; data: string; mimeType: string };

type BridgeToolDefinition = {
  name: string;
  description: string;
  inputSchema: Record<string, unknown>;
  outputSchema?: Record<string, unknown>;
  _meta?: Record<string, unknown>;
};

const BROWSER_RELEASE_HINT = '\n\nWhen you are done using the browser, call browser_tool with command \"close\" to close the window entirely, or \"release\" to dismiss the overlay and let the user continue browsing.';

const AUTOMATION_TOOL_NAME = 'automation_tool';
const MEETING_TOOL_NAME = 'meeting_tool';

function toMcpResult(result: SessionToolResult): { content: McpContent[]; isError?: boolean } {
  return {
    content: result.content.map((entry) => ({ type: 'text' as const, text: entry.text })),
    ...(result.structuredContent ? { structuredContent: result.structuredContent } : {}),
    ...(result.isError ? { isError: true } : {}),
  };
}

function errorResult(message: string): { content: McpContent[]; isError: true } {
  return {
    content: [{ type: 'text', text: `[ERROR] ${message}` }],
    isError: true,
  };
}

function jsonResult(value: unknown): { content: McpContent[] } {
  return {
    content: [{ type: 'text', text: JSON.stringify(value, null, 2) }],
  };
}

export class CraftSessionToolsMcpServer {
  private httpServer: HttpServer | null = null;
  private transports = new Map<string, StreamableHTTPServerTransport>();
  private mcpServers = new Set<Server>();
  private readonly options: CraftSessionToolsMcpServerOptions;
  private _port = 0;

  constructor(options: CraftSessionToolsMcpServerOptions) {
    this.options = options;
  }

  get port(): number {
    return this._port;
  }

  get url(): string {
    return `http://127.0.0.1:${this._port}/mcp`;
  }

  async start(): Promise<string> {
    if (this.httpServer) return this.url;

    this.httpServer = createServer(async (req, res) => {
      if (!enforceLoopbackRequest(req, res, { authToken: this.options.authToken, debug: (msg) => this.debug(msg) })) {
        return;
      }

      const url = new URL(req.url || '/', 'http://127.0.0.1');
      if (url.pathname !== '/mcp') {
        res.writeHead(404);
        res.end('Not Found');
        return;
      }

      await this.handleMcpRequest(req, res);
    });

    await new Promise<void>((resolve, reject) => {
      this.httpServer!.listen(0, '127.0.0.1', () => {
        const addr = this.httpServer!.address();
        this._port = typeof addr === 'object' && addr ? addr.port : 0;
        this.debug(`Listening on 127.0.0.1:${this._port}`);
        resolve();
      });
      this.httpServer!.on('error', reject);
    });

    return this.url;
  }

  getToolDefinitions(): BridgeToolDefinition[] {
    const browserEnabled = getBrowserToolEnabled();
    const nativeDefs = getToolDefsAsJsonSchema({
      includeDeveloperFeedback: FEATURE_FLAGS.developerFeedback,
      includeMemory: FEATURE_FLAGS.memory,
    });
    const bridgeOnlyDefs = MCP_ONLY_TOOL_DEFS.map((def) => toJsonSchemaToolDef(def));
    return [...nativeDefs, ...bridgeOnlyDefs]
      .filter((def) => browserEnabled || def.name !== 'browser_tool')
      .map((def) => ({
        name: def.name,
        description: def.description,
        inputSchema: def.inputSchema,
        outputSchema: def.outputSchema,
        _meta: {
          craftApiVersion: def.apiVersion,
          craftExposure: def.exposure,
          craftExecutionMode: def.executionMode,
          craftSafeMode: def.safeMode,
        },
      }));
  }

  async callTool(name: string, args: Record<string, unknown> = {}): Promise<{ content: McpContent[]; isError?: boolean }> {
    if (name === AUTOMATION_TOOL_NAME || name === MEETING_TOOL_NAME) {
      // mcp-only tools declare a canonical inputSchema via defineTool; validate
      // against it before dispatch so no consumer executes a tool without validation.
      const def = MCP_ONLY_TOOL_DEFS.find((d) => d.name === name);
      if (!def) return errorResult(`Unknown Craft session tool: ${name}`);
      const parsedArgs = validateSessionToolInput(def, args);
      return name === AUTOMATION_TOOL_NAME ? this.automationTool(parsedArgs) : this.meetingTool(parsedArgs);
    }

    const filterOptions = {
      includeDeveloperFeedback: FEATURE_FLAGS.developerFeedback,
      includeMemory: FEATURE_FLAGS.memory,
    };
    const def = getSessionToolRegistry(filterOptions).get(name);
    if (!def) return errorResult(`Unknown Craft session tool: ${name}`);

    if (def.executionMode === 'registry') {
      return toMcpResult(await executeSessionTool(name, this.createContext(), args, filterOptions));
    }

    const parsedArgs = validateSessionToolInput(def, args);
    if (name === 'call_llm') return validateSessionToolOutput(def, await this.callLlm(parsedArgs));
    if (name === 'spawn_session') return validateSessionToolOutput(def, await this.spawnSession(parsedArgs));
    if (name === 'browser_tool') return validateSessionToolOutput(def, await this.browserTool(parsedArgs));

    return errorResult(`Craft session tool is not executable in this context: ${name}`);
  }

  async stop(): Promise<void> {
    for (const transport of this.transports.values()) {
      await transport.close().catch(() => {});
    }
    this.transports.clear();

    for (const server of this.mcpServers.values()) {
      await server.close().catch(() => {});
    }
    this.mcpServers.clear();

    if (this.httpServer) {
      await new Promise<void>((resolve) => {
        this.httpServer!.close(() => resolve());
      });
      this.httpServer = null;
      this._port = 0;
      this.debug('Stopped');
    }
  }

  private async handleMcpRequest(req: IncomingMessage, res: ServerResponse): Promise<void> {
    let parsedBody: unknown;

    try {
      parsedBody = await this.readJsonBody(req);
      const sessionId = this.firstHeader(req.headers['mcp-session-id']);
      let transport = sessionId ? this.transports.get(sessionId) : undefined;

      if (!transport) {
        if (req.method === 'POST' && !sessionId && isInitializeRequest(parsedBody)) {
          let createdTransport: StreamableHTTPServerTransport | null = null;
          transport = new StreamableHTTPServerTransport({
            sessionIdGenerator: () => randomUUID(),
            onsessioninitialized: (newSessionId) => {
              if (createdTransport) {
                this.transports.set(newSessionId, createdTransport);
                this.debug(`MCP session initialized: ${newSessionId}`);
              }
            },
          });
          createdTransport = transport;

          const server = this.createMcpServer();
          this.mcpServers.add(server);
          transport.onclose = () => {
            const sid = createdTransport?.sessionId;
            if (sid) this.transports.delete(sid);
            this.mcpServers.delete(server);
            void server.close().catch(() => {});
          };

          await server.connect(transport);
        } else {
          this.writeJsonRpcError(res, 400, -32000, 'Bad Request: No valid MCP session ID provided');
          return;
        }
      }

      await transport.handleRequest(req, res, parsedBody);
    } catch (error) {
      this.debug(`MCP request failed: ${error instanceof Error ? error.stack || error.message : String(error)}`);
      if (!res.headersSent) {
        this.writeJsonRpcError(res, 500, -32603, 'Internal server error');
      } else if (!res.writableEnded) {
        res.end();
      }
    }
  }

  private async readJsonBody(req: IncomingMessage): Promise<unknown> {
    if (req.method !== 'POST') return undefined;

    const chunks: Buffer[] = [];
    for await (const chunk of req) {
      chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
    }

    if (chunks.length === 0) return undefined;
    return JSON.parse(Buffer.concat(chunks).toString('utf-8'));
  }

  private firstHeader(value: string | string[] | undefined): string | undefined {
    return Array.isArray(value) ? value[0] : value;
  }

  private writeJsonRpcError(res: ServerResponse, httpStatus: number, code: number, message: string): void {
    res.writeHead(httpStatus, { 'content-type': 'application/json' });
    res.end(JSON.stringify({
      jsonrpc: '2.0',
      error: { code, message },
      id: null,
    }));
  }

  private createMcpServer(): Server {
    const server = new Server(
      { name: 'craft-session-tools', version: '1.0.0' },
      { capabilities: { tools: {} } },
    );

    server.setRequestHandler(ListToolsRequestSchema, async () => ({
      tools: this.getToolDefinitions().map((def) => ({
        name: def.name,
        description: def.description,
        inputSchema: def.inputSchema as { type: 'object'; properties?: Record<string, unknown> },
        outputSchema: def.outputSchema as { type: 'object'; properties?: Record<string, unknown> },
        _meta: def._meta,
      })),
    }));

    server.setRequestHandler(CallToolRequestSchema, async (request) => {
      const { name, arguments: rawArgs } = request.params;
      this.debug(`Tool call: ${name}`);
      return this.callTool(name, (rawArgs ?? {}) as Record<string, unknown>) as any;
    });

    return server;
  }

  private createContext() {
    const { sessionId, workspaceRootPath, workspaceId } = this.options;
    const ctx = createClaudeContext({
      sessionId,
      workspacePath: workspaceRootPath,
      workspaceId: workspaceId || '',
      onPlanSubmitted: (planPath: string) => {
        setLastPlanFilePath(sessionId, planPath);
        getSessionScopedToolCallbacks(sessionId)?.onPlanSubmitted?.(planPath);
      },
      onAuthRequest: (request: unknown) => {
        getSessionScopedToolCallbacks(sessionId)?.onAuthRequest?.(request as AuthRequest);
      },
    });
    attachSessionSelfManagementBindings(ctx, sessionId);
    return ctx;
  }

  private async callLlm(args: Record<string, unknown>) {
    const callbacks = getSessionScopedToolCallbacks(this.options.sessionId);
    const queryFn = callbacks?.queryFn;
    if (!queryFn) {
      return errorResult('No authentication configured for call_llm. Sign in with your AI provider to use this tool.');
    }

    try {
      const request = await buildCallLlmRequest(args, {
        backendName: 'Hermes',
        sessionPath: getSessionPath(this.options.workspaceRootPath, this.options.sessionId),
      });
      const result = await queryFn(request);
      if (!result.text && !result.warning) {
        return { content: [{ type: 'text' as const, text: '(Model returned empty response)' }] };
      }
      const body = result.warning
        ? `[Partial result — ${result.warning}]\n\n${result.text || '(no text produced before stop)'}`
        : result.text;
      return { content: [{ type: 'text' as const, text: body }] };
    } catch (error) {
      return errorResult(`call_llm failed: ${error instanceof Error ? error.message : String(error)}`);
    }
  }

  private async spawnSession(args: Record<string, unknown>) {
    const spawnFn = getSessionScopedToolCallbacks(this.options.sessionId)?.spawnSessionFn;
    if (!spawnFn) return errorResult('spawn_session is not available in this context.');

    try {
      return jsonResult(await spawnFn(args));
    } catch (error) {
      return errorResult(`spawn_session failed: ${error instanceof Error ? error.message : String(error)}`);
    }
  }

  private async browserTool(args: Record<string, unknown>) {
    if (!getBrowserToolEnabled()) return errorResult('browser_tool is disabled in Settings.');

    const browserFns = getSessionScopedToolCallbacks(this.options.sessionId)?.browserPaneFns;
    if (!browserFns) return errorResult('Browser window controls are not available. This tool requires the desktop app.');

    try {
      const result = await executeBrowserToolCommand({
        command: args.command as string | string[],
        fns: browserFns,
        sessionId: this.options.sessionId,
      });
      const text = result.appendReleaseHint ? `${result.output}${BROWSER_RELEASE_HINT}` : result.output;
      const content: McpContent[] = [{ type: 'text', text }];
      if (result.image) {
        content.push({ type: 'image', data: result.image.data, mimeType: result.image.mimeType });
      }
      return { content };
    } catch (error) {
      return errorResult(error instanceof Error ? error.message : String(error));
    }
  }

  private readAutomationsConfig(): AutomationsConfig {
    const configPath = resolveAutomationsConfigPath(this.options.workspaceRootPath);
    if (!existsSync(configPath)) return { automations: {} };
    const parsed = JSON.parse(readFileSync(configPath, 'utf-8')) as unknown;
    const validation = validateAutomationsConfig(parsed);
    if (!validation.valid || !validation.config) {
      throw new Error(`Invalid automations.json: ${validation.errors.join('; ')}`);
    }
    return validation.config;
  }

  private writeAutomationsConfig(config: AutomationsConfig): void {
    const validation = validateAutomationsConfig(config);
    if (!validation.valid) {
      throw new Error(`Refusing to write invalid automations.json: ${validation.errors.join('; ')}`);
    }
    writeFileSync(resolveAutomationsConfigPath(this.options.workspaceRootPath), JSON.stringify(config, null, 2) + '\n', 'utf-8');
  }

  private findAutomation(config: AutomationsConfig, id: string): { event: AutomationEvent; matcher: AutomationMatcher; index: number } | null {
    for (const [event, matchers] of Object.entries(config.automations) as Array<[AutomationEvent, AutomationMatcher[] | undefined]>) {
      const index = (matchers ?? []).findIndex((matcher) => matcher.id === id);
      if (index >= 0) return { event, matcher: matchers![index]!, index };
    }
    return null;
  }

  private flattenAutomations(config: AutomationsConfig) {
    return Object.entries(config.automations).flatMap(([event, matchers]) =>
      (matchers ?? []).map((matcher) => ({
        event,
        id: matcher.id,
        name: matcher.name,
        cron: matcher.cron,
        timezone: matcher.timezone,
        enabled: matcher.enabled !== false,
        labels: matcher.labels ?? [],
        permissionMode: matcher.permissionMode,
        actions: matcher.actions.map((action) => action.type),
      })),
    );
  }

  private async automationTool(args: Record<string, unknown>) {
    const command = String(args.command ?? '');
    try {
      if (command === 'list') {
        return jsonResult({ automations: this.flattenAutomations(this.readAutomationsConfig()) });
      }

      if (command === 'create_scheduled') {
        const cron = typeof args.cron === 'string' ? args.cron.trim() : '';
        const prompt = typeof args.prompt === 'string' ? args.prompt.trim() : '';
        if (!cron) return errorResult('automation_tool create_scheduled requires cron.');
        if (!prompt) return errorResult('automation_tool create_scheduled requires prompt.');

        const config = this.readAutomationsConfig();
        const matcher: AutomationMatcher = {
          id: generateShortId(),
          name: typeof args.name === 'string' && args.name.trim() ? args.name.trim() : `Hermes scheduled task ${new Date().toISOString()}`,
          cron,
          timezone: typeof args.timezone === 'string' && args.timezone.trim() ? args.timezone.trim() : undefined,
          enabled: typeof args.enabled === 'boolean' ? args.enabled : true,
          labels: Array.from(new Set(['hermes', 'scheduled', ...(Array.isArray(args.labels) ? args.labels.filter((label): label is string => typeof label === 'string') : [])])),
          permissionMode: args.permissionMode as PermissionMode | undefined,
          actions: [{
            type: 'prompt',
            prompt,
            llmConnection: typeof args.llmConnection === 'string' && args.llmConnection.trim() ? args.llmConnection.trim() : this.configConnectionSlug(),
            model: typeof args.model === 'string' && args.model.trim() ? args.model.trim() : this.options.defaultModel,
          }],
        };
        config.automations.SchedulerTick = [...(config.automations.SchedulerTick ?? []), matcher];
        this.writeAutomationsConfig(config);
        this.configAutomationSystemReload();
        return jsonResult({ ok: true, automation: matcher });
      }

      if (command === 'toggle') {
        const id = typeof args.id === 'string' ? args.id.trim() : '';
        if (!id) return errorResult('automation_tool toggle requires id.');
        const config = this.readAutomationsConfig();
        const found = this.findAutomation(config, id);
        if (!found) return errorResult(`Automation not found: ${id}`);
        found.matcher.enabled = typeof args.enabled === 'boolean' ? args.enabled : found.matcher.enabled === false;
        this.writeAutomationsConfig(config);
        this.configAutomationSystemReload();
        return jsonResult({ ok: true, id, enabled: found.matcher.enabled !== false });
      }

      if (command === 'delete') {
        const id = typeof args.id === 'string' ? args.id.trim() : '';
        if (!id) return errorResult('automation_tool delete requires id.');
        const config = this.readAutomationsConfig();
        const found = this.findAutomation(config, id);
        if (!found) return errorResult(`Automation not found: ${id}`);
        config.automations[found.event] = (config.automations[found.event] ?? []).filter((matcher) => matcher.id !== id);
        this.writeAutomationsConfig(config);
        this.configAutomationSystemReload();
        return jsonResult({ ok: true, deleted: id });
      }

      if (command === 'history') {
        const limit = Math.max(1, Math.min(100, Number(args.limit ?? 20) || 20));
        const id = typeof args.id === 'string' && args.id.trim() ? args.id.trim() : undefined;
        const historyPath = join(this.options.workspaceRootPath, AUTOMATIONS_HISTORY_FILE);
        if (!existsSync(historyPath)) return jsonResult({ entries: [] });
        const entries = readFileSync(historyPath, 'utf-8')
          .split('\n')
          .filter(Boolean)
          .map((line) => {
            try { return JSON.parse(line) as Record<string, unknown>; } catch { return null; }
          })
          .filter((entry): entry is Record<string, unknown> => Boolean(entry))
          .filter((entry) => !id || entry.matcherId === id)
          .slice(-limit);
        return jsonResult({ entries });
      }

      return errorResult(`Unknown automation_tool command: ${command}`);
    } catch (error) {
      return errorResult(`automation_tool failed: ${error instanceof Error ? error.message : String(error)}`);
    }
  }

  private async meetingTool(args: Record<string, unknown>) {
    const command = String(args.command ?? '');
    if (!['start', 'status', 'list', 'transcript', 'stop'].includes(command)) {
      return errorResult(`Unknown meeting_tool command: ${command || '(missing)'}`);
    }

    const meetingToolFn = getSessionScopedToolCallbacks(this.options.sessionId)?.meetingToolFn;
    if (!meetingToolFn) {
      return errorResult('meeting_tool is not available in this context. Craft native meeting callbacks are not registered for this session/runtime.');
    }

    try {
      return jsonResult(await meetingToolFn({ ...args, command: command as 'start' | 'status' | 'list' | 'transcript' | 'stop' }));
    } catch (error) {
      return errorResult(`meeting_tool failed: ${error instanceof Error ? error.message : String(error)}`);
    }
  }

  private configConnectionSlug(): string | undefined {
    return this.options.defaultLlmConnection;
  }

  private configAutomationSystemReload(): void {
    this.options.automationSystem?.reloadConfig();
  }

  private debug(message: string): void {
    this.options.debug?.(`[CraftSessionToolsMcpServer] ${message}`);
  }
}
