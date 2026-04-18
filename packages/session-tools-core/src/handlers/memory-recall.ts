import type { SessionToolContext } from '../context.ts';
import type { ToolResult } from '../types.ts';
import { successResponse, errorResponse } from '../response.ts';

export interface MemoryRecallArgs {
  query: string;
  target?: 'agent' | 'user';
  category?: 'profile' | 'event' | 'knowledge' | 'behavior' | 'skill';
  limit?: number;
}

export async function handleMemoryRecall(
  ctx: SessionToolContext,
  args: MemoryRecallArgs,
): Promise<ToolResult> {
  if (!ctx.memoryRecall) {
    return errorResponse('Memory is not enabled. Set CRAFT_FEATURE_MEMORY=1 to enable.');
  }

  try {
    const results = await ctx.memoryRecall({
      query: args.query,
      target: args.target,
      category: args.category,
      limit: args.limit ?? 10,
    });

    if (results.length === 0) {
      return successResponse(JSON.stringify({ message: 'No memories found matching your query.', results: [] }));
    }

    const formatted = results.map((r: { memory: { content: string; target: string; category: string; tags: string[] }; salienceScore: number }) => ({
      content: r.memory.content,
      target: r.memory.target,
      category: r.memory.category,
      tags: r.memory.tags,
      score: r.salienceScore.toFixed(3),
    }));

    return successResponse(JSON.stringify({
      message: `Found ${results.length} memor${results.length === 1 ? 'y' : 'ies'}.`,
      results: formatted,
    }));
  } catch (err) {
    return errorResponse(`Memory recall failed: ${err instanceof Error ? err.message : String(err)}`);
  }
}
