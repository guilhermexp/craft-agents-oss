import { basename, dirname } from 'node:path';
import { getWorkspaceByNameOrId } from '@craft-agent/shared/config';
import { WorkspaceObjectActionSchema, WorkspaceObjectService } from '@craft-agent/shared/workspace-objects/service';
import { WORKSPACE_OBJECT_RPC_CHANNELS } from '@craft-agent/shared/workspace-objects/types';
import type { RpcServer } from '@craft-agent/server-core/transport';
import type { HandlerDeps } from '../handler-deps';
import { WorkspaceObjectWatcherRegistry } from '../../workspace-objects/workspace-object-watcher';

const watcherRegistry = new WorkspaceObjectWatcherRegistry();

export function cleanupWorkspaceObjectClient(clientId: string): void {
  watcherRegistry.unsubscribeClient(clientId);
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
  server.handle(WORKSPACE_OBJECT_RPC_CHANNELS.LIST, (ctx, workspaceId: string) => {
    assertWorkspaceScope(ctx.workspaceId, workspaceId);
    const workspace = resolveWorkspace(workspaceId);
    const service = WorkspaceObjectService.open({ workspaceId, workspaceRootPath: workspace.rootPath });
    try { return service.execute({ action: 'list-objects' }); } finally { service.close(); }
  });

  server.handle(WORKSPACE_OBJECT_RPC_CHANNELS.EXECUTE, (ctx, workspaceId: string, input: unknown) => {
    assertWorkspaceScope(ctx.workspaceId, workspaceId);
    const workspace = resolveWorkspace(workspaceId);
    const service = WorkspaceObjectService.open({ workspaceId, workspaceRootPath: workspace.rootPath });
    const unsubscribe = service.events.subscribe(event => server.push(WORKSPACE_OBJECT_RPC_CHANNELS.EVENT, { to: 'workspace', workspaceId }, event));
    try { return service.execute(WorkspaceObjectActionSchema.parse(input)); } finally { unsubscribe(); service.close(); }
  });

  server.handle(WORKSPACE_OBJECT_RPC_CHANNELS.SUBSCRIBE, (ctx, workspaceId: string) => {
    assertWorkspaceScope(ctx.workspaceId, workspaceId);
    const workspace = resolveWorkspace(workspaceId);
    watcherRegistry.subscribe(ctx.clientId, workspaceId, workspace.rootPath, changedPath => {
      if (basename(changedPath) !== 'object.yaml') return;
      const slug = basename(dirname(changedPath));
      const service = WorkspaceObjectService.open({ workspaceId, workspaceRootPath: workspace.rootPath });
      const unsubscribe = service.events.subscribe(event => server.push(WORKSPACE_OBJECT_RPC_CHANNELS.EVENT, { to: 'client', clientId: ctx.clientId }, event));
      try {
        const objects = service.execute({ action: 'list-objects' });
        if ('objects' in objects) {
          const object = objects.objects.find(candidate => candidate.slug === slug);
          if (object) service.execute({ action: 'repair-projection', objectId: object.id });
        }
      } catch (error) {
        deps.platform.logger.error('Workspace object projection reconciliation failed:', error);
      } finally {
        unsubscribe();
        service.close();
      }
    });
  });

  server.handle(WORKSPACE_OBJECT_RPC_CHANNELS.UNSUBSCRIBE, (ctx, workspaceId: string) => {
    watcherRegistry.unsubscribe(ctx.clientId, workspaceId);
  });
}
