import { randomUUID } from 'crypto';
import { appendFileSync, existsSync, mkdirSync, readFileSync } from 'fs';
import { join } from 'path';

const CHANNEL_MESSAGES_DIR = 'channels/messages';

export type ChannelMessageAuthorType = 'user' | 'agent' | 'system';

export interface ChannelMessage {
  id: string;
  channelId: string;
  authorType: ChannelMessageAuthorType;
  authorId: string;
  text: string;
  tagged: string[];
  sourceSessionId?: string;
  replyToMessageId?: string;
  createdAt: number;
}

export interface AppendChannelMessageInput {
  channelId: string;
  authorType: ChannelMessageAuthorType;
  authorId: string;
  text: string;
  tagged?: string[];
  sourceSessionId?: string;
  replyToMessageId?: string;
}

function messageFilePath(workspaceRootPath: string, channelId: string): string {
  const safeChannelId = encodeURIComponent(channelId);
  return join(workspaceRootPath, CHANNEL_MESSAGES_DIR, `${safeChannelId}.jsonl`);
}

function ensureMessageDir(workspaceRootPath: string): void {
  const dir = join(workspaceRootPath, CHANNEL_MESSAGES_DIR);
  if (!existsSync(dir)) {
    mkdirSync(dir, { recursive: true });
  }
}

function isChannelMessage(value: unknown): value is ChannelMessage {
  if (!value || typeof value !== 'object') return false;
  const record = value as Record<string, unknown>;
  return (
    typeof record.id === 'string'
    && typeof record.channelId === 'string'
    && typeof record.authorType === 'string'
    && typeof record.authorId === 'string'
    && typeof record.text === 'string'
    && Array.isArray(record.tagged)
    && typeof record.createdAt === 'number'
  );
}

export function appendChannelMessage(
  workspaceRootPath: string,
  input: AppendChannelMessageInput,
): ChannelMessage {
  ensureMessageDir(workspaceRootPath);
  const message: ChannelMessage = {
    id: randomUUID(),
    channelId: input.channelId,
    authorType: input.authorType,
    authorId: input.authorId,
    text: input.text,
    tagged: input.tagged ?? [],
    createdAt: Date.now(),
    ...(input.sourceSessionId !== undefined ? { sourceSessionId: input.sourceSessionId } : {}),
    ...(input.replyToMessageId !== undefined ? { replyToMessageId: input.replyToMessageId } : {}),
  };

  const filePath = messageFilePath(workspaceRootPath, input.channelId);
  appendFileSync(filePath, `${JSON.stringify(message)}\n`, 'utf-8');
  return message;
}

export function listChannelMessages(workspaceRootPath: string, channelId: string): ChannelMessage[] {
  const filePath = messageFilePath(workspaceRootPath, channelId);
  if (!existsSync(filePath)) return [];

  const lines = readFileSync(filePath, 'utf-8')
    .split('\n')
    .filter(line => line.trim().length > 0);

  const messages: ChannelMessage[] = [];
  for (const line of lines) {
    try {
      const parsed = JSON.parse(line) as unknown;
      if (isChannelMessage(parsed) && parsed.channelId === channelId) {
        messages.push(parsed);
      }
    } catch {
      // Ignore corrupt log lines so one partial write does not hide the whole channel.
    }
  }
  return messages;
}
