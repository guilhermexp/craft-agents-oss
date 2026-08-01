import { z } from 'zod';
import { WorkspaceObjectEventBus } from './events.ts';
import { writeWorkspaceObjectManifest } from './manifest.ts';
import { WorkspaceObjectRepository } from './storage.ts';
import { DefineWorkspaceObjectSchema, WorkspaceObjectEntryInputSchema, WorkspaceObjectSavedViewSchema, type WorkspaceObjectChangeKind, type WorkspaceObjectPayload, type WorkspaceObjectProjectionStatus } from './types.ts';

export const WorkspaceObjectActionSchema = z.discriminatedUnion('action', [
  z.object({ action: z.literal('define-object'), object: DefineWorkspaceObjectSchema }).strict(),
  z.object({ action: z.literal('upsert-entries'), objectId: z.string().min(1).max(120), entries: z.array(WorkspaceObjectEntryInputSchema).min(1).max(200) }).strict(),
  z.object({ action: z.literal('delete-entries'), objectId: z.string().min(1).max(120), entryIds: z.array(z.string().min(1).max(120)).min(1).max(200) }).strict(),
  z.object({ action: z.literal('upsert-view'), objectId: z.string().min(1).max(120), view: WorkspaceObjectSavedViewSchema }).strict(),
  z.object({ action: z.literal('get-object'), objectId: z.string().min(1).max(120) }).strict(),
  z.object({ action: z.literal('list-objects'), limit: z.number().int().min(1).max(200).optional() }).strict(),
  z.object({ action: z.literal('repair-projection'), objectId: z.string().min(1).max(120) }).strict(),
]);
export type WorkspaceObjectAction = z.infer<typeof WorkspaceObjectActionSchema>;

export interface WorkspaceObjectMutationResult {
  objectId: string;
  revision: number;
  projectionStatus: WorkspaceObjectProjectionStatus;
}

export type WorkspaceObjectServiceResult =
  | WorkspaceObjectMutationResult
  | { payload: WorkspaceObjectPayload | null }
  | { objects: WorkspaceObjectPayload[] };

export interface WorkspaceObjectServiceOptions {
  workspaceId: string;
  workspaceRootPath: string;
  writeManifest?: (workspaceRootPath: string, payload: WorkspaceObjectPayload) => string;
}

export class WorkspaceObjectService {
  readonly events = new WorkspaceObjectEventBus();
  private readonly writeManifest: (workspaceRootPath: string, payload: WorkspaceObjectPayload) => string;

  private constructor(
    private readonly options: WorkspaceObjectServiceOptions,
    private readonly repository: WorkspaceObjectRepository,
  ) {
    this.writeManifest = options.writeManifest ?? writeWorkspaceObjectManifest;
  }

  static open(options: WorkspaceObjectServiceOptions): WorkspaceObjectService {
    return new WorkspaceObjectService(options, WorkspaceObjectRepository.open(options.workspaceRootPath));
  }

  execute(input: WorkspaceObjectAction): WorkspaceObjectServiceResult {
    const action = WorkspaceObjectActionSchema.parse(input);
    if (action.action === 'get-object') return { payload: this.repository.getObject(action.objectId) };
    if (action.action === 'list-objects') return { objects: this.repository.listObjects(action.limit) };
    if (action.action === 'repair-projection') {
      const payload = this.repository.getObject(action.objectId);
      if (!payload) throw new Error(`Unknown object: ${action.objectId}`);
      return this.projectAndPublish(payload, 'projection-repaired');
    }
    if (action.action === 'define-object') return this.projectAndPublish(this.repository.defineObject(action.object), 'defined');
    if (action.action === 'upsert-entries') return this.projectAndPublish(this.repository.upsertEntries(action.objectId, action.entries), 'entries-upserted');
    if (action.action === 'delete-entries') return this.projectAndPublish(this.repository.deleteEntries(action.objectId, action.entryIds), 'entries-deleted');
    return this.projectAndPublish(this.repository.upsertSavedView(action.objectId, action.view), 'view-upserted');
  }

  close(): void {
    this.events.clear();
    this.repository.close();
  }

  private projectAndPublish(payload: WorkspaceObjectPayload, changeKind: WorkspaceObjectChangeKind): WorkspaceObjectMutationResult {
    let projectionStatus: WorkspaceObjectProjectionStatus = 'ready';
    try {
      this.repository.withProjectionLock(() => {
        const canonical = this.repository.getObject(payload.id);
        if (!canonical) throw new Error(`Unknown object: ${payload.id}`);
        this.writeManifest(this.options.workspaceRootPath, canonical);
        this.repository.setProjectionStatus(payload.id, 'ready');
      });
    } catch (error) {
      projectionStatus = 'projection-error';
      const message = error instanceof Error ? error.message : String(error);
      this.repository.setProjectionStatus(payload.id, projectionStatus, message);
      this.events.publish({ workspaceId: this.options.workspaceId, objectId: payload.id, revision: payload.revision, changeKind, projectionStatus });
      if (changeKind === 'projection-repaired' && message.includes('identity conflict')) throw error;
      return { objectId: payload.id, revision: payload.revision, projectionStatus };
    }
    this.events.publish({ workspaceId: this.options.workspaceId, objectId: payload.id, revision: payload.revision, changeKind, projectionStatus });
    return { objectId: payload.id, revision: payload.revision, projectionStatus };
  }
}
