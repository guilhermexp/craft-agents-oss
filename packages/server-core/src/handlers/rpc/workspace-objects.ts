import { basename } from 'node:path';
import { getWorkspaceByNameOrId } from '@craft-agent/shared/config/workspace-storage';
import { readWorkspaceObjectEventProjection } from '@craft-agent/shared/workspace-objects/event-projection';
import {
  WorkspaceObjectActionSchema,
  executeWorkspaceObjectAction,
  repairWorkspaceObjectProjections,
} from '@craft-agent/shared/workspace-objects/service';
import { WORKSPACE_OBJECT_RPC_CHANNELS } from '@craft-agent/shared/workspace-objects/types';
import type { RpcServer } from '@craft-agent/server-core/transport';
import type { HandlerDeps } from '../handler-deps';
import { WORKSPACE_OBJECT_WATCH_ALL } from '../../workspace-objects/workspace-object-watcher';
import { WorkspaceObjectEventFeed } from '../../workspace-objects/workspace-object-event-feed';

let feed: WorkspaceObjectEventFeed | null = null;

function getFeed(deps: HandlerDeps): WorkspaceObjectEventFeed {
  if (feed) return feed;
  const created: WorkspaceObjectEventFeed = new WorkspaceObjectEventFeed({
    readEventProjection: readWorkspaceObjectEventProjection,
    onError: error => deps.platform.logger.error('Workspace object durable event delivery failed:', error),
    reconcile: (workspaceId, workspaceRootPath, changedPath) => {
      if (changedPath !== WORKSPACE_OBJECT_WATCH_ALL && basename(changedPath) !== 'object.yaml') return;
      try {
        repairWorkspaceObjectProjections(
          { workspaceId, workspaceRootPath },
          changedPath === WORKSPACE_OBJECT_WATCH_ALL ? undefined : changedPath,
          event => created.publishLocal(workspaceId, event),
        );
      } catch (error) {
        deps.platform.logger.error('Workspace object projection reconciliation failed:', error);
      }
    },
  });
  feed = created;
  return feed;
}

export function cleanupWorkspaceObjectClient(clientId: string): void {
  feed?.unsubscribeClient(clientId);
}

function resolveWorkspace(workspaceId: string) {
  const workspace = getWorkspaceByNameOrId(workspaceId);
  if (!workspace) throw new Error(`Unknown workspace: ${workspaceId}`);
  return workspace;
}

function assertWorkspaceScope(contextWorkspaceId: string | null, requestedWorkspaceId: string): void {
  if (contextWorkspaceId && contextWorkspaceId !== requestedWorkspaceId) {
    throw new Error('Workspace object request is outside the active workspace scope');
  }
}

export function registerWorkspaceObjectHandlers(server: RpcServer, deps: HandlerDeps): void {
  const objectFeed = getFeed(deps);

  server.handle(WORKSPACE_OBJECT_RPC_CHANNELS.LIST, (ctx, workspaceId: string) => {
    assertWorkspaceScope(ctx.workspaceId, workspaceId);
    const workspace = resolveWorkspace(workspaceId);
    return executeWorkspaceObjectAction({ workspaceId, workspaceRootPath: workspace.rootPath }, { action: 'list-objects' });
  });

  server.handle(WORKSPACE_OBJECT_RPC_CHANNELS.EXECUTE, (ctx, workspaceId: string, input: unknown) => {
    assertWorkspaceScope(ctx.workspaceId, workspaceId);
    const workspace = resolveWorkspace(workspaceId);
    return executeWorkspaceObjectAction(
      { workspaceId, workspaceRootPath: workspace.rootPath },
      WorkspaceObjectActionSchema.parse(input),
      event => objectFeed.publishLocal(workspaceId, event),
    );
  });

  server.handle(WORKSPACE_OBJECT_RPC_CHANNELS.SUBSCRIBE, (ctx, workspaceId: string) => {
    assertWorkspaceScope(ctx.workspaceId, workspaceId);
    const workspace = resolveWorkspace(workspaceId);
    objectFeed.subscribe({
      clientId: ctx.clientId,
      workspaceId,
      workspaceRootPath: workspace.rootPath,
      deliver: event => server.push(WORKSPACE_OBJECT_RPC_CHANNELS.EVENT, { to: 'client', clientId: ctx.clientId }, event),
      reload: () => server.push(WORKSPACE_OBJECT_RPC_CHANNELS.RELOAD, { to: 'client', clientId: ctx.clientId }, workspaceId),
    });
  });

  server.handle(WORKSPACE_OBJECT_RPC_CHANNELS.UNSUBSCRIBE, (ctx, workspaceId: string) => {
    objectFeed.unsubscribe(ctx.clientId, workspaceId);
  });
}
