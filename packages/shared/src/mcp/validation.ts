/**
 * MCP Connection Validation
 *
 * Validates HTTP/SSE MCP servers by connecting directly via CraftMcpClient
 * and listing tools. Avoids spawning a Claude Code subprocess (which is killed
 * by Electron's macOS sandbox — see issue #697).
 */

import { CraftMcpClient } from './client.js';
import { debug } from '../utils/debug.ts';
import { normalizeMcpUrl } from '../sources/server-builder.ts';
import type { McpTransport } from '../sources/types.ts';

export interface InvalidProperty {
  toolName: string;
  propertyPath: string;
  propertyKey: string;
}

export interface McpValidationResult {
  success: boolean;
  error?: string;
  errorType?: 'failed' | 'needs-auth' | 'pending' | 'invalid-schema' | 'disabled' | 'unknown';
  serverInfo?: {
    name: string;
    version: string;
  };
  invalidProperties?: InvalidProperty[];
  /** Tool names available on this server (populated on successful connection) */
  tools?: string[];
}

type McpValidationFailureCode =
  | 'mcp-auth-required'
  | 'mcp-command-not-found'
  | 'mcp-command-permission-denied'
  | 'mcp-connection-failed'
  | 'mcp-initialize-ceiling-timeout'
  | 'mcp-initialize-failed'
  | 'mcp-initialize-idle-timeout'
  | 'mcp-invalid-tool-schema'
  | 'mcp-tools-list-timeout'
  | 'mcp-validation-failed'
  | 'mcp-validation-timeout'

/** Raw validator details are classification input only and never cross a boundary. */
function sanitizeMcpValidationFailure(
  _rawFailure: unknown,
  code: McpValidationFailureCode,
): McpValidationFailureCode {
  return code
}

/**
 * Pattern for valid property names in tool input schemas.
 * Must match: letters, numbers, underscores, dots, hyphens (1-64 chars)
 *
 * This pattern is enforced server-side by the Anthropic API.
 * It is NOT defined in the MCP specification (which has no naming constraints).
 * It is NOT exported by @anthropic-ai/sdk or @anthropic-ai/claude-agent-sdk.
 *
 * API error when violated:
 * "tools.0.custom.input_schema.properties: Property keys should match pattern '^[a-zA-Z0-9_.-]{1,64}$'"
 *
 * @see https://github.com/modelcontextprotocol/go-sdk/issues/169 - confirms this is Claude-specific
 * @see https://platform.claude.com/docs/en/agents-and-tools/tool-use/overview
 */
export const ANTHROPIC_PROPERTY_NAME_PATTERN = /^[a-zA-Z0-9_.-]{1,64}$/;

/**
 * Recursively finds invalid property names in a JSON schema.
 * Returns an array of invalid properties with their paths.
 */
function findInvalidProperties(
  schema: Record<string, unknown>,
  path = ''
): { path: string; key: string }[] {
  const invalid: { path: string; key: string }[] = [];

  if (!schema || typeof schema !== 'object') {
    return invalid;
  }

  // Check properties object
  if (schema.properties && typeof schema.properties === 'object') {
    const properties = schema.properties as Record<string, unknown>;
    for (const key of Object.keys(properties)) {
      if (!ANTHROPIC_PROPERTY_NAME_PATTERN.test(key)) {
        invalid.push({
          path: path ? `${path}.${key}` : key,
          key,
        });
      }
      // Recurse into nested schemas
      const nestedSchema = properties[key];
      if (nestedSchema && typeof nestedSchema === 'object') {
        invalid.push(
          ...findInvalidProperties(
            nestedSchema as Record<string, unknown>,
            path ? `${path}.${key}` : key
          )
        );
      }
    }
  }

  // Check items for arrays
  if (schema.items && typeof schema.items === 'object') {
    invalid.push(
      ...findInvalidProperties(
        schema.items as Record<string, unknown>,
        path ? `${path}[]` : '[]'
      )
    );
  }

  // Check additionalProperties if it's a schema object
  if (
    schema.additionalProperties &&
    typeof schema.additionalProperties === 'object'
  ) {
    invalid.push(
      ...findInvalidProperties(
        schema.additionalProperties as Record<string, unknown>,
        path ? `${path}.<additionalProperties>` : '<additionalProperties>'
      )
    );
  }

  return invalid;
}

export interface McpValidationConfig {
  /** MCP server URL */
  mcpUrl: string;
  /** Transport type ('http' or 'sse'). Defaults to 'http'. */
  mcpTransport?: McpTransport;
  /** Custom headers for MCP requests (merged before auth headers) */
  mcpHeaders?: Record<string, string>;
  /** Access token for MCP server (OAuth or bearer) */
  mcpAccessToken?: string;
}

/**
 * Map a low-level connection error to a user-actionable result.
 * Heuristic — keep simple, the underlying message is preserved as the source of truth.
 */
function classifyConnectionError(err: unknown): McpValidationResult {
  const message = err instanceof Error ? err.message : String(err);
  let errorType: McpValidationResult['errorType'] = 'failed';
  if (/\b401\b|\b403\b|unauthorized|forbidden|authentication/i.test(message)) {
    errorType = 'needs-auth';
  }
  return {
    success: false,
    error: sanitizeMcpValidationFailure(
      err,
      errorType === 'needs-auth' ? 'mcp-auth-required' : 'mcp-connection-failed',
    ),
    errorType,
  };
}

/**
 * Validates an HTTP/SSE MCP connection by connecting via CraftMcpClient and
 * listing tools. The internal `connect()` call performs a `listTools()` health
 * check, so a successful connect proves the server is reachable and responsive.
 */
export async function validateMcpConnection(
  config: McpValidationConfig
): Promise<McpValidationResult> {
  debug('[mcp-validation] validating configured endpoint');

  const mcpUrl = normalizeMcpUrl(config.mcpUrl);

  // Custom headers first, auth header overrides.
  const headers = {
    ...config.mcpHeaders,
    ...(config.mcpAccessToken ? { Authorization: `Bearer ${config.mcpAccessToken}` } : {}),
  };

  // SSE transport is not supported by CraftMcpClient (HTTP only). Streamable
  // HTTP is the modern transport; SSE servers will surface a clear connect error.
  const mcpClient = new CraftMcpClient({
    transport: 'http',
    url: mcpUrl,
    headers: Object.keys(headers).length > 0 ? headers : undefined,
  });

  try {
    await mcpClient.connect();
    const serverInfo = mcpClient.getServerInfo();

    const tools = await mcpClient.listTools();
    const toolNames = tools.map((t) => t.name);

    debug(`Validating schemas for ${tools.length} tools`);

    const allInvalidProperties: InvalidProperty[] = [];
    for (const tool of tools) {
      if (tool.inputSchema && typeof tool.inputSchema === 'object') {
        const invalidProps = findInvalidProperties(
          tool.inputSchema as Record<string, unknown>
        );
        for (const prop of invalidProps) {
          allInvalidProperties.push({
            toolName: tool.name,
            propertyPath: prop.path,
            propertyKey: prop.key,
          });
        }
      }
    }

    if (allInvalidProperties.length > 0) {
      return {
        success: false,
        error: sanitizeMcpValidationFailure(allInvalidProperties, 'mcp-invalid-tool-schema'),
        errorType: 'invalid-schema',
        serverInfo,
        invalidProperties: allInvalidProperties,
        tools: toolNames,
      };
    }

    return {
      success: true,
      serverInfo,
      tools: toolNames,
    };
  } catch (err) {
    const failure = classifyConnectionError(err);
    debug('[mcp-validation] failed', { errorType: failure.errorType });
    return failure;
  } finally {
    await mcpClient.close().catch(() => {});
  }
}

export interface StdioValidationConfig {
  /** Command to spawn (e.g., 'npx', 'node') */
  command: string;
  /** Arguments to pass to the command */
  args?: string[];
  /** Environment variables for the spawned process */
  env?: Record<string, string>;
  /** Timeout in ms (default: 30000) */
  timeout?: number;
}

/**
 * Connect-phase watchdog with two cooperating timers:
 *
 *  - **Idle timer** — fires after `idleMs` of *silence* on stderr. Reset every
 *    time `kick()` is called (typically from the stderr data handler). Catches
 *    "spawn loop has gone quiet, server is hung."
 *  - **Ceiling timer** — fires unconditionally after `ceilingMs` of wall-clock
 *    since creation. Hard cap so a server that floods stderr but never
 *    completes `initialize` can't hold the connect phase alive forever.
 *
 * `outcome()` returns which one fired (or null if connect resolved first).
 */
interface ConnectWatchdog {
  promise: Promise<never>;
  kick: () => void;
  stop: () => void;
  outcome: () => 'idle' | 'ceiling' | null;
}

function createConnectWatchdog(
  idleMs: number,
  ceilingMs: number,
): ConnectWatchdog {
  let idleTimer: ReturnType<typeof setTimeout> | null = null;
  let ceilingTimer: ReturnType<typeof setTimeout> | null = null;
  let outcome: 'idle' | 'ceiling' | null = null;
  let stopped = false;
  let rejectFn: ((err: Error) => void) | null = null;

  const promise = new Promise<never>((_, reject) => {
    rejectFn = reject;
  });
  // Swallow unhandled rejection if the race winner is `client.connect()`.
  promise.catch(() => {});

  const fire = (kind: 'idle' | 'ceiling') => {
    if (outcome || stopped) return;
    outcome = kind;
    if (idleTimer) clearTimeout(idleTimer);
    if (ceilingTimer) clearTimeout(ceilingTimer);
    idleTimer = null;
    ceilingTimer = null;
    rejectFn?.(
      new Error(
        kind === 'idle'
          ? `Timeout: MCP initialize did not complete within ${idleMs}ms of stderr silence`
          : `Timeout: MCP initialize did not complete within the ${ceilingMs}ms ceiling`,
      ),
    );
  };

  const arm = () => {
    if (outcome || stopped) return;
    if (idleTimer) clearTimeout(idleTimer);
    idleTimer = setTimeout(() => fire('idle'), idleMs);
  };

  ceilingTimer = setTimeout(() => fire('ceiling'), ceilingMs);
  arm();

  return {
    promise,
    kick: arm,
    stop: () => {
      stopped = true;
      if (idleTimer) clearTimeout(idleTimer);
      if (ceilingTimer) clearTimeout(ceilingTimer);
      idleTimer = null;
      ceilingTimer = null;
    },
    outcome: () => outcome,
  };
}

/**
 * Validates a stdio MCP connection by spawning the process and listing tools.
 *
 * Unlike HTTP validation, this actually spawns the MCP server process,
 * connects via stdio transport, and validates the available tools.
 *
 * Process lifecycle is owned exclusively by `StdioClientTransport` — we do
 * NOT spawn a second copy of the server. Earlier versions did, which caused
 * "Server startup timeout" symptoms because the unused first child held pipes
 * with no consumer (see #787).
 */
export async function validateStdioMcpConnection(
  config: StdioValidationConfig
): Promise<McpValidationResult> {
  const { command, args = [], env = {}, timeout = 30000 } = config;

  // Two-watchdog connect phase. Most "MCP doesn't work" failures never
  // complete the `initialize` handshake, so we want fast diagnostics — but
  // legitimate cold-cache installs (`uv tool run`, `npx`, `pipx`) can take
  // 20+ seconds while emitting reassuring stderr noise. The idle timer
  // resets on every stderr event so cold installs aren't penalized; the
  // ceiling caps the worst-case to prevent a noisy-but-broken server from
  // holding the validation alive forever.
  const connectIdleMs = Math.min(8000, Math.max(1000, Math.floor(timeout / 2)));
  const listToolsFloor = 2000;
  const connectCeilingMs = Math.max(connectIdleMs, timeout - listToolsFloor);
  let listToolsTimeoutResolved = listToolsFloor;

  debug('[stdio-validation] spawning configured command');

  const [{ Client }, { StdioClientTransport }] = await Promise.all([
    import('@modelcontextprotocol/sdk/client/index.js'),
    import('@modelcontextprotocol/sdk/client/stdio.js'),
  ]);

  let client: InstanceType<typeof Client> | null = null;
  let transport: InstanceType<typeof StdioClientTransport> | null = null;
  // Track which phase failed for richer diagnostics.
  let phase: 'connect' | 'list-tools' | 'unknown' = 'unknown';

  const cleanup = async () => {
    if (client) {
      try {
        await client.close();
      } catch {
        // Ignore close errors — best-effort.
      }
      client = null;
    }
    if (transport) {
      try {
        await transport.close();
      } catch {
        // Ignore close errors — SDK kills the subprocess internally.
      }
      transport = null;
    }
  };

  // Filter out undefined entries from process.env before merging.
  const processEnv: Record<string, string> = {};
  for (const [key, value] of Object.entries(process.env)) {
    if (value !== undefined) {
      processEnv[key] = value;
    }
  }

  const withTimeout = <T>(p: Promise<T>, ms: number, label: string): Promise<T> => {
    return new Promise<T>((resolve, reject) => {
      const id = setTimeout(() => {
        reject(new Error(`Timeout: ${label} did not complete within ${ms}ms`));
      }, ms);
      p.then(
        (v) => {
          clearTimeout(id);
          resolve(v);
        },
        (e) => {
          clearTimeout(id);
          reject(e);
        },
      );
    });
  };

  try {
    transport = new StdioClientTransport({
      command,
      args,
      env: { ...processEnv, ...env },
      stderr: 'pipe',
    });

    const watchdog = createConnectWatchdog(connectIdleMs, connectCeilingMs);

    // The SDK exposes a PassThrough _before_ `start()` is called, so this
    // listener catches early startup output too. Every stderr event resets
    // the idle watchdog — keeps cold-cache installs (`uv`/`uvx`/`npx`) from
    // timing out while they emit reassuring progress noise.
    transport.stderr?.on('data', () => {
      watchdog.kick();
    });

    client = new Client(
      { name: 'craft-agent-validator', version: '1.0.0' },
      { capabilities: {} }
    );

    phase = 'connect';
    const connectStart = Date.now();
    try {
      await Promise.race([client.connect(transport), watchdog.promise]);
    } finally {
      watchdog.stop();
    }
    const elapsedConnect = Date.now() - connectStart;
    listToolsTimeoutResolved = Math.max(listToolsFloor, timeout - elapsedConnect);

    phase = 'list-tools';
    const toolsResult = await withTimeout(
      client.listTools(),
      listToolsTimeoutResolved,
      'tools/list',
    );
    const tools = toolsResult.tools || [];
    const toolNames = tools.map((t: { name: string }) => t.name);

    debug(`[stdio-validation] Found ${tools.length} tools`);

    // Validate tool schemas for property naming
    const allInvalidProperties: InvalidProperty[] = [];
    for (const tool of tools) {
      if (tool.inputSchema && typeof tool.inputSchema === 'object') {
        const invalidProps = findInvalidProperties(
          tool.inputSchema as Record<string, unknown>
        );
        for (const prop of invalidProps) {
          allInvalidProperties.push({
            toolName: tool.name,
            propertyPath: prop.path,
            propertyKey: prop.key,
          });
        }
      }
    }

    if (allInvalidProperties.length > 0) {
      return {
        success: false,
        error: sanitizeMcpValidationFailure(allInvalidProperties, 'mcp-invalid-tool-schema'),
        errorType: 'invalid-schema' as const,
        invalidProperties: allInvalidProperties,
        tools: toolNames,
      };
    }

    return {
      success: true,
      tools: toolNames,
    };
  } catch (err) {
    const error = err as Error;
    debug('[stdio-validation] failed', { phase });

    const errorType: McpValidationResult['errorType'] = 'failed';
    let errorMessage: string;

    if (error.message.includes('ENOENT') || error.message.includes('not found')) {
      errorMessage = sanitizeMcpValidationFailure(error, 'mcp-command-not-found');
    } else if (error.message.includes('EACCES') || error.message.includes('permission denied')) {
      errorMessage = sanitizeMcpValidationFailure(error, 'mcp-command-permission-denied');
    } else if (error.message.includes('Timeout')) {
      // Phase split: connect timeouts are diagnostic, list-tools timeouts are not.
      if (phase === 'connect') {
        errorMessage = sanitizeMcpValidationFailure(
          error,
          error.message.includes('ceiling')
            ? 'mcp-initialize-ceiling-timeout'
            : 'mcp-initialize-idle-timeout',
        );
      } else if (phase === 'list-tools') {
        errorMessage = sanitizeMcpValidationFailure(error, 'mcp-tools-list-timeout');
      } else {
        errorMessage = sanitizeMcpValidationFailure(error, 'mcp-validation-timeout');
      }
    } else if (phase === 'connect') {
      errorMessage = sanitizeMcpValidationFailure(error, 'mcp-initialize-failed');
    } else {
      errorMessage = sanitizeMcpValidationFailure(error, 'mcp-validation-failed');
    }

    return {
      success: false,
      error: errorMessage,
      errorType,
    };
  } finally {
    await cleanup();
  }
}

/**
 * Get a user-friendly error message based on the validation result.
 * Accepts optional transport context to distinguish local (stdio) vs remote failures.
 */
export function getValidationErrorMessage(
  result: McpValidationResult,
  context?: { transport?: string }
): string {
  // Prefer the SDK's error field when available (most specific)
  if (result.error) return result.error;

  switch (result.errorType) {
    case 'failed':
      // Distinguish local stdio servers (crashed/not running) from remote (unreachable)
      if (context?.transport === 'stdio') {
        return 'Server process not running or failed to start.';
      }
      return 'Server unreachable - check the URL and your network.';
    case 'needs-auth':
      return 'Authentication expired or was revoked.';
    case 'pending':
      return 'Connection is still pending - try again.';
    case 'invalid-schema':
      return 'Server has tools with invalid property names.';
    case 'unknown':
    default:
      return 'Connection failed - check source configuration.';
  }
}
