import { beforeEach, describe, expect, it } from 'bun:test';
import { mkdtempSync, rmSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import {
  createChannelDispatch,
  listChannelDispatches,
  updateChannelDispatch,
} from '../dispatches.ts';

let workspaceRoot = '';

beforeEach(() => {
  if (workspaceRoot) rmSync(workspaceRoot, { recursive: true, force: true });
  workspaceRoot = mkdtempSync(join(tmpdir(), 'channel-dispatches-test-'));
});

describe('channel dispatch log', () => {
  it('creates, updates, and lists latest dispatch state for one channel', () => {
    const dispatch = createChannelDispatch(workspaceRoot, {
      channelId: 'architecture',
      participantId: 'pi-reviewer',
      sourceMessageId: 'message-1',
      parentMessageId: 'parent-1',
      sourceSessionId: 'session-lead',
    });

    expect(dispatch.status).toBe('queued');
    expect(dispatch.channelId).toBe('architecture');

    const running = updateChannelDispatch(workspaceRoot, 'architecture', dispatch.id, {
      status: 'running',
    });
    expect(running.status).toBe('running');

    const completed = updateChannelDispatch(workspaceRoot, 'architecture', dispatch.id, {
      status: 'completed',
    });
    expect(completed.updatedAt).toBeGreaterThanOrEqual(dispatch.createdAt);

    expect(listChannelDispatches(workspaceRoot, 'architecture')).toEqual([completed]);
    expect(listChannelDispatches(workspaceRoot, 'other')).toEqual([]);
  });

  it('keeps dispatches from different channels isolated', () => {
    createChannelDispatch(workspaceRoot, {
      channelId: 'architecture',
      participantId: 'lead',
      sourceMessageId: 'message-1',
    });
    createChannelDispatch(workspaceRoot, {
      channelId: 'product',
      participantId: 'lead',
      sourceMessageId: 'message-2',
    });

    expect(listChannelDispatches(workspaceRoot, 'architecture').map(item => item.sourceMessageId)).toEqual(['message-1']);
    expect(listChannelDispatches(workspaceRoot, 'product').map(item => item.sourceMessageId)).toEqual(['message-2']);
  });
});
