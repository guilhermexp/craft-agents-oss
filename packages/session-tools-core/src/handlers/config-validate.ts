/**
 * Config Validate Handler
 *
 * Validates Craft Agent configuration files.
 * Uses full validators if available (Claude), otherwise basic validation (Codex).
 */

import { join } from 'node:path';
import { homedir } from 'node:os';

const AUTOMATIONS_CONFIG_FILE = 'automations.json';
import type { SessionToolContext, ConfigValidationKind } from '../context.ts';
import type { ToolResult } from '../types.ts';
import { successResponse, errorResponse } from '../response.ts';
import {
  formatValidationResult,
  validateJsonFileHasFields,
  mergeResults,
} from '../validation.ts';
import { getSourceConfigPath } from '../source-helpers.ts';

export interface ConfigValidateArgs {
  target: 'config' | 'sources' | 'statuses' | 'preferences' | 'permissions' | 'automations' | 'tool-icons' | 'all';
  sourceSlug?: string;
}

const CONFIG_VALIDATE_TARGET_TO_KIND: Record<ConfigValidateArgs['target'], ConfigValidationKind> = {
  config: 'config',
  sources: 'source',
  statuses: 'statuses',
  preferences: 'preferences',
  permissions: 'permissions',
  automations: 'automations',
  'tool-icons': 'tool-icons',
  all: 'all',
};

/**
 * Handle the config_validate tool call.
 *
 * If ctx.validators is available, uses full Zod validators.
 * Otherwise falls back to basic JSON field checking.
 */
export async function handleConfigValidate(
  ctx: SessionToolContext,
  args: ConfigValidateArgs
): Promise<ToolResult> {
  const { target, sourceSlug } = args;
  const craftAgentRoot = join(homedir(), '.craft-agent');

  // If full validators available (Claude), use them
  if (ctx.validators) {
    try {
      const kind = CONFIG_VALIDATE_TARGET_TO_KIND[target];
      const result = ctx.validators.validate(kind, { path: ctx.workspacePath }, { slug: sourceSlug });
      return successResponse(formatValidationResult(result));
    } catch (error) {
      return errorResponse(
        `Config validation failed: ${error instanceof Error ? error.message : 'Unknown error'}`
      );
    }
  }

  // Fallback: basic validation (Codex path)
  switch (target) {
    case 'config': {
      const result = validateJsonFileHasFields(
        join(craftAgentRoot, 'config.json'),
        ['workspaces']
      );
      return successResponse(formatValidationResult(result));
    }

    case 'sources': {
      if (sourceSlug) {
        const sourcePath = getSourceConfigPath(ctx.workspacePath, sourceSlug);
        const result = validateJsonFileHasFields(sourcePath, ['slug', 'name', 'type']);
        return successResponse(formatValidationResult(result));
      } else {
        // Validate all sources
        const sourcesDir = join(ctx.workspacePath, 'sources');
        if (!ctx.fs.exists(sourcesDir)) {
          return successResponse('✓ No sources directory (no sources to validate)');
        }

        const results = [];
        const entries = ctx.fs.readdir(sourcesDir);
        for (const entry of entries) {
          const entryPath = join(sourcesDir, entry);
          if (ctx.fs.isDirectory(entryPath)) {
            const sourceResult = validateJsonFileHasFields(
              join(entryPath, 'config.json'),
              ['slug', 'name', 'type']
            );
            if (!sourceResult.valid) {
              // Prefix errors with source name
              sourceResult.errors = sourceResult.errors.map(e => ({
                ...e,
                path: `${entry}/${e.path}`,
              }));
            }
            results.push(sourceResult);
          }
        }

        const merged = mergeResults(...results);
        return successResponse(formatValidationResult(merged));
      }
    }

    case 'statuses': {
      const result = validateJsonFileHasFields(
        join(ctx.workspacePath, 'statuses', 'config.json'),
        ['statuses']
      );
      return successResponse(formatValidationResult(result));
    }

    case 'preferences': {
      const result = validateJsonFileHasFields(
        join(craftAgentRoot, 'preferences.json'),
        []
      );
      return successResponse(formatValidationResult(result));
    }

    case 'permissions': {
      // Check workspace-level permissions.json
      const workspacePermsPath = join(ctx.workspacePath, 'permissions.json');
      if (!ctx.fs.exists(workspacePermsPath)) {
        return successResponse('✓ No workspace permissions.json (using defaults)');
      }
      const result = validateJsonFileHasFields(workspacePermsPath, []);
      return successResponse(formatValidationResult(result));
    }

    case 'automations': {
      const automationsPath = join(ctx.workspacePath, AUTOMATIONS_CONFIG_FILE);
      if (ctx.fs.exists(automationsPath)) {
        const result = validateJsonFileHasFields(automationsPath, []);
        return successResponse(formatValidationResult(result));
      }
      return successResponse(`✓ No ${AUTOMATIONS_CONFIG_FILE} (no automations configured)`);
    }

    case 'tool-icons': {
      const result = validateJsonFileHasFields(
        join(craftAgentRoot, 'tool-icons', 'tool-icons.json'),
        ['version', 'tools']
      );
      return successResponse(formatValidationResult(result));
    }

    case 'all': {
      const configResult = validateJsonFileHasFields(
        join(craftAgentRoot, 'config.json'),
        ['workspaces']
      );
      const prefsResult = validateJsonFileHasFields(
        join(craftAgentRoot, 'preferences.json'),
        []
      );
      const merged = mergeResults(configResult, prefsResult);
      return successResponse(formatValidationResult(merged));
    }

    default:
      return errorResponse(
        `Unknown validation target: ${target}. Valid targets: config, sources, statuses, preferences, permissions, automations, tool-icons, all`
      );
  }
}
