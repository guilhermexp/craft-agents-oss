import { existsSync, mkdirSync } from 'fs';
import { join } from 'path';
import { atomicWriteFileSync, readJsonFileSync } from '../utils/files.ts';

const CHANNEL_SESSIONS_DIR = 'channels/sessions';

export interface ChannelSessionBindings {
  channelId: string;
  bindings: Record<string, string>;
}

function sessionBindingsFilePath(workspaceRootPath: string, channelId: string): string {
  const safeChannelId = encodeURIComponent(channelId);
  return join(workspaceRootPath, CHANNEL_SESSIONS_DIR, `${safeChannelId}.json`);
}

function ensureSessionBindingsDir(workspaceRootPath: string): void {
  const dir = join(workspaceRootPath, CHANNEL_SESSIONS_DIR);
  if (!existsSync(dir)) {
    mkdirSync(dir, { recursive: true });
  }
}

function isChannelSessionBindings(value: unknown): value is ChannelSessionBindings {
  if (!value || typeof value !== 'object') return false;
  const record = value as Record<string, unknown>;
  if (typeof record.channelId !== 'string') return false;
  if (!record.bindings || typeof record.bindings !== 'object') return false;
  return Object.values(record.bindings as Record<string, unknown>).every(entry => typeof entry === 'string');
}

/**
 * Reads the persisted participant→session bindings for one channel.
 * Any missing or corrupt file is treated as "no bindings yet" so a partial
 * write never breaks the channel.
 */
export function loadChannelSessionBindings(workspaceRootPath: string, channelId: string): Record<string, string> {
  const filePath = sessionBindingsFilePath(workspaceRootPath, channelId);
  if (!existsSync(filePath)) return {};

  try {
    const parsed = readJsonFileSync<unknown>(filePath);
    if (isChannelSessionBindings(parsed) && parsed.channelId === channelId) {
      return { ...parsed.bindings };
    }
  } catch {
    // Ignore corrupt binding files so one bad write does not break the channel.
  }
  return {};
}

export function getChannelParticipantSession(
  workspaceRootPath: string,
  channelId: string,
  participantId: string,
): string | undefined {
  return loadChannelSessionBindings(workspaceRootPath, channelId)[participantId];
}

export function setChannelParticipantSession(
  workspaceRootPath: string,
  channelId: string,
  participantId: string,
  sessionId: string,
): void {
  const bindings = loadChannelSessionBindings(workspaceRootPath, channelId);
  bindings[participantId] = sessionId;
  ensureSessionBindingsDir(workspaceRootPath);
  const payload: ChannelSessionBindings = { channelId, bindings };
  atomicWriteFileSync(sessionBindingsFilePath(workspaceRootPath, channelId), JSON.stringify(payload, null, 2));
}
