import type { WorkspaceObjectEvent } from '@craft-agent/shared/workspace-objects/types';

export function acceptWorkspaceObjectEvent(
  revisions: Map<string, { revision: number; projectionStatus: WorkspaceObjectEvent['projectionStatus'] }>,
  workspaceId: string,
  event: WorkspaceObjectEvent,
): boolean {
  if (event.workspaceId !== workspaceId) return false;
  const previous = revisions.get(event.objectId);
  if (previous && (event.revision < previous.revision
    || (event.revision === previous.revision && event.projectionStatus === previous.projectionStatus))) return false;
  revisions.set(event.objectId, { revision: event.revision, projectionStatus: event.projectionStatus });
  return true;
}
