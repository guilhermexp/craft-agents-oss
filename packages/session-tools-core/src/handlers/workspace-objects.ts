import type { SessionToolContext } from '../context.ts';
import type { ToolResult } from '../types.ts';
import { errorResponse } from '../response.ts';

export type WorkspaceObjectsArgs = Record<string, unknown>;

export async function handleWorkspaceObjects(ctx: SessionToolContext, args: WorkspaceObjectsArgs): Promise<ToolResult> {
  if (!ctx.workspaceObjects) return errorResponse('Structured workspace objects are unavailable in this backend.');
  try {
    const result = await ctx.workspaceObjects.execute(args);
    return {
      content: [{ type: 'text', text: JSON.stringify(result) }],
      structuredContent: result,
      isError: false,
    };
  } catch (error) {
    return errorResponse(error instanceof Error ? error.message : String(error));
  }
}
