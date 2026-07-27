/**
 * Spawn Session Tool (spawn_session)
 *
 * Session-scoped tool that enables the main agent to create independent sessions
 * with configurable connection, model, sources, and an initial prompt.
 *
 * Two modes:
 * - help=true: Returns available connections, models, and sources
 * - Default: Creates a session and sends the prompt (fire-and-forget)
 */

import { tool } from '@anthropic-ai/claude-agent-sdk';
import { SpawnSessionSchema, TOOL_DESCRIPTIONS } from '@craft-agent/session-tools-core';
import type { ZodRawShape } from 'zod';
import type { SpawnSessionResult, SpawnSessionHelpResult } from './base-agent.ts';

export type SpawnSessionFn = (input: Record<string, unknown>) => Promise<SpawnSessionResult | SpawnSessionHelpResult>;

// Tool result type - matches what the SDK expects
type ToolResult = {
  content: Array<{ type: 'text'; text: string }>;
  isError?: boolean;
};

function errorResponse(message: string): ToolResult {
  return {
    content: [{ type: 'text', text: `Error: ${message}` }],
    isError: true,
  };
}

export interface SpawnSessionToolOptions {
  sessionId: string;
  /**
   * Lazy resolver for the spawn session callback.
   * Called at execution time to get the current callback from the session registry.
   */
  getSpawnSessionFn: () => SpawnSessionFn | undefined;
}

export function createSpawnSessionTool(options: SpawnSessionToolOptions) {
  return tool(
    'spawn_session',
    TOOL_DESCRIPTIONS.spawn_session,
    // session-tools-core is pinned to zod v3; the Claude SDK's tool() types expect
    // a zod v4 shape. The shape is valid at runtime; bridge the compile-time gap
    // and re-validate through the canonical schema.
    SpawnSessionSchema.shape as unknown as ZodRawShape,
    async (rawArgs) => {
      const args = SpawnSessionSchema.parse(rawArgs);
      const spawnFn = options.getSpawnSessionFn();
      if (!spawnFn) {
        return errorResponse('spawn_session is not available in this context.');
      }

      try {
        const result = await spawnFn(args as Record<string, unknown>);
        return {
          content: [{ type: 'text' as const, text: JSON.stringify(result, null, 2) }],
        };
      } catch (error) {
        if (error instanceof Error) {
          return errorResponse(`spawn_session failed: ${error.message}`);
        }
        throw error;
      }
    }
  );
}
