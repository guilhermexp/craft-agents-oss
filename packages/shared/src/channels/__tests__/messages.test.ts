import { afterEach, beforeEach, describe, expect, it } from 'bun:test';
import { mkdtempSync, rmSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { appendChannelMessage, listChannelMessages } from '../messages.ts';

let workspaceRoot: string;

beforeEach(() => {
  workspaceRoot = mkdtempSync(join(tmpdir(), 'channel-messages-test-'));
});

afterEach(() => {
  rmSync(workspaceRoot, { recursive: true, force: true });
});

describe('channel message log', () => {
  it('appends and lists messages in channel order', () => {
    const first = appendChannelMessage(workspaceRoot, {
      channelId: 'architecture',
      authorType: 'user',
      authorId: 'human',
      text: '@hermes cria um plano',
      tagged: ['hermes'],
    });
    const second = appendChannelMessage(workspaceRoot, {
      channelId: 'architecture',
      authorType: 'agent',
      authorId: 'hermes',
      text: 'Plano inicial',
      sourceSessionId: 'session-hermes',
      replyToMessageId: first.id,
    });

    expect(listChannelMessages(workspaceRoot, 'architecture')).toEqual([first, second]);
    expect(listChannelMessages(workspaceRoot, 'other')).toEqual([]);
  });

  it('keeps messages from different channels isolated', () => {
    appendChannelMessage(workspaceRoot, {
      channelId: 'architecture',
      authorType: 'user',
      authorId: 'human',
      text: 'architecture',
    });
    appendChannelMessage(workspaceRoot, {
      channelId: 'product',
      authorType: 'user',
      authorId: 'human',
      text: 'product',
    });

    expect(listChannelMessages(workspaceRoot, 'architecture').map(message => message.text)).toEqual(['architecture']);
    expect(listChannelMessages(workspaceRoot, 'product').map(message => message.text)).toEqual(['product']);
  });
});
