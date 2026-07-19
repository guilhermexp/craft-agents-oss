import { existsSync, mkdirSync } from 'fs';
import { join } from 'path';
import { atomicWriteFileSync, readJsonFileSync } from '../utils/files.ts';

const CHANNEL_WATCHES_DIR = 'channels/watches';

export interface ChannelKanbanWatch {
  channelId: string;
  taskIds: string[];
}

function watchFilePath(workspaceRootPath: string, channelId: string): string {
  const safeChannelId = encodeURIComponent(channelId);
  return join(workspaceRootPath, CHANNEL_WATCHES_DIR, `${safeChannelId}.json`);
}

function ensureWatchDir(workspaceRootPath: string): void {
  const dir = join(workspaceRootPath, CHANNEL_WATCHES_DIR);
  if (!existsSync(dir)) {
    mkdirSync(dir, { recursive: true });
  }
}

function isChannelKanbanWatch(value: unknown): value is ChannelKanbanWatch {
  if (!value || typeof value !== 'object') return false;
  const record = value as Record<string, unknown>;
  return (
    typeof record.channelId === 'string'
    && Array.isArray(record.taskIds)
    && record.taskIds.every(taskId => typeof taskId === 'string')
  );
}

/**
 * Reads the persisted pending Kanban task ids watched for one channel.
 * Any missing or corrupt file is treated as "nothing watched" so a partial
 * write never breaks the channel.
 */
export function loadChannelKanbanWatch(workspaceRootPath: string, channelId: string): string[] {
  const filePath = watchFilePath(workspaceRootPath, channelId);
  if (!existsSync(filePath)) return [];

  try {
    const parsed = readJsonFileSync<unknown>(filePath);
    if (isChannelKanbanWatch(parsed) && parsed.channelId === channelId) {
      return [...parsed.taskIds];
    }
  } catch {
    // Ignore corrupt watch files so one bad write does not break the channel.
  }
  return [];
}

export function saveChannelKanbanWatch(workspaceRootPath: string, channelId: string, taskIds: string[]): void {
  ensureWatchDir(workspaceRootPath);
  const payload: ChannelKanbanWatch = { channelId, taskIds };
  atomicWriteFileSync(watchFilePath(workspaceRootPath, channelId), JSON.stringify(payload, null, 2));
}
