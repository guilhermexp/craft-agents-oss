import { describe, expect, test } from 'bun:test';
import { scopeWorkspaceObjectEventForSubscription } from './workspace-objects.ts';

describe('workspace object durable event delivery', () => {
  test('uses the configured subscription workspace id instead of the MCP basename id', () => {
    const event = scopeWorkspaceObjectEventForSubscription('ws-smoke-a', {
      workspaceId: 'smoke-a',
      objectId: 'object_people',
      revision: 2,
      changeKind: 'entries-upserted',
      projectionStatus: 'ready',
    });

    expect(event).toEqual({
      workspaceId: 'ws-smoke-a',
      objectId: 'object_people',
      revision: 2,
      changeKind: 'entries-upserted',
      projectionStatus: 'ready',
    });
  });
});
