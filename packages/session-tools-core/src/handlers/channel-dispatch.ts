import type { SessionToolContext } from '../context.ts';
import type { ToolResult } from '../types.ts';
import { errorResponse } from '../response.ts';

export interface ChannelDispatchArgs {
  participantId: string;
  message: string;
  channelId?: string;
  parentMessageId?: string;
}

export async function handleChannelDispatch(
  ctx: SessionToolContext,
  args: ChannelDispatchArgs,
): Promise<ToolResult> {
  if (!ctx.channelDispatch) {
    return errorResponse('channel_dispatch is not available in this context.');
  }

  if (!args.participantId?.trim()) {
    return errorResponse('participantId is required.');
  }

  if (!args.message?.trim()) {
    return errorResponse('message is required.');
  }

  try {
    const result = await ctx.channelDispatch({
      participantId: args.participantId.trim(),
      message: args.message.trim(),
      channelId: args.channelId?.trim() || undefined,
      parentMessageId: args.parentMessageId?.trim() || undefined,
    });
    return {
      content: [{ type: 'text', text: JSON.stringify(result, null, 2) }],
      ...(result.status === 'failed' ? { isError: true } : {}),
    };
  } catch (error) {
    const message = error instanceof Error ? error.message : 'Unknown error';
    return errorResponse(`channel_dispatch failed: ${message}`);
  }
}
