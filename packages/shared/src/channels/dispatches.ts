import { randomUUID } from 'crypto';
import { appendFileSync, existsSync, mkdirSync, readFileSync } from 'fs';
import { join } from 'path';
import type { WarRoomDispatch, WarRoomDispatchStatus } from './types.ts';

const CHANNEL_DISPATCHES_DIR = 'channels/dispatches';

export interface CreateChannelDispatchInput {
  channelId: string;
  participantId: string;
  sourceMessageId: string;
  parentMessageId?: string;
  sourceSessionId?: string;
}

export interface UpdateChannelDispatchInput {
  status?: WarRoomDispatchStatus;
  error?: string;
}

function dispatchFilePath(workspaceRootPath: string, channelId: string): string {
  const safeChannelId = encodeURIComponent(channelId);
  return join(workspaceRootPath, CHANNEL_DISPATCHES_DIR, `${safeChannelId}.jsonl`);
}

function ensureDispatchDir(workspaceRootPath: string): void {
  const dir = join(workspaceRootPath, CHANNEL_DISPATCHES_DIR);
  if (!existsSync(dir)) {
    mkdirSync(dir, { recursive: true });
  }
}

function isWarRoomDispatch(value: unknown): value is WarRoomDispatch {
  if (!value || typeof value !== 'object') return false;
  const record = value as Record<string, unknown>;
  return (
    typeof record.id === 'string'
    && typeof record.channelId === 'string'
    && typeof record.participantId === 'string'
    && typeof record.sourceMessageId === 'string'
    && ['queued', 'running', 'completed', 'failed', 'cancelled'].includes(String(record.status))
    && typeof record.createdAt === 'number'
    && typeof record.updatedAt === 'number'
  );
}

function appendDispatch(workspaceRootPath: string, dispatch: WarRoomDispatch): void {
  ensureDispatchDir(workspaceRootPath);
  appendFileSync(dispatchFilePath(workspaceRootPath, dispatch.channelId), `${JSON.stringify(dispatch)}\n`, 'utf-8');
}

export function createChannelDispatch(
  workspaceRootPath: string,
  input: CreateChannelDispatchInput,
): WarRoomDispatch {
  const now = Date.now();
  const dispatch: WarRoomDispatch = {
    id: randomUUID(),
    channelId: input.channelId,
    participantId: input.participantId,
    sourceMessageId: input.sourceMessageId,
    status: 'queued',
    createdAt: now,
    updatedAt: now,
    ...(input.parentMessageId !== undefined ? { parentMessageId: input.parentMessageId } : {}),
    ...(input.sourceSessionId !== undefined ? { sourceSessionId: input.sourceSessionId } : {}),
  };
  appendDispatch(workspaceRootPath, dispatch);
  return dispatch;
}

export function listChannelDispatches(workspaceRootPath: string, channelId: string): WarRoomDispatch[] {
  const filePath = dispatchFilePath(workspaceRootPath, channelId);
  if (!existsSync(filePath)) return [];

  const latestById = new Map<string, WarRoomDispatch>();
  const lines = readFileSync(filePath, 'utf-8')
    .split('\n')
    .filter(line => line.trim().length > 0);

  for (const line of lines) {
    try {
      const parsed = JSON.parse(line) as unknown;
      if (isWarRoomDispatch(parsed) && parsed.channelId === channelId) {
        latestById.set(parsed.id, parsed);
      }
    } catch {
      // Ignore corrupt log lines so one partial write does not hide the whole channel.
    }
  }

  return [...latestById.values()].sort((a, b) => a.createdAt - b.createdAt);
}

export function updateChannelDispatch(
  workspaceRootPath: string,
  channelId: string,
  dispatchId: string,
  updates: UpdateChannelDispatchInput,
): WarRoomDispatch {
  const existing = listChannelDispatches(workspaceRootPath, channelId).find(dispatch => dispatch.id === dispatchId);
  if (!existing) throw new Error(`Channel dispatch '${dispatchId}' not found`);

  const next: WarRoomDispatch = {
    ...existing,
    ...(updates.status !== undefined ? { status: updates.status } : {}),
    ...(updates.error !== undefined ? { error: updates.error } : {}),
    updatedAt: Date.now(),
  };
  appendDispatch(workspaceRootPath, next);
  return next;
}
