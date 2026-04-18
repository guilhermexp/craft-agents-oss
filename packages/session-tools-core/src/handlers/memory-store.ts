import type { SessionToolContext } from '../context.ts';
import type { ToolResult } from '../types.ts';
import { successResponse, errorResponse } from '../response.ts';

export interface MemoryStoreArgs {
  action: 'add' | 'replace' | 'remove';
  target: 'agent' | 'user';
  category: 'profile' | 'event' | 'knowledge' | 'behavior' | 'skill';
  content?: string;
  old_text?: string;
  tags?: string[];
}

export async function handleMemoryStore(
  ctx: SessionToolContext,
  args: MemoryStoreArgs,
): Promise<ToolResult> {
  if (!ctx.memoryStore) {
    return errorResponse('Memory is not enabled. Set CRAFT_FEATURE_MEMORY=1 to enable.');
  }

  const { action, target, category, content, old_text, tags } = args;

  try {
    if (action === 'add') {
      if (!content) return errorResponse("'content' is required for 'add' action.");

      const { memory, wasReinforced } = await ctx.memoryStore(
        { action: 'upsert', target, category, content, tags }
      );
      const msg = wasReinforced
        ? `Memory reinforced (count: ${memory.reinforcementCount}).`
        : `Memory saved: "${content.substring(0, 60)}${content.length > 60 ? '...' : ''}"`;
      return successResponse(JSON.stringify({ success: true, message: msg, id: memory.id, reinforced: wasReinforced }));
    }

    if (action === 'replace') {
      if (!old_text) return errorResponse("'old_text' is required for 'replace' action.");
      if (!content) return errorResponse("'content' is required for 'replace' action.");

      const result = await ctx.memoryStore({ action: 'replace', target, old_text, content, tags });
      return successResponse(JSON.stringify({ success: true, message: 'Memory replaced.', result }));
    }

    if (action === 'remove') {
      if (!old_text) return errorResponse("'old_text' is required for 'remove' action.");

      const result = await ctx.memoryStore({ action: 'remove', target, old_text });
      return successResponse(JSON.stringify({ success: true, message: 'Memory removed.', result }));
    }

    return errorResponse(`Unknown action '${action}'.`);
  } catch (err) {
    return errorResponse(`Memory operation failed: ${err instanceof Error ? err.message : String(err)}`);
  }
}
