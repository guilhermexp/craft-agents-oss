import { z } from 'zod';
import { basename, dirname } from 'node:path';
import { writeWorkspaceObjectEventProjection } from './event-projection.ts';
import { writeWorkspaceObjectManifest } from './manifest.ts';
import { WorkspaceObjectRepository } from './storage.ts';
import type { WorkspaceObjectRelationOptionsPage } from './storage.ts';
import { evaluateWorkspaceObjectQuery } from './query.ts';
import { DefineWorkspaceObjectSchema, WorkspaceObjectEntryInputSchema, type WorkspaceObjectChangeKind, type WorkspaceObjectEvent, type WorkspaceObjectPayload, type WorkspaceObjectProjectionStatus, type WorkspaceObjectValue } from './types.ts';
import { WorkspaceObjectSavedViewSchema, WorkspaceObjectViewConfigSchema } from './view-schema.ts';

const QueryWorkspaceObjectActionSchema = z.strictObject({
  action: z.literal('query-object'),
  objectId: z.string().min(1).max(120),
  query: z.union([
    z.strictObject({ viewId: z.string().min(1).max(120) }),
    z.strictObject({ config: WorkspaceObjectViewConfigSchema }),
  ]),
});
const MAX_QUERY_ENTRIES = 200;

export const WorkspaceObjectActionSchema = z.discriminatedUnion('action', [
  z.strictObject({ action: z.literal('define-object'), object: DefineWorkspaceObjectSchema }),
  z.strictObject({ action: z.literal('upsert-entries'), objectId: z.string().min(1).max(120), entries: z.array(WorkspaceObjectEntryInputSchema).min(1).max(200) }),
  z.strictObject({ action: z.literal('delete-entries'), objectId: z.string().min(1).max(120), entryIds: z.array(z.string().min(1).max(120)).min(1).max(200) }),
  z.strictObject({ action: z.literal('upsert-view'), objectId: z.string().min(1).max(120), view: WorkspaceObjectSavedViewSchema }),
  z.strictObject({ action: z.literal('get-object'), objectId: z.string().min(1).max(120) }),
  z.strictObject({ action: z.literal('list-objects'), limit: z.number().int().min(1).max(200).optional() }),
  z.strictObject({ action: z.literal('repair-projection'), objectId: z.string().min(1).max(120) }),
  z.strictObject({
    action: z.literal('list-relation-options'),
    objectId: z.string().min(1).max(120),
    after: z.string().min(1).max(120).optional(),
    limit: z.number().int().min(1).max(200).optional(),
    includeEntryIds: z.array(z.string().min(1).max(120)).max(200).optional(),
  }),
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
  | { query: Pick<WorkspaceObjectPayload, 'fields' | 'entries'> & {
      objectId: string;
      revision: number;
      totalEntries: number;
      truncated: boolean;
      displayValues: Record<string, Record<string, WorkspaceObjectValue>>;
      relationLabels: Record<string, string>;
    } }
  | { relationOptions: Array<{ id: string; label: string }>; nextCursor: string | null; revision: number };

export interface WorkspaceObjectServiceOptions {
  workspaceId: string;
  workspaceRootPath: string;
  writeManifest?: (workspaceRootPath: string, payload: WorkspaceObjectPayload) => string;
  writeEventProjection?: (workspaceRootPath: string, event: WorkspaceObjectEvent) => string;
  onEvent?: (event: WorkspaceObjectEvent) => void;
}

export function buildRelationLabelsFromSnapshotPages(
  referencedIds: ReadonlySet<string>,
  pages: readonly WorkspaceObjectRelationOptionsPage[],
): Map<string, string> {
  const revision = pages[0]?.revision;
  if (revision !== undefined && pages.some(page => page.revision !== revision)) {
    throw new Error('Relation options changed during query');
  }
  const labels = new Map<string, string>();
  for (const page of pages) {
    for (const option of page.options) {
      if (referencedIds.has(option.id)) labels.set(option.id, option.label);
    }
  }
  return labels;
}

export class WorkspaceObjectService {
  private readonly onEvent?: (event: WorkspaceObjectEvent) => void;
  private readonly writeManifest: (workspaceRootPath: string, payload: WorkspaceObjectPayload) => string;
  private readonly writeEventProjection: (workspaceRootPath: string, event: WorkspaceObjectEvent) => string;

  private constructor(
    private readonly options: WorkspaceObjectServiceOptions,
    private readonly repository: WorkspaceObjectRepository,
  ) {
    this.writeManifest = options.writeManifest ?? writeWorkspaceObjectManifest;
    this.writeEventProjection = options.writeEventProjection ?? writeWorkspaceObjectEventProjection;
    this.onEvent = options.onEvent;
  }

  static open(options: WorkspaceObjectServiceOptions): WorkspaceObjectService {
    return new WorkspaceObjectService(options, WorkspaceObjectRepository.open(options.workspaceRootPath));
  }

  execute(input: WorkspaceObjectAction): WorkspaceObjectServiceResult {
    const action = WorkspaceObjectActionSchema.parse(input);
    if (action.action === 'get-object') return { payload: this.repository.getObject(action.objectId) };
    if (action.action === 'list-objects') return { objects: this.repository.listObjects(action.limit) };
    if (action.action === 'list-relation-options') {
      const page = this.repository.listRelationOptions(action.objectId, action);
      return { relationOptions: page.options, nextCursor: page.nextCursor, revision: page.revision };
    }
    if (action.action === 'query-object') {
      this.repository.ensureFreshProjection(action.objectId);
      return this.repository.withReadSnapshot(() => this.queryObject(action));
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

  private queryObject(action: z.infer<typeof QueryWorkspaceObjectActionSchema>): Extract<WorkspaceObjectServiceResult, { query: unknown }> {
    const payload = this.repository.readObjectSnapshot(action.objectId);
    if (!payload) throw new Error(`Unknown object: ${action.objectId}`);
    const viewId = 'viewId' in action.query ? action.query.viewId : null;
    const config = 'config' in action.query
      ? action.query.config
      : payload.savedViews.find(view => view.id === viewId)?.config;
    if (!config) throw new Error(`Unknown saved view: ${'viewId' in action.query ? action.query.viewId : ''}`);
    const relationLabels = new Map<string, string>();
    for (const relationObjectId of new Set(payload.fields.flatMap(field => field.relationObjectId ? [field.relationObjectId] : []))) {
      const fieldIds = new Set(payload.fields.flatMap(field => field.relationObjectId === relationObjectId ? [field.id] : []));
      const referencedIdSet = new Set<string>();
      for (const entry of payload.entries) {
        for (const [fieldId, value] of Object.entries(entry.values)) {
          if (fieldIds.has(fieldId) && typeof value === 'string') referencedIdSet.add(value);
        }
      }
      const referencedIds = [...referencedIdSet];
      const pages: WorkspaceObjectRelationOptionsPage[] = [];
      for (let offset = 0; offset < referencedIds.length; offset += 200) {
        pages.push(this.repository.listRelationOptions(relationObjectId, {
          limit: 1,
          includeEntryIds: referencedIds.slice(offset, offset + 200),
        }));
      }
      for (const [id, label] of buildRelationLabelsFromSnapshotPages(referencedIdSet, pages)) relationLabels.set(id, label);
    }
    const query = evaluateWorkspaceObjectQuery(payload, config, {
      relationLabels,
    });
    const totalEntries = query.entries.length;
    const entries = query.entries.slice(0, MAX_QUERY_ENTRIES);
    const relationFieldIds = new Set(payload.fields.flatMap(field => field.type === 'relation' ? [field.id] : []));
    const returnedRelationIds = new Set(entries.flatMap(entry => Object.entries(entry.values).flatMap(([fieldId, value]) => (
      relationFieldIds.has(fieldId) && typeof value === 'string' ? [value] : []
    ))));
    return { query: {
      objectId: payload.id,
      revision: payload.revision,
      totalEntries,
      truncated: totalEntries > entries.length,
      fields: query.fields,
      entries,
      displayValues: Object.fromEntries(entries.map(entry => [entry.id, query.displayValues.get(entry.id) ?? {}])),
      relationLabels: Object.fromEntries([...relationLabels].filter(([id]) => returnedRelationIds.has(id))),
    } };
  }

  close(): void {
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
    this.onEvent?.(publishedEvent);
    return publishedEvent.projectionStatus;
  }
}

export function executeWorkspaceObjectAction(
  options: WorkspaceObjectServiceOptions,
  action: WorkspaceObjectAction,
  onEvent?: (event: WorkspaceObjectEvent) => void,
): WorkspaceObjectServiceResult {
  const service = WorkspaceObjectService.open({ ...options, onEvent });
  try {
    return service.execute(action);
  } finally {
    service.close();
  }
}

export function repairWorkspaceObjectProjections(
  options: WorkspaceObjectServiceOptions,
  changedPath?: string,
  onEvent?: (event: WorkspaceObjectEvent) => void,
): void {
  const service = WorkspaceObjectService.open({ ...options, onEvent });
  try {
    const listed = service.execute({ action: 'list-objects' });
    if (!('objects' in listed)) return;
    const targets = changedPath
      ? listed.objects.filter(candidate => candidate.slug === basename(dirname(changedPath)))
      : listed.objects;
    for (const object of targets) service.execute({ action: 'repair-projection', objectId: object.id });
  } finally {
    service.close();
  }
}
