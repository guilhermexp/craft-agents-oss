import { describe, expect, test } from 'bun:test';
import type { WorkspaceObjectEvent } from '@craft-agent/shared/workspace-objects/types';
import { WorkspaceObjectEventFeed } from '../../workspace-objects/workspace-object-event-feed.ts';

describe('workspace object durable event delivery', () => {
  test('rescopes a durable marker to the subscription workspace id instead of the MCP basename id', async () => {
    const durable: WorkspaceObjectEvent = {
      workspaceId: 'smoke-a', objectId: 'object_people', revision: 2,
      changeKind: 'entries-upserted', projectionStatus: 'ready',
    };
    let listener: ((event: string, filename: string | null) => void) | undefined;
    const feed = new WorkspaceObjectEventFeed({
      debounceMs: 0,
      watch: (_path, watchListener) => { listener = watchListener; return { close() {}, on() {} }; },
      readEventProjection: () => durable,
      reconcile: () => {},
    });
    const delivered = new Promise<WorkspaceObjectEvent>(resolve => {
      feed.subscribe({
        clientId: 'c1', workspaceId: 'ws-smoke-a', workspaceRootPath: '/tmp/ws',
        deliver: resolve, reload: () => {},
      });
    });

    listener?.('change', '.events/object_people.json');

    expect(await delivered).toEqual({
      workspaceId: 'ws-smoke-a', objectId: 'object_people', revision: 2,
      changeKind: 'entries-upserted', projectionStatus: 'ready',
    });
  });
});
