import { z } from 'zod';
import { WorkspaceObjectEventBus } from './events.ts';
import { writeWorkspaceObjectEventProjection } from './event-projection.ts';
import { writeWorkspaceObjectManifest } from './manifest.ts';
import { WorkspaceObjectRepository } from './storage.ts';
import { buildWorkspaceObjectRelationLabels, evaluateWorkspaceObjectQuery } from './query.ts';
import { DefineWorkspaceObjectSchema, WorkspaceObjectEntryInputSchema, type WorkspaceObjectChangeKind, type WorkspaceObjectEvent, type WorkspaceObjectPayload, type WorkspaceObjectProjectionStatus } from './types.ts';
import { WorkspaceObjectSavedViewInputSchema, WorkspaceObjectViewConfigSchema } from './view-schema.ts';

const QueryWorkspaceObjectActionSchema = z.strictObject({
  action: z.literal('query-object'),
  objectId: z.string().min(1).max(120),
  query: z.union([
    z.strictObject({ viewId: z.string().min(1).max(120) }),
    z.strictObject({ config: WorkspaceObjectViewConfigSchema }),
  ]),
});

export const WorkspaceObjectActionSchema = z.discriminatedUnion('action', [
  z.strictObject({ action: z.literal('define-object'), object: DefineWorkspaceObjectSchema }),
  z.strictObject({ action: z.literal('upsert-entries'), objectId: z.string().min(1).max(120), entries: z.array(WorkspaceObjectEntryInputSchema).min(1).max(200) }),
  z.strictObject({ action: z.literal('delete-entries'), objectId: z.string().min(1).max(120), entryIds: z.array(z.string().min(1).max(120)).min(1).max(200) }),
  z.strictObject({ action: z.literal('upsert-view'), objectId: z.string().min(1).max(120), view: WorkspaceObjectSavedViewInputSchema }),
  z.strictObject({ action: z.literal('get-object'), objectId: z.string().min(1).max(120) }),
  z.strictObject({ action: z.literal('list-objects'), limit: z.number().int().min(1).max(200).optional() }),
  z.strictObject({ action: z.literal('repair-projection'), objectId: z.string().min(1).max(120) }),
  QueryWorkspaceObjectActionSchema,
]);
export type WorkspaceObjectAction = z.input<typeof WorkspaceObjectActionSchema>;

export interface WorkspaceObjectMutationResult {
  objectId: string;
  revision: number;
  projectionStatus: WorkspaceObjectProjectionStatus;
}

export type WorkspaceObjectServiceResult =
  | WorkspaceObjectMutationResult
  | { payload: WorkspaceObjectPayload | null }
  | { objects: WorkspaceObjectPayload[] }
  | { query: Pick<WorkspaceObjectPayload, 'fields' | 'entries'> & { objectId: string; revision: number } };

export interface WorkspaceObjectServiceOptions {
  workspaceId: string;
  workspaceRootPath: string;
  writeManifest?: (workspaceRootPath: string, payload: WorkspaceObjectPayload) => string;
  writeEventProjection?: (workspaceRootPath: string, event: WorkspaceObjectEvent) => string;
}

export class WorkspaceObjectService {
  readonly events = new WorkspaceObjectEventBus();
  private readonly writeManifest: (workspaceRootPath: string, payload: WorkspaceObjectPayload) => string;
  private readonly writeEventProjection: (workspaceRootPath: string, event: WorkspaceObjectEvent) => string;

  private constructor(
    private readonly options: WorkspaceObjectServiceOptions,
    private readonly repository: WorkspaceObjectRepository,
  ) {
    this.writeManifest = options.writeManifest ?? writeWorkspaceObjectManifest;
    this.writeEventProjection = options.writeEventProjection ?? writeWorkspaceObjectEventProjection;
  }

  static open(options: WorkspaceObjectServiceOptions): WorkspaceObjectService {
    return new WorkspaceObjectService(options, WorkspaceObjectRepository.open(options.workspaceRootPath));
  }

  execute(input: WorkspaceObjectAction): WorkspaceObjectServiceResult {
    const action = WorkspaceObjectActionSchema.parse(input);
    if (action.action === 'get-object') return { payload: this.repository.getObject(action.objectId) };
    if (action.action === 'list-objects') return { objects: this.repository.listObjects(action.limit) };
    if (action.action === 'query-object') {
      const payload = this.repository.getObject(action.objectId);
      if (!payload) throw new Error(`Unknown object: ${action.objectId}`);
      const viewId = 'viewId' in action.query ? action.query.viewId : null;
      const config = 'config' in action.query
        ? action.query.config
        : payload.savedViews.find(view => view.id === viewId)?.config;
      if (!config) throw new Error(`Unknown saved view: ${'viewId' in action.query ? action.query.viewId : ''}`);
      const relationObjectIds = new Set(payload.fields.flatMap(field => field.relationObjectId ? [field.relationObjectId] : []));
      const relationPayloads = [...relationObjectIds].flatMap(objectId => {
        const relationPayload = this.repository.getObject(objectId);
        return relationPayload ? [relationPayload] : [];
      });
      const query = evaluateWorkspaceObjectQuery(payload, config, {
        relationLabels: buildWorkspaceObjectRelationLabels(relationPayloads),
      });
      return { query: { objectId: payload.id, revision: payload.revision, fields: query.fields, entries: query.entries } };
    }
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
      projectionStatus = this.publish({ workspaceId: this.options.workspaceId, objectId: payload.id, revision: payload.revision, changeKind, projectionStatus });
      if (changeKind === 'projection-repaired' && (message.includes('identity conflict') || message.includes('slug conflict'))) throw error;
      return { objectId: payload.id, revision: payload.revision, projectionStatus };
    }
    projectionStatus = this.publish({ workspaceId: this.options.workspaceId, objectId: payload.id, revision: payload.revision, changeKind, projectionStatus });
    return { objectId: payload.id, revision: payload.revision, projectionStatus };
  }

  private publish(event: WorkspaceObjectEvent): WorkspaceObjectProjectionStatus {
    let publishedEvent = event;
    try {
      this.writeEventProjection(this.options.workspaceRootPath, event);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      this.repository.setProjectionStatus(event.objectId, 'projection-error', `Durable event projection failed: ${message}`);
      publishedEvent = { ...event, projectionStatus: 'projection-error' };
    }
    this.events.publish(publishedEvent);
    return publishedEvent.projectionStatus;
  }
}
