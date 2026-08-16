/**
 * Source Test Handler
 *
 * Validates and tests a source configuration comprehensively.
 * Performs schema validation, completeness checks, icon handling,
 * connection tests, and auth verification.
 */

import { realpathSync } from 'node:fs';
import { basename, join, resolve } from 'node:path';
import type { SessionToolContext } from '../context.ts';
import type {
  ToolResult,
  SourceConfig,
  ConnectionStatus,
} from '../types.ts';
import { errorResponse } from '../response.ts';
import {
  validateJsonFileHasFields,
  validateSourceConfigBasic,
} from '../validation.ts';
import {
  sourceExists,
  getSourceConfigPath,
  getSourceGuidePath,
  getSourcePath,
} from '../source-helpers.ts';
import {
  redactSourceTestFailure,
  redactSourceTestMetadata,
} from './source-test-sanitizer.ts';
import {
  resolveSourceReadiness,
  createUnsupportedSessionSourceReadiness,
  type SourceActivationReason,
} from './source-readiness.ts';

export interface SourceTestArgs {
  sourceSlug: string;
  /**
   * Auto-enable the source on success (flip `enabled: true` if needed
   * and activate it in the running session).
   * Defaults to `true`. Pass `false` for pure validation behavior.
   */
  autoEnable?: boolean;
}

/**
 * Test result structure for API/MCP connection tests
 */
interface ConnectionTestResult {
  success: boolean;
  status?: number;
  message: string;
  toolCount?: number;
  toolNames?: string[];
  serverName?: string;
  serverVersion?: string;
  needsAuth?: boolean;
  error?: string;
}

const sourceTestLifecycleTails = new Map<string, Promise<void>>();

/**
 * Distinct operator-facing message per activation stage. Kept separate from the
 * durable readiness reason so each failing stage reads differently while the
 * persisted config stays on the stable `backend-injection-failed` reason.
 */
const ACTIVATION_STAGE_MESSAGES: Record<SourceActivationReason, string> = {
  'exposure-failed': 'session exposure could not be established',
  'commit-failed': 'activation commit failed',
  'ready-persist-failed': 'ready state could not be persisted after activation',
};

function canonicalWorkspacePath(workspacePath: string): string {
  const absolutePath = resolve(workspacePath);
  try {
    return realpathSync.native(absolutePath);
  } catch {
    return absolutePath;
  }
}

async function withSourceTestLifecycleLock<T>(
  workspacePath: string,
  sourceSlug: string,
  run: () => Promise<T>,
): Promise<T> {
  const lockKey = `${canonicalWorkspacePath(workspacePath)}\0${sourceSlug}`;
  const previousTail = sourceTestLifecycleTails.get(lockKey);
  let releaseCurrent: () => void = () => {};
  const currentTail = new Promise<void>((resolveTail) => {
    releaseCurrent = resolveTail;
  });
  sourceTestLifecycleTails.set(lockKey, currentTail);

  if (previousTail) await previousTail;
  try {
    return await run();
  } finally {
    releaseCurrent();
    if (sourceTestLifecycleTails.get(lockKey) === currentTail) {
      sourceTestLifecycleTails.delete(lockKey);
    }
  }
}

/**
 * Handle the source_test tool call.
 *
 * Performs:
 * 1. Schema validation - validates config.json structure
 * 2. Icon handling - checks/downloads icon
 * 3. Completeness check - warns about missing guide.md/icon/tagline
 * 4. Connection test - tests if source endpoint is reachable
 * 5. Auth status check - verifies authentication
 * 6. Metadata update - updates lastTestedAt, connectionStatus
 */
export async function handleSourceTest(
  ctx: SessionToolContext,
  args: SourceTestArgs
): Promise<ToolResult> {
  return withSourceTestLifecycleLock(
    ctx.workspacePath,
    args.sourceSlug,
    () => handleSourceTestUnlocked(ctx, args),
  );
}

async function handleSourceTestUnlocked(
  ctx: SessionToolContext,
  args: SourceTestArgs
): Promise<ToolResult> {
  const { sourceSlug } = args;
  const lines: string[] = [];
  let hasErrors = false;
  let hasWarnings = false;
  let connectionStatus: ConnectionStatus = 'unknown';
  let connectionError: string | undefined;

  // 1. Check source exists
  if (!sourceExists(ctx.workspacePath, sourceSlug)) {
    return errorResponse(`Source '${sourceSlug}' not found in workspace.`);
  }

  // 2. Schema validation
  lines.push('## Schema Validation');
  const configPath = getSourceConfigPath(ctx.workspacePath, sourceSlug);
  const schemaResult = validateJsonFileHasFields(configPath, ['slug', 'name', 'type']);

  if (schemaResult.valid) {
    lines.push('✓ Config schema valid');
  } else {
    hasErrors = true;
    lines.push('✗ Config schema invalid:');
    for (const error of schemaResult.errors) {
      lines.push(`  - ${error.message}`);
    }
  }

  // 3. Load config for further checks
  const source = ctx.loadSourceConfig(sourceSlug);
  if (!source) {
    return errorResponse(`Failed to load source config for '${sourceSlug}'.`);
  }

  // Validate loaded config with basic validator
  const configValidation = validateSourceConfigBasic(source);
  if (!configValidation.valid) {
    hasErrors = true;
    for (const error of configValidation.errors) {
      lines.push(`  - ${error.path}: ${error.message}`);
    }
  }

  // 4. Icon handling
  lines.push('\n## Icon Status');
  const sourcePath = getSourcePath(ctx.workspacePath, sourceSlug);
  const iconResult = await handleIconCheck(ctx, sourcePath, sourceSlug, source);
  lines.push(...iconResult.lines);
  if (iconResult.hasWarning) hasWarnings = true;

  // 5. Completeness check
  lines.push('\n## Completeness Check');
  const completenessResult = checkCompleteness(ctx, sourcePath, source);
  lines.push(...completenessResult.lines);
  if (completenessResult.hasWarning) hasWarnings = true;

  // 6. Connection test
  lines.push('\n## Connection Test');
  const connectionResult = await testConnection(ctx, source, sourceSlug);
  lines.push(...connectionResult.lines);
  if (connectionResult.hasError) {
    hasErrors = true;
    connectionStatus = 'error';
    connectionError = connectionResult.error;
  } else if (connectionResult.success) {
    connectionStatus = 'connected';
  } else {
    // Soft failure (4xx ≠ 401/403, 5xx, etc): the probe reached the endpoint but
    // got a status we can't interpret as healthy. Demote validation to warnings
    // and refuse auto-activation — see #683 for what happens otherwise.
    connectionStatus = 'disconnected';
    hasWarnings = true;
  }

  // 7. Auth status
  lines.push('\n## Authentication');
  const authResult = await checkAuthStatus(ctx, source, sourceSlug);
  lines.push(...authResult.lines);
  if (authResult.hasWarning) hasWarnings = true;

  // 8. Auto-enable + metadata update
  // Defaults to true; pass autoEnable: false to keep pure validation behavior.
  // Gate on connectionStatus so a probe that returned 5xx/404 cannot push a
  // broken source into the live tool list. 401/403 still pass: the probe maps
  // those to connectionStatus=connected, and checkAuthStatus refreshes tokens.
  const autoEnable = args.autoEnable !== false;
  const requiresReadiness = (source.expectedTools?.length ?? 0) > 0;
  const testedAt = Date.now();

  if (requiresReadiness) {
    // Readiness sources declare intent here; source-readiness owns identity
    // validation, probe verdict, staged/ready persistence, activation ordering
    // and stable reason mapping. The connection gates above become its inputs.
    lines.push('\n## Session Tool Probe');
    // When no runtime seam is bound we still demote the source through a fallback
    // adapter that reports an unsupported backend, so a previously enabled/ready
    // source is persisted disabled/unhealthy rather than left untouched. Without a
    // way to persist (no saveSourceConfig) we cannot demote and must not claim
    // success — the source is simply reported unavailable.
    const session = ctx.sessionSourceReadiness
      ?? (ctx.saveSourceConfig
        ? createUnsupportedSessionSourceReadiness(ctx.saveSourceConfig)
        : undefined);
    if (!session) {
      hasErrors = true;
      lines.push('✗ Session readiness is unavailable; source remains disabled');
    } else {
      const outcome = await resolveSourceReadiness(
        {
          source,
          sourceTestPassed: !hasErrors && connectionStatus === 'connected',
          connectionStatus,
          autoEnable,
          checkedAt: testedAt,
        },
        session,
      );
      if (outcome.ready) {
        lines.push(`✓ Session observed ${outcome.observedTools.length} expected versioned tools`);
        lines.push('\n_Config updated with test results._');
        if (autoEnable) {
          if (source.enabled === false) lines.push('✓ Source auto-enabled in config');
          lines.push('✓ Source activated — the current turn will auto-restart with tools available');
        }
      } else {
        hasErrors = true;
        connectionStatus = 'unhealthy';
        connectionError = outcome.reason;
        // The persisted reason stays stable; the transient activation diagnostic
        // (when present) selects a distinct per-stage message for the operator.
        const detail = outcome.activationDiagnostic
          ? ACTIVATION_STAGE_MESSAGES[outcome.activationDiagnostic]
          : outcome.reason;
        lines.push(`✗ Session tool probe failed: ${detail}`);
      }
    }
  } else {
    // Legacy sources without expectedTools keep the metadata-save + next-turn
    // activation path unchanged.
    const shouldAutoEnable = autoEnable && !hasErrors && connectionStatus === 'connected';
    const willFlipEnabled = shouldAutoEnable && source.enabled === false;
    let configPersisted = ctx.saveSourceConfig === undefined;
    if (ctx.saveSourceConfig) {
      const updatedSource: SourceConfig = {
        ...source,
        lastTestedAt: testedAt,
        connectionStatus,
        connectionError,
        ...(willFlipEnabled ? { enabled: true } : {}),
      };
      try {
        ctx.saveSourceConfig(updatedSource);
        configPersisted = true;
        lines.push('\n_Config updated with test results._');
        if (willFlipEnabled) lines.push('✓ Source auto-enabled in config');
      } catch {
        hasWarnings = true;
        lines.push('⚠ Config could not be updated; session activation was skipped');
      }
    }

    if (shouldAutoEnable && configPersisted) {
      if (ctx.activateSourceInSession) {
        try {
          const result = await ctx.activateSourceInSession(sourceSlug);
          if (result.ok) {
            lines.push('✓ Source activated — the current turn will auto-restart with tools available');
          } else {
            const reason = redactSourceTestFailure(result.reason, 'source-activation-failed');
            lines.push(`⚠ Config updated, but session activation failed: ${reason}. Restart session to load tools.`);
            hasWarnings = true;
          }
        } catch (caught) {
          const reason = redactSourceTestFailure(caught, 'source-activation-exception');
          lines.push(`⚠ Config updated, but session activation threw: ${reason}. Restart session to load tools.`);
          hasWarnings = true;
        }
      } else if (willFlipEnabled) {
        lines.push('ℹ Config updated. Restart session to load tools (mid-session activation not available in this backend).');
      }
    }
  }

  if (autoEnable && !hasErrors && connectionStatus !== 'connected') {
    // The user asked to auto-enable but the connection probe didn't pass.
    // Tell them why activation is being skipped so they can act on it.
    lines.push(`ℹ Skipping activation because connection test did not succeed (status: ${connectionStatus}). Re-run source_test once the endpoint is reachable.`);
  }

  // Summary
  lines.push('\n---');
  if (hasErrors) {
    lines.push('**Result: ✗ Validation failed with errors**');
  } else if (hasWarnings) {
    lines.push('**Result: ⚠ Validation passed with warnings**');
  } else {
    lines.push('**Result: ✓ Validation passed**');
  }

  return {
    content: [{ type: 'text', text: lines.join('\n') }],
    isError: hasErrors,
  };
}

// ============================================================
// Icon Handling
// ============================================================

async function handleIconCheck(
  ctx: SessionToolContext,
  sourcePath: string,
  sourceSlug: string,
  source: SourceConfig
): Promise<{ lines: string[]; hasWarning: boolean }> {
  const lines: string[] = [];
  let hasWarning = false;

  // Check for local icon files
  const iconPngPath = join(sourcePath, 'icon.png');
  const iconSvgPath = join(sourcePath, 'icon.svg');
  const iconJpgPath = join(sourcePath, 'icon.jpg');

  const hasLocalIcon =
    ctx.fs.exists(iconPngPath) ||
    ctx.fs.exists(iconSvgPath) ||
    ctx.fs.exists(iconJpgPath);

  if (hasLocalIcon) {
    const format = ctx.fs.exists(iconPngPath) ? 'PNG' : ctx.fs.exists(iconSvgPath) ? 'SVG' : 'JPG';
    lines.push(`✓ Icon file exists (${format})`);
    return { lines, hasWarning };
  }

  // Check if icon is a URL that can be downloaded
  if (source.icon && ctx.isIconUrl && ctx.isIconUrl(source.icon)) {
    if (ctx.downloadSourceIcon) {
      lines.push('ℹ Configured icon URL detected');
      try {
        const cachedPath = await ctx.downloadSourceIcon(sourceSlug, source.icon);
        if (cachedPath) {
          lines.push(`✓ Icon downloaded and cached`);
          return { lines, hasWarning };
        }
      } catch (caught) {
        lines.push(`⚠ Failed to download icon: ${redactSourceTestFailure(caught, 'icon-download-failed')}`);
        hasWarning = true;
      }
    } else {
      lines.push('ℹ Icon URL configured but download not available');
    }
  }

  // Check if icon is an emoji
  if (source.icon && isEmoji(source.icon)) {
    lines.push(`✓ Emoji icon configured: ${source.icon}`);
    return { lines, hasWarning };
  }

  // Try to auto-fetch icon from service
  if (!source.icon && ctx.deriveServiceUrl && ctx.getHighQualityLogoUrl && ctx.downloadIcon) {
    const serviceUrl = ctx.deriveServiceUrl(source);
    if (serviceUrl) {
      lines.push(`ℹ Attempting to auto-fetch icon from service URL...`);
      try {
        const logoUrl = await ctx.getHighQualityLogoUrl(serviceUrl, sourceSlug);
        if (logoUrl) {
          const destPath = join(sourcePath, 'icon.png');
          const downloaded = await ctx.downloadIcon(destPath, logoUrl, sourceSlug);
          if (downloaded) {
            lines.push(`✓ Icon auto-fetched and saved`);
            return { lines, hasWarning };
          }
        }
      } catch {
        // Silently continue if auto-fetch fails
      }
    }
  }

  // No icon found
  hasWarning = true;
  lines.push('⚠ No icon configured');
  lines.push('  Options:');
  lines.push('  - Add icon.png or icon.svg to source folder');
  lines.push('  - Set "icon" field to a URL or emoji in config.json');
  if (source.type === 'api' && source.api?.baseUrl) {
    lines.push(`  - Icon may be auto-fetched from ${new URL(source.api.baseUrl).hostname}`);
  }

  return { lines, hasWarning };
}

/**
 * Simple emoji detection
 */
function isEmoji(str: string): boolean {
  // Check if string is a single emoji (basic heuristic)
  const emojiRegex = /^[\p{Emoji}]$/u;
  return emojiRegex.test(str) || (str.length >= 2 && str.length <= 8 && /[\u{1F300}-\u{1FAD6}]/u.test(str));
}

// ============================================================
// Completeness Check
// ============================================================

function checkCompleteness(
  ctx: SessionToolContext,
  sourcePath: string,
  source: SourceConfig
): { lines: string[]; hasWarning: boolean } {
  const lines: string[] = [];
  let hasWarning = false;

  // Check guide.md
  const guidePath = getSourceGuidePath(ctx.workspacePath, source.slug);
  if (!ctx.fs.exists(guidePath)) {
    hasWarning = true;
    lines.push('⚠ No guide.md file');
    lines.push('  Recommended: Add guide.md with usage instructions for the agent');
  } else {
    try {
      const guideContent = ctx.fs.readFile(guidePath);
      const guideSize = guideContent.length;
      const wordCount = guideContent.split(/\s+/).filter(Boolean).length;
      lines.push(`✓ guide.md exists (${wordCount} words, ${formatBytes(guideSize)})`);

      if (wordCount < 50) {
        lines.push('  ℹ Guide is short - consider adding more context');
      }
    } catch {
      lines.push('✓ guide.md exists');
    }
  }

  // Check tagline field
  if (!source.tagline) {
    // Check if they used 'description' instead (common mistake)
    if ((source as unknown as Record<string, unknown>)['description']) {
      hasWarning = true;
      lines.push('⚠ Found "description" field instead of "tagline"');
      lines.push('  Rename "description" to "tagline" in config.json');
    } else {
      hasWarning = true;
      lines.push('⚠ No tagline configured');
      lines.push('  Add "tagline": "Brief description" to config.json');
    }
  } else {
    lines.push(`✓ Tagline: "${source.tagline}"`);
    if (source.tagline.length > 100) {
      lines.push('  ℹ Tagline is long - consider shortening to < 100 chars');
    }
  }

  // Check name
  if (source.name) {
    lines.push(`✓ Name: "${source.name}"`);
  }

  return { lines, hasWarning };
}

function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} bytes`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

// ============================================================
// Connection Test
// ============================================================

async function testConnection(
  ctx: SessionToolContext,
  source: SourceConfig,
  sourceSlug: string
): Promise<{ lines: string[]; success: boolean; hasError: boolean; error?: string }> {
  const lines: string[] = [];
  let success = false;
  let hasError = false;
  let error: string | undefined;

  if (source.type === 'api') {
    const result = await testApiConnection(ctx, source, sourceSlug);
    lines.push(...result.lines);
    success = result.success;
    hasError = result.hasError;
    error = result.error;
  } else if (source.type === 'mcp') {
    const result = await testMcpConnection(ctx, source, sourceSlug);
    lines.push(...result.lines);
    success = result.success;
    hasError = result.hasError;
    error = result.error;
  } else if (source.type === 'filesystem') {
    const result = testLocalConnection(ctx, source);
    lines.push(...result.lines);
    success = result.success;
    hasError = result.hasError;
    error = result.error;
  } else {
    lines.push('ℹ No connection test available for this source type');
    success = true;
  }

  return { lines, success, hasError, error };
}

async function testApiConnection(
  ctx: SessionToolContext,
  source: SourceConfig,
  sourceSlug: string
): Promise<{ lines: string[]; success: boolean; hasError: boolean; error?: string }> {
  const lines: string[] = [];
  let success = false;
  let hasError = false;
  let error: string | undefined;

  if (!source.api?.baseUrl) {
    lines.push('✗ No API base URL configured');
    hasError = true;
    error = 'No base URL';
    return { lines, success, hasError, error };
  }

  // If ctx has advanced testApiSource, use it
  if (ctx.testApiSource) {
    try {
      const result = await ctx.testApiSource(source);
      if (result.success) {
        success = true;
        lines.push(`✓ API endpoint reachable`);
        if (result.status) {
          lines.push(`  Status: ${result.status}`);
        }
      } else {
        hasError = true;
        error = redactSourceTestFailure(result.error, 'api-validation-failed');
        lines.push(`✗ ${error}`);
      }
      return { lines, success, hasError, error };
    } catch (e) {
      // Fall through to built-in test
    }
  }

  // Build test URL
  const testUrl = source.api.testEndpoint
    ? `${source.api.baseUrl}${source.api.testEndpoint.path}`
    : source.api.baseUrl;

  // Try authenticated request if credentials available
  if (source.isAuthenticated && ctx.credentialManager && source.api.authType !== 'none') {
    const authResult = await testApiConnectionWithAuth(ctx, source, sourceSlug, testUrl);
    if (authResult.attempted) {
      return authResult;
    }
    // If auth test wasn't attempted (no token), fall through to basic test
  }

  // Basic connection test (no auth)
  return testApiConnectionBasic(source, testUrl);
}

/**
 * Test API connection WITH authentication credentials.
 * Returns attempted=false if credentials couldn't be retrieved.
 */
async function testApiConnectionWithAuth(
  ctx: SessionToolContext,
  source: SourceConfig,
  sourceSlug: string,
  testUrl: string
): Promise<{ lines: string[]; success: boolean; hasError: boolean; error?: string; attempted: boolean }> {
  const lines: string[] = [];

  // Build LoadedSource for credential manager
  const workspaceId = basename(ctx.workspacePath) || '';
  const loadedSource = {
    config: source,
    folderPath: getSourcePath(ctx.workspacePath, sourceSlug),
    workspaceRootPath: ctx.workspacePath,
    workspaceId,
  };

  // Get token from credential manager
  let token: string | null = null;
  try {
    token = await ctx.credentialManager!.getToken(loadedSource);
  } catch {
    // Couldn't get token, will fall through to basic test
  }

  if (!token) {
    return { lines: [], success: false, hasError: false, attempted: false };
  }

  // Build auth headers based on authType
  const headers: Record<string, string> = {};
  let urlWithAuth = testUrl;

  switch (source.api!.authType) {
    case 'bearer':
    case 'oauth':
      // Generic OAuth tokens are sent as Bearer tokens
      headers['Authorization'] = `Bearer ${token}`;
      break;
    case 'basic': {
      // Vault value for source_basic is JSON `{"username","password"}` (written by
      // source_credential_prompt / WebUI). Parse and base64-encode to match what
      // api-tools.ts buildHeaders does at runtime. Fall through if the token is
      // already a non-JSON string (legacy / hand-edited vault entries).
      try {
        const parsed = JSON.parse(token);
        if (parsed && typeof parsed === 'object' && parsed.username && parsed.password) {
          const encoded = Buffer.from(`${parsed.username}:${parsed.password}`).toString('base64');
          headers['Authorization'] = `Basic ${encoded}`;
          break;
        }
      } catch {
        // Not JSON — pass through
      }
      headers['Authorization'] = `Basic ${token}`;
      break;
    }
    case 'header':
      // Custom header name
      if (source.api!.headerName) {
        headers[source.api!.headerName] = token;
      } else if (source.api!.headerNames && source.api!.headerNames.length > 0) {
        // Multi-header auth: token is JSON with header values
        const headerNames = source.api!.headerNames;
        try {
          const headerValues = JSON.parse(token) as Record<string, string>;
          for (const headerName of headerNames) {
            if (headerValues[headerName]) {
              headers[headerName] = headerValues[headerName];
            }
          }
        } catch {
          // Token is not valid JSON - this is a configuration error for multi-header auth
          const firstHeader = headerNames[0] || 'Header';
          return {
            lines: [`✗ Multi-header auth requires JSON token with header values`],
            success: false,
            hasError: true,
            error: `Expected JSON token like {"${firstHeader}": "value"} but got non-JSON string`,
            attempted: true,
          };
        }
      } else {
        // Fallback to X-API-Key if no header name specified
        headers['X-API-Key'] = token;
      }
      break;
    case 'query':
      // Add token as query parameter
      const paramName = source.api!.queryParam || 'api_key';
      const separator = testUrl.includes('?') ? '&' : '?';
      urlWithAuth = `${testUrl}${separator}${paramName}=${encodeURIComponent(token)}`;
      break;
  }

  // Make authenticated request
  try {
    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), 10000);

    const method = source.api!.testEndpoint?.method || 'GET';
    const body = source.api!.testEndpoint?.body;
    const extraHeaders = source.api!.testEndpoint?.headers;

    // Merge any per-endpoint headers; auth headers win on conflict so a stale
    // testEndpoint header can't shadow the live token.
    if (extraHeaders) {
      for (const [k, v] of Object.entries(extraHeaders)) {
        if (!(k in headers)) headers[k] = v;
      }
    }

    const init: RequestInit = { method, headers, signal: controller.signal };
    if (body !== undefined && method !== 'GET') {
      init.body = typeof body === 'string' ? body : JSON.stringify(body);
      // Default to JSON only if no Content-Type was provided by testEndpoint.headers.
      const hasContentType = Object.keys(headers).some((k) => k.toLowerCase() === 'content-type');
      if (!hasContentType) headers['Content-Type'] = 'application/json';
    }

    const response = await fetch(urlWithAuth, init);

    clearTimeout(timeoutId);

    if (response.ok) {
      lines.push(`✓ API connection successful (authenticated)`);
      lines.push(`  Status: ${response.status}`);
      return { lines, success: true, hasError: false, attempted: true };
    } else if (response.status === 401 || response.status === 403) {
      lines.push(`✗ API returned ${response.status} (credentials invalid or expired)`);
      lines.push('  Re-authenticate the source to refresh credentials');
      return { lines, success: false, hasError: true, error: 'api-auth-failed', attempted: true };
    } else if (response.status === 404) {
      lines.push(`⚠ API returned 404 (endpoint not found)`);
      if (source.api!.testEndpoint) {
        lines.push('  Check whether the configured test endpoint path is correct');
      }
      return { lines, success: false, hasError: false, attempted: true };
    } else {
      lines.push(`⚠ API returned ${response.status}`);
      return { lines, success: false, hasError: false, attempted: true };
    }
  } catch (caught) {
    const errorCode = redactSourceTestFailure(caught, 'api-connection-failed');
    lines.push(`✗ Connection failed: ${errorCode}`);
    return { lines, success: false, hasError: true, error: errorCode, attempted: true };
  }
}

/**
 * Basic API connection test WITHOUT authentication.
 * Used when no credentials are available.
 */
async function testApiConnectionBasic(
  source: SourceConfig,
  testUrl: string
): Promise<{ lines: string[]; success: boolean; hasError: boolean; error?: string }> {
  const lines: string[] = [];
  let success = false;
  let hasError = false;
  let error: string | undefined;

  try {
    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), 10000);

    // If a testEndpoint.method was configured, honor it directly. The HEAD→GET
    // probe can't validate POST-only endpoints (it 405s, falls back to GET, and
    // typically gets another 405 the basic probe silently treats as soft pass).
    // We deliberately don't carry testEndpoint.body in the basic probe — this
    // path runs without credentials, so anything sensitive in the body would
    // leak; better to let the authed probe carry the body once auth is set up.
    const configuredMethod = source.api?.testEndpoint?.method;
    let response: Response | null;
    if (configuredMethod) {
      response = await fetch(testUrl, {
        method: configuredMethod,
        signal: controller.signal,
      }).catch(() => null);
    } else {
      // Try HEAD first
      response = await fetch(testUrl, {
        method: 'HEAD',
        signal: controller.signal,
      }).catch(() => null);

      // If HEAD returns 405, try GET
      if (response && response.status === 405) {
        response = await fetch(testUrl, {
          method: 'GET',
          signal: controller.signal,
        }).catch(() => null);
      }
    }

    clearTimeout(timeoutId);

    if (response) {
      if (response.ok) {
        success = true;
        lines.push('✓ API endpoint reachable');
      } else if (response.status === 401 || response.status === 403) {
        // Auth required - endpoint is reachable but needs credentials
        success = true;
        lines.push(`⚠ API returned ${response.status} (authentication required)`);
        if (!source.isAuthenticated) {
          lines.push('  Authenticate the source to test with credentials');
        } else {
          lines.push('  Source is marked authenticated but credentials could not be retrieved');
        }
      } else if (response.status === 404) {
        lines.push(`⚠ API returned 404 (endpoint not found)`);
        if (source.api?.testEndpoint) {
          lines.push('  Check whether the configured test endpoint path is correct');
        } else {
          lines.push('  Consider adding testEndpoint configuration');
        }
      } else {
        lines.push(`⚠ API returned ${response.status}`);
      }
    } else {
      hasError = true;
      error = 'Connection failed';
      lines.push('✗ Cannot reach configured API endpoint');
      lines.push('  Check if the URL is correct and the service is running');
    }
  } catch (caught) {
    hasError = true;
    error = redactSourceTestFailure(caught, 'api-connection-failed');
    lines.push(`✗ Connection failed: ${error}`);
  }

  return { lines, success, hasError, error };
}

async function testMcpConnection(
  ctx: SessionToolContext,
  source: SourceConfig,
  sourceSlug: string
): Promise<{ lines: string[]; success: boolean; hasError: boolean; error?: string }> {
  const lines: string[] = [];
  let success = false;
  let hasError = false;
  let error: string | undefined;

  if (source.mcp?.transport === 'stdio') {
    // Stdio MCP - use validateStdioMcpConnection if available
    if (ctx.validateStdioMcpConnection && source.mcp.command) {
      lines.push('ℹ Testing configured stdio MCP server');
      try {
        const result = await ctx.validateStdioMcpConnection({
          command: source.mcp.command,
          args: source.mcp.args || [],
          env: source.mcp.env,
        });
        if (result.success) {
          success = true;
          lines.push(`✓ MCP server started successfully`);
          if (result.toolCount !== undefined) {
            lines.push(`  Tools available: ${result.toolCount}`);
            if (result.toolNames && result.toolNames.length > 0) {
              const safeToolNames = result.toolNames.flatMap((name) => {
                const safeName = redactSourceTestMetadata(name);
                return safeName === undefined ? [] : [safeName];
              });
              const preview = safeToolNames.slice(0, 5).join(', ');
              if (safeToolNames.length > 5) {
                lines.push(`  Examples: ${preview}, ...`);
              } else if (preview.length > 0) {
                lines.push(`  Tools: ${preview}`);
              }
            }
          }
          const safeServerName = redactSourceTestMetadata(result.serverName);
          const safeServerVersion = redactSourceTestMetadata(result.serverVersion);
          if (safeServerName) {
            lines.push(`  Server: ${safeServerName}${safeServerVersion ? ` v${safeServerVersion}` : ''}`);
          }
        } else {
          hasError = true;
          error = redactSourceTestFailure(result.error, 'mcp-validation-failed');
          lines.push(`✗ ${error}`);
        }
      } catch (caught) {
        hasError = true;
        error = redactSourceTestFailure(caught, 'mcp-validation-failed');
        lines.push(`✗ Failed to test MCP server: ${error}`);
      }
    } else if (source.mcp?.command) {
      // Basic check - just report config
      lines.push('ℹ Configured stdio MCP source');
      lines.push('  Connection test not available in this context — call the source\'s MCP tools directly to verify');
      success = true; // Config looks ok
    } else {
      hasError = true;
      error = 'No command configured';
      lines.push('✗ No command configured for stdio MCP source');
    }
  } else if (source.mcp?.url) {
    // HTTP/SSE MCP
    if (ctx.validateMcpConnection) {
      lines.push('ℹ Testing configured MCP server');
      try {
        // Merge static headers with credential-store headers (if headerNames configured)
        let headers = source.mcp.headers ? { ...source.mcp.headers } : undefined;
        let accessToken: string | undefined;
        if (ctx.credentialManager) {
          const workspaceId = basename(ctx.workspacePath) || '';
          const loadedSource = {
            config: source,
            folderPath: getSourcePath(ctx.workspacePath, sourceSlug),
            workspaceRootPath: ctx.workspacePath,
            workspaceId,
          };

          if (source.mcp.headerNames?.length) {
            // Multi-header credential — credential value is JSON keyed by header name.
            try {
              const rawCred = await ctx.credentialManager.getToken(loadedSource);
              if (rawCred) {
                const parsed = JSON.parse(rawCred) as Record<string, string>;
                headers = { ...headers, ...parsed };
              }
            } catch {
              // Not JSON or no credential — continue without credential headers
            }
          } else if (source.mcp.authType === 'oauth' || source.mcp.authType === 'bearer') {
            // OAuth / bearer single-token path — mirror the runtime so the probe
            // sends an Authorization header. Cached token first, refresh fallback
            // only on miss (matches checkAuthStatus and TokenRefreshManager).
            try {
              accessToken =
                (await ctx.credentialManager.getToken(loadedSource)) ??
                (await ctx.credentialManager.refresh(loadedSource)) ??
                undefined;
            } catch {
              // Token resolution failed — fall through; the probe will surface
              // the resulting `needsAuth` / 401 the same way it always has.
            }
          }
        }
        const result = await ctx.validateMcpConnection({
          url: source.mcp.url,
          transport: source.mcp.transport,
          authType: source.mcp.authType,
          headers,
          accessToken,
        });
        if (result.success) {
          success = true;
          lines.push(`✓ MCP server connected`);
          if (result.toolCount !== undefined) {
            lines.push(`  Tools available: ${result.toolCount}`);
          }
          const safeServerName = redactSourceTestMetadata(result.serverName);
          const safeServerVersion = redactSourceTestMetadata(result.serverVersion);
          if (safeServerName) {
            lines.push(`  Server: ${safeServerName}${safeServerVersion ? ` v${safeServerVersion}` : ''}`);
          }
        } else if (result.needsAuth) {
          lines.push(`⚠ MCP server requires authentication`);
          if (source.mcp.authType === 'oauth') {
            lines.push('  Use source_oauth_trigger to authenticate');
          }
          success = true; // Server is reachable, just needs auth
        } else {
          hasError = true;
          error = redactSourceTestFailure(result.error, 'mcp-validation-failed');
          lines.push(`✗ ${error}`);
        }
      } catch (caught) {
        hasError = true;
        error = redactSourceTestFailure(caught, 'mcp-validation-failed');
        lines.push(`✗ Failed to connect to MCP server: ${error}`);
      }
    } else {
      // Basic URL check
      lines.push('ℹ Configured MCP source endpoint');
      lines.push('  Connection test not available in this context — call the source\'s MCP tools directly to verify');
      success = true; // Config looks ok
    }
  } else {
    hasError = true;
    error = 'No MCP URL or command configured';
    lines.push('✗ No MCP URL or command configured');
  }

  return { lines, success, hasError, error };
}

function testLocalConnection(
  ctx: SessionToolContext,
  source: SourceConfig
): { lines: string[]; success: boolean; hasError: boolean; error?: string } {
  const lines: string[] = [];
  let success = false;
  let hasError = false;
  let error: string | undefined;

  if (!source.local?.path) {
    hasError = true;
    error = 'No local path configured';
    lines.push('✗ No local path configured');
    return { lines, success, hasError, error };
  }

  if (ctx.fs.exists(source.local.path)) {
    success = true;
    const isDir = ctx.fs.isDirectory(source.local.path);
    lines.push(`✓ Local path exists: ${source.local.path}`);
    lines.push(`  Type: ${isDir ? 'Directory' : 'File'}`);
  } else {
    hasError = true;
    error = 'Path not found';
    lines.push(`✗ Local path not found: ${source.local.path}`);
    lines.push('  Verify the path exists and is accessible');
  }

  return { lines, success, hasError, error };
}

// ============================================================
// Auth Status Check
// ============================================================

async function checkAuthStatus(
  ctx: SessionToolContext,
  source: SourceConfig,
  sourceSlug: string
): Promise<{ lines: string[]; hasWarning: boolean }> {
  const lines: string[] = [];
  let hasWarning = false;

  if (source.isAuthenticated) {
    // In Codex context (no validateMcpConnection), MCP source credentials are delivered
    // via config.toml headers, not the credential cache. Skip token verification to avoid
    // false "token missing" warnings from the file-based cache.
    if (source.type === 'mcp' && !ctx.validateMcpConnection) {
      lines.push('✓ Source is authenticated');
    } else if (ctx.credentialManager) {
      const workspaceId = basename(ctx.workspacePath) || '';
      const loadedSource = {
        config: source,
        folderPath: getSourcePath(ctx.workspacePath, sourceSlug),
        workspaceRootPath: ctx.workspacePath,
        workspaceId,
      };

      try {
        const token = await ctx.credentialManager.getToken(loadedSource);
        if (token) {
          lines.push('✓ Source is authenticated (token valid)');
        } else {
          // Token missing or expired — attempt refresh before reporting failure.
          // OAuth tokens are short-lived (typically 1h) and frequently expired in the
          // credential store between uses. The normal connection pipeline refreshes
          // them proactively, so source_test should too.
          const refreshed = await ctx.credentialManager.refresh(loadedSource);
          if (refreshed) {
            lines.push('✓ Source is authenticated (token refreshed)');
          } else {
            hasWarning = true;
            lines.push('⚠ Source marked authenticated but token missing or refresh failed');
            lines.push('  Re-authenticate to refresh credentials');
          }
        }
      } catch {
        lines.push('✓ Source is authenticated');
      }
    } else {
      lines.push('✓ Source is authenticated');
    }
  } else {
    // Determine required auth type
    if (source.type === 'mcp' && source.mcp?.authType === 'oauth') {
      hasWarning = true;
      lines.push('⚠ Source not authenticated');
      lines.push('  Use source_oauth_trigger to authenticate');
    } else if (source.type === 'api') {
      if (source.provider === 'google') {
        hasWarning = true;
        lines.push('⚠ Source not authenticated');
        lines.push('  Use source_google_oauth_trigger to authenticate');
      } else if (source.provider === 'slack') {
        hasWarning = true;
        lines.push('⚠ Source not authenticated');
        lines.push('  Use source_slack_oauth_trigger to authenticate');
      } else if (source.provider === 'microsoft') {
        hasWarning = true;
        lines.push('⚠ Source not authenticated');
        lines.push('  Use source_microsoft_oauth_trigger to authenticate');
      } else if (source.api?.authType && source.api.authType !== 'none') {
        hasWarning = true;
        lines.push('⚠ Source not authenticated');
        lines.push('  Use source_credential_prompt to enter credentials');
      } else {
        lines.push('ℹ Source does not require authentication');
      }
    } else {
      lines.push('ℹ Source does not require authentication');
    }
  }

  return { lines, hasWarning };
}
