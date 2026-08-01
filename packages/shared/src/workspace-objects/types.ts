import { z } from 'zod';

export const WorkspaceObjectFieldTypeSchema = z.enum([
  'text', 'number', 'boolean', 'date', 'datetime', 'select', 'status', 'relation', 'file',
]);
export type WorkspaceObjectFieldType = z.infer<typeof WorkspaceObjectFieldTypeSchema>;

export const WorkspaceObjectValueSchema = z.union([z.string(), z.number(), z.boolean(), z.null()]);
export type WorkspaceObjectValue = z.infer<typeof WorkspaceObjectValueSchema>;

export const WorkspaceObjectFieldSchema = z.object({
  id: z.string().min(1).max(120),
  name: z.string().min(1).max(160),
  type: WorkspaceObjectFieldTypeSchema,
  required: z.boolean().optional(),
  options: z.array(z.string().min(1).max(160)).max(200).optional(),
  relationObjectId: z.string().min(1).max(120).optional(),
}).strict().superRefine((field, ctx) => {
  if ((field.type === 'select' || field.type === 'status') && !field.options?.length) {
    ctx.addIssue({ code: 'custom', message: `${field.type} requires options`, path: ['options'] });
  }
  if (field.type === 'relation' && !field.relationObjectId) {
    ctx.addIssue({ code: 'custom', message: 'relation requires relationObjectId', path: ['relationObjectId'] });
  }
});
export type WorkspaceObjectField = z.infer<typeof WorkspaceObjectFieldSchema>;

export const DefineWorkspaceObjectSchema = z.object({
  id: z.string().min(1).max(120),
  slug: z.string().regex(/^[a-z0-9]+(?:-[a-z0-9]+)*$/).max(120),
  name: z.string().min(1).max(160),
  fields: z.array(WorkspaceObjectFieldSchema).max(200),
}).strict();
export type DefineWorkspaceObjectInput = z.infer<typeof DefineWorkspaceObjectSchema>;

export const WorkspaceObjectEntryInputSchema = z.object({
  id: z.string().min(1).max(120),
  values: z.record(z.string().min(1).max(120), WorkspaceObjectValueSchema),
}).strict();
export type WorkspaceObjectEntryInput = z.infer<typeof WorkspaceObjectEntryInputSchema>;

export interface WorkspaceObjectEntry {
  id: string;
  values: Record<string, WorkspaceObjectValue>;
}

export const WorkspaceObjectSavedViewSchema = z.object({
  id: z.string().min(1).max(120),
  name: z.string().min(1).max(160),
  config: z.record(z.string(), z.unknown()),
}).strict();
export type WorkspaceObjectSavedView = z.infer<typeof WorkspaceObjectSavedViewSchema>;

export type WorkspaceObjectProjectionStatus = 'ready' | 'projection-error';

export interface WorkspaceObjectPayload {
  id: string;
  slug: string;
  name: string;
  revision: number;
  projectionStatus: WorkspaceObjectProjectionStatus;
  fields: WorkspaceObjectField[];
  entries: WorkspaceObjectEntry[];
  savedViews: WorkspaceObjectSavedView[];
}

export type WorkspaceObjectChangeKind = 'defined' | 'entries-upserted' | 'entries-deleted' | 'view-upserted' | 'projection-repaired' | 'external-change';

export interface WorkspaceObjectEvent {
  workspaceId: string;
  objectId: string;
  revision: number;
  changeKind: WorkspaceObjectChangeKind;
  projectionStatus: WorkspaceObjectProjectionStatus;
}

export const WORKSPACE_OBJECT_RPC_CHANNELS = {
  LIST: 'workspace-objects:list',
  EXECUTE: 'workspace-objects:execute',
  SUBSCRIBE: 'workspace-objects:subscribe',
  UNSUBSCRIBE: 'workspace-objects:unsubscribe',
  EVENT: 'workspace-objects:event',
} as const;
