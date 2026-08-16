/**
 * Claude Context Factory
 *
 * Creates a SessionToolContext implementation for Claude with full access
 * to Electron internals, credential managers, MCP validation, etc.
 *
 * This enables the shared handlers in session-tools-core to work with
 * Claude's full feature set.
 */

import { existsSync, readFileSync, writeFileSync, readdirSync, statSync, mkdirSync } from 'fs';
import { join, basename } from 'path';
import { CONFIG_DIR } from '../config/paths.ts';
import type {
  SessionToolContext,
  SessionToolCallbacks,
  FileSystemInterface,
  CredentialManagerInterface,
  ValidatorInterface,
  LoadedSource,
  StdioMcpConfig,
  StdioValidationResult,
  HttpMcpConfig,
  McpValidationResult,
  ApiTestResult,
  SourceConfig,
  DeveloperFeedback,
} from '@craft-agent/session-tools-core';
import { validateConfigArtifact } from '../config/validators.ts';
import {
  validateMcpConnection as validateMcpConnectionImpl,
  validateStdioMcpConnection as validateStdioMcpConnectionImpl,
} from '../mcp/validation.ts';
import {
  loadSourceConfig as loadSourceConfigImpl,
  saveSourceConfig as saveSourceConfigImpl,
  getSourcePath,
} from '../sources/storage.ts';
import type { FolderSourceConfig, LoadedSource as SharedLoadedSource } from '../sources/types.ts';
import { getSourceCredentialManager } from '../sources/credential-manager.ts';
import {
  inferGoogleServiceFromUrl,
  inferSlackServiceFromUrl,
  inferMicrosoftServiceFromUrl,
  type GoogleService,
  type SlackServiceScope,
  type MicrosoftService,
} from '../sources/types.ts';
import { isGoogleOAuthConfigured as isGoogleOAuthConfiguredImpl } from '../auth/google-oauth.ts';
import { debug } from '../utils/debug.ts';
import { getSessionPlansPath, getSessionPath, getSessionDataPath } from '../sessions/storage.ts';
import { updatePreferences as updatePreferencesImpl } from '../config/preferences.ts';
import { executeWorkspaceObjectAction, WorkspaceObjectActionSchema } from '../workspace-objects/service.ts';

// Re-export types that may be needed by consumers
export type { SessionToolContext, SessionToolCallbacks } from '@craft-agent/session-tools-core';

/**
 * Options for creating a Claude context
 */
export interface ClaudeContextOptions {
  sessionId: string;
  workspacePath: string;
  workspaceId: string;
  onPlanSubmitted: (planPath: string) => void;
  onAuthRequest: (request: unknown) => void;
}

/**
 * Create a SessionToolContext for Claude with full capabilities.
 *
 * This provides:
 * - Full file system access
 * - Full Zod validators
 * - Credential manager with keychain access
 * - MCP connection validation
 * - Icon management
 */
export function createClaudeContext(options: ClaudeContextOptions): SessionToolContext {
  const { sessionId, workspacePath, workspaceId, onPlanSubmitted, onAuthRequest } = options;

  // File system implementation
  const fs: FileSystemInterface = {
    exists: (path: string) => existsSync(path),
    readFile: (path: string) => readFileSync(path, 'utf-8'),
    readFileBuffer: (path: string) => readFileSync(path),
    writeFile: (path: string, content: string) => writeFileSync(path, content, 'utf-8'),
    isDirectory: (path: string) => existsSync(path) && statSync(path).isDirectory(),
    readdir: (path: string) => readdirSync(path),
    stat: (path: string) => {
      const stats = statSync(path);
      return {
        size: stats.size,
        isDirectory: () => stats.isDirectory(),
      };
    },
  };

  // Callbacks implementation
  const callbacks: SessionToolCallbacks = {
    onPlanSubmitted,
    onAuthRequest: (request) => onAuthRequest(request),
  };

  // Validators implementation
  const validators: ValidatorInterface = {
    validate: validateConfigArtifact,
  };

  // Credential manager adapter
  const credentialManager: CredentialManagerInterface = {
    hasValidCredentials: async (source: LoadedSource): Promise<boolean> => {
      const mgr = getSourceCredentialManager();
      // Convert to shared type (guide not needed for credential operations)
      const sharedSource: SharedLoadedSource = {
        config: source.config as unknown as FolderSourceConfig,
        guide: null,
        folderPath: source.folderPath,
        workspaceRootPath: source.workspaceRootPath,
        workspaceId: source.workspaceId,
      };
      const token = await mgr.getToken(sharedSource);
      return !!token;
    },
    getToken: async (source: LoadedSource): Promise<string | null> => {
      const mgr = getSourceCredentialManager();
      const sharedSource: SharedLoadedSource = {
        config: source.config as unknown as FolderSourceConfig,
        guide: null,
        folderPath: source.folderPath,
        workspaceRootPath: source.workspaceRootPath,
        workspaceId: source.workspaceId,
      };
      return mgr.getToken(sharedSource);
    },
    refresh: async (source: LoadedSource): Promise<string | null> => {
      const mgr = getSourceCredentialManager();
      const sharedSource: SharedLoadedSource = {
        config: source.config as unknown as FolderSourceConfig,
        guide: null,
        folderPath: source.folderPath,
        workspaceRootPath: source.workspaceRootPath,
        workspaceId: source.workspaceId,
      };
      return mgr.refresh(sharedSource);
    },
  };

  // MCP validation
  const validateStdioMcpConnection = async (config: StdioMcpConfig): Promise<StdioValidationResult> => {
    try {
      const result = await validateStdioMcpConnectionImpl(config);
      return {
        success: result.success,
        error: result.error,
        toolCount: result.tools?.length,
        toolNames: result.tools,
        serverName: result.serverInfo?.name,
        serverVersion: result.serverInfo?.version,
      };
    } catch (error) {
      return { success: false, error: error instanceof Error ? error.message : 'Validation failed' };
    }
  };

  const validateMcpConnection = async (config: HttpMcpConfig): Promise<McpValidationResult> => {
    try {
      const result = await validateMcpConnectionImpl({
        mcpUrl: config.url,
        mcpTransport: config.transport,
        mcpHeaders: config.headers,
        mcpAccessToken: config.accessToken,
      });
      return {
        success: result.success,
        error: result.error,
        needsAuth: result.errorType === 'needs-auth',
        toolCount: result.tools?.length,
        toolNames: result.tools,
        serverName: result.serverInfo?.name,
        serverVersion: result.serverInfo?.version,
      };
    } catch (error) {
      return { success: false, error: error instanceof Error ? error.message : 'Validation failed' };
    }
  };

  // Build context
  const context: SessionToolContext = {
    sessionId,
    workspacePath,
    workspaceObjects: {
      execute: (input) => executeWorkspaceObjectAction(
        { workspaceId, workspaceRootPath: workspacePath },
        WorkspaceObjectActionSchema.parse(input),
      ) as unknown as Record<string, unknown>,
    },
    get sourcesPath() { return join(workspacePath, 'sources'); },
    get skillsPath() { return join(workspacePath, 'skills'); },
    plansFolderPath: getSessionPlansPath(workspacePath, sessionId),
    sessionPath: getSessionPath(workspacePath, sessionId),
    dataPath: getSessionDataPath(workspacePath, sessionId),
    callbacks,
    fs,
    validators,
    credentialManager,
    updatePreferences: (updates: Record<string, unknown>) => {
      updatePreferencesImpl(updates as any);
    },
    submitFeedback: (feedback: DeveloperFeedback) => {
      const feedbackDir = join(CONFIG_DIR, 'feedback');
      mkdirSync(feedbackDir, { recursive: true });
      const filePath = join(feedbackDir, `${feedback.id}.json`);
      writeFileSync(filePath, JSON.stringify(feedback, null, 2), 'utf-8');
      debug('claude-context', `Developer feedback written to ${filePath}`);
    },
    // Source management
    loadSourceConfig: (sourceSlug: string): SourceConfig | null => {
      const config = loadSourceConfigImpl(workspacePath, sourceSlug);
      return config as unknown as SourceConfig | null;
    },
    saveSourceConfig: (source: SourceConfig) => {
      saveSourceConfigImpl(workspacePath, source as unknown as FolderSourceConfig);
    },

    // Service inference
    inferGoogleService: (url?: string): GoogleService | undefined => {
      return inferGoogleServiceFromUrl(url);
    },
    inferSlackService: (url?: string): SlackServiceScope | undefined => {
      return inferSlackServiceFromUrl(url);
    },
    inferMicrosoftService: (url?: string): MicrosoftService | undefined => {
      return inferMicrosoftServiceFromUrl(url);
    },

    // OAuth config check
    isGoogleOAuthConfigured: (clientId?: string, clientSecret?: string): boolean => {
      return isGoogleOAuthConfiguredImpl(clientId, clientSecret);
    },

    // MCP validation
    validateStdioMcpConnection,
    validateMcpConnection,

    // Icon helpers (simplified - full implementation would use logo.ts)
    isIconUrl: (value: string): boolean => {
      try {
        const url = new URL(value);
        return url.protocol === 'http:' || url.protocol === 'https:';
      } catch {
        return false;
      }
    },

    deriveServiceUrl: (source: SourceConfig): string | null => {
      if (source.type === 'api' && source.api?.baseUrl) {
        try {
          const url = new URL(source.api.baseUrl);
          return `${url.protocol}//${url.hostname}`;
        } catch {
          return null;
        }
      }
      if (source.type === 'mcp' && source.mcp?.url) {
        try {
          const url = new URL(source.mcp.url);
          return `${url.protocol}//${url.hostname}`;
        } catch {
          return null;
        }
      }
      return null;
    },

    // Session self-management bindings are attached externally via
    // attachSessionSelfManagementBindings() — not part of the factory.
  };

  // Memory callbacks (injected when feature flag is on)
  // These are wired by the caller (ClaudeAgent) after context creation,
  // since they depend on the MemoryStore instance from BaseAgent.

  return context;
}

/**
 * Inject memory callbacks into an existing SessionToolContext.
 * Called by BaseAgent/ClaudeAgent when CRAFT_FEATURE_MEMORY is enabled.
 */
export function injectMemoryCallbacks(
  context: SessionToolContext,
  memoryStore: import('../memory/memory-store.ts').MemoryStore,
): void {
  context.memoryStore = async (params) => {
    if (params.action === 'upsert') {
      return memoryStore.upsert({
        target: params.target as 'agent' | 'user',
        category: (params.category ?? 'knowledge') as any,
        content: params.content ?? '',
        tags: params.tags,
      });
    }
    if (params.action === 'replace' && params.old_text && params.content) {
      const all = memoryStore.getByTarget(params.target as 'agent' | 'user');
      const match = all.find(m => m.content.includes(params.old_text!));
      if (!match) throw new Error(`No memory matched '${params.old_text}'`);
      memoryStore.delete(match.id);
      return memoryStore.upsert({
        target: params.target as 'agent' | 'user',
        category: (params.category ?? match.category) as any,
        content: params.content,
        tags: params.tags,
      });
    }
    if (params.action === 'remove' && params.old_text) {
      const all = memoryStore.getByTarget(params.target as 'agent' | 'user');
      const match = all.find(m => m.content.includes(params.old_text!));
      if (!match) throw new Error(`No memory matched '${params.old_text}'`);
      memoryStore.delete(match.id);
      return { memory: match as any, wasReinforced: false };
    }
    throw new Error(`Invalid memory action: ${params.action}`);
  };

  context.memoryRecall = async (params) => {
    return memoryStore.searchHybrid({
      query: params.query,
      target: params.target as any,
      category: params.category as any,
      limit: params.limit,
    });
  };
}
