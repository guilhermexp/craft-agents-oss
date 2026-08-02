import { afterEach, beforeEach, describe, expect, it } from 'bun:test';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import {
  getChannelParticipantSession,
  loadChannelSessionBindings,
  setChannelParticipantSession,
} from '../session-bindings.ts';

let workspaceRoot: string;

beforeEach(() => {
  workspaceRoot = mkdtempSync(join(tmpdir(), 'channel-session-bindings-test-'));
});

afterEach(() => {
  rmSync(workspaceRoot, { recursive: true, force: true });
});

describe('channel session bindings', () => {
  it('returns undefined for a channel with no persisted bindings', () => {
    expect(getChannelParticipantSession(workspaceRoot, 'architecture', 'hermes-lead')).toBeUndefined();
    expect(loadChannelSessionBindings(workspaceRoot, 'architecture')).toEqual({});
  });

  it('persists and reads back a participant binding', () => {
    setChannelParticipantSession(workspaceRoot, 'architecture', 'hermes-lead', 'session-1');

    expect(getChannelParticipantSession(workspaceRoot, 'architecture', 'hermes-lead')).toBe('session-1');
    expect(loadChannelSessionBindings(workspaceRoot, 'architecture')).toEqual({ 'hermes-lead': 'session-1' });
  });

  it('keeps bindings from different channels and participants isolated', () => {
    setChannelParticipantSession(workspaceRoot, 'architecture', 'hermes-lead', 'session-1');
    setChannelParticipantSession(workspaceRoot, 'architecture', 'pi-reviewer', 'session-2');
    setChannelParticipantSession(workspaceRoot, 'product', 'hermes-lead', 'session-3');

    expect(loadChannelSessionBindings(workspaceRoot, 'architecture')).toEqual({
      'hermes-lead': 'session-1',
      'pi-reviewer': 'session-2',
    });
    expect(loadChannelSessionBindings(workspaceRoot, 'product')).toEqual({ 'hermes-lead': 'session-3' });
  });

  it('overwrites a stale binding for the same participant', () => {
    setChannelParticipantSession(workspaceRoot, 'architecture', 'hermes-lead', 'session-1');
    setChannelParticipantSession(workspaceRoot, 'architecture', 'hermes-lead', 'session-2');

    expect(getChannelParticipantSession(workspaceRoot, 'architecture', 'hermes-lead')).toBe('session-2');
  });

  it('tolerates a corrupt bindings file and reports no bindings', () => {
    const dir = join(workspaceRoot, 'channels', 'sessions');
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, `${encodeURIComponent('architecture')}.json`), '{not valid json', 'utf-8');

    expect(loadChannelSessionBindings(workspaceRoot, 'architecture')).toEqual({});
    expect(getChannelParticipantSession(workspaceRoot, 'architecture', 'hermes-lead')).toBeUndefined();
  });

  it('ignores a bindings file whose channelId does not match', () => {
    const dir = join(workspaceRoot, 'channels', 'sessions');
    mkdirSync(dir, { recursive: true });
    writeFileSync(
      join(dir, `${encodeURIComponent('architecture')}.json`),
      JSON.stringify({ channelId: 'other', bindings: { 'hermes-lead': 'session-1' } }),
      'utf-8',
    );

    expect(loadChannelSessionBindings(workspaceRoot, 'architecture')).toEqual({});
  });
});
