import { describe, expect, test } from 'bun:test';
import { acceptWorkspaceObjectEvent } from '../workspace-object-events.ts';

describe('workspace object event scope', () => {
  test('rejects other workspaces and duplicate/stale revisions', () => {
    const revisions = new Map<string, { revision: number; projectionStatus: 'ready' | 'projection-error' }>();
    const event = { workspaceId: 'w1', objectId: 'o1', revision: 2, changeKind: 'defined' as const, projectionStatus: 'ready' as const };
    expect(acceptWorkspaceObjectEvent(revisions, 'w1', event)).toBe(true);
    expect(acceptWorkspaceObjectEvent(revisions, 'w1', event)).toBe(false);
    expect(acceptWorkspaceObjectEvent(revisions, 'w1', { ...event, projectionStatus: 'projection-error' })).toBe(true);
    expect(acceptWorkspaceObjectEvent(revisions, 'w1', { ...event, revision: 1 })).toBe(false);
    expect(acceptWorkspaceObjectEvent(revisions, 'w2', { ...event, revision: 3 })).toBe(false);
    expect(acceptWorkspaceObjectEvent(revisions, 'w1', { ...event, revision: 3 })).toBe(true);
  });
});
