import { z } from 'zod';

export const WorkspaceObjectFieldTypeSchema = z.enum([
  'text', 'number', 'boolean', 'date', 'datetime', 'select', 'status', 'relation', 'file',
]);
export type WorkspaceObjectFieldType = z.infer<typeof WorkspaceObjectFieldTypeSchema>;

export const WORKSPACE_OBJECT_VALUE_MAX_LENGTH = 64_000;
export const WorkspaceObjectValueSchema = z.union([
  z.string().max(WORKSPACE_OBJECT_VALUE_MAX_LENGTH),
  z.number().finite(),
  z.boolean(),
  z.null(),
]);
export type WorkspaceObjectValue = z.infer<typeof WorkspaceObjectValueSchema>;

export const WorkspaceObjectFieldSchema = z.strictObject({
  id: z.string().min(1).max(120),
  name: z.string().min(1).max(160),
  type: WorkspaceObjectFieldTypeSchema,
  required: z.boolean().optional(),
  options: z.array(z.string().min(1).max(160)).max(200).optional(),
  relationObjectId: z.string().min(1).max(120).optional(),
}).superRefine((field, ctx) => {
  if ((field.type === 'select' || field.type === 'status') && !field.options?.length) {
    ctx.addIssue({ code: 'custom', message: `${field.type} requires options`, path: ['options'] });
  }
  if (field.type === 'relation' && !field.relationObjectId) {
    ctx.addIssue({ code: 'custom', message: 'relation requires relationObjectId', path: ['relationObjectId'] });
  }
});
export type WorkspaceObjectField = z.infer<typeof WorkspaceObjectFieldSchema>;

export const DefineWorkspaceObjectSchema = z.strictObject({
  id: z.string().min(1).max(120),
  slug: z.string().regex(/^[a-z0-9]+(?:-[a-z0-9]+)*$/).max(120),
  name: z.string().min(1).max(160),
  fields: z.array(WorkspaceObjectFieldSchema).max(200),
});
export type DefineWorkspaceObjectInput = z.infer<typeof DefineWorkspaceObjectSchema>;

export const WorkspaceObjectEntryInputSchema = z.strictObject({
  id: z.string().min(1).max(120),
  values: z.record(z.string().min(1).max(120), WorkspaceObjectValueSchema),
});
export type WorkspaceObjectEntryInput = z.infer<typeof WorkspaceObjectEntryInputSchema>;

export interface WorkspaceObjectEntry {
  id: string;
  values: Record<string, WorkspaceObjectValue>;
}

export const WorkspaceObjectSavedViewSchema = z.strictObject({
  id: z.string().min(1).max(120),
  name: z.string().min(1).max(160),
  config: z.record(z.string(), z.unknown()),
});
export type WorkspaceObjectSavedView = z.infer<typeof WorkspaceObjectSavedViewSchema>;

export const WorkspaceObjectProjectionStatusSchema = z.enum(['ready', 'projection-error']);
export type WorkspaceObjectProjectionStatus = z.infer<typeof WorkspaceObjectProjectionStatusSchema>;

export const WorkspaceObjectPayloadSchema = z.strictObject({
  id: z.string().min(1).max(120),
  slug: z.string().regex(/^[a-z0-9]+(?:-[a-z0-9]+)*$/).max(120),
  name: z.string().min(1).max(160),
  revision: z.number().int().positive(),
  projectionStatus: WorkspaceObjectProjectionStatusSchema,
  fields: z.array(WorkspaceObjectFieldSchema).max(200),
  entries: z.array(z.strictObject({
    id: z.string().min(1).max(120),
    values: z.record(z.string().min(1).max(120), WorkspaceObjectValueSchema),
  })),
  savedViews: z.array(WorkspaceObjectSavedViewSchema),
});
export type WorkspaceObjectPayload = z.infer<typeof WorkspaceObjectPayloadSchema>;

export const WorkspaceObjectChangeKindSchema = z.enum([
  'defined', 'entries-upserted', 'entries-deleted', 'view-upserted', 'projection-repaired', 'external-change',
]);
export type WorkspaceObjectChangeKind = z.infer<typeof WorkspaceObjectChangeKindSchema>;
export const WorkspaceObjectEventSchema = z.strictObject({
  workspaceId: z.string().min(1).max(120),
  objectId: z.string().min(1).max(120),
  revision: z.number().int().positive(),
  changeKind: WorkspaceObjectChangeKindSchema,
  projectionStatus: WorkspaceObjectProjectionStatusSchema,
});
export type WorkspaceObjectEvent = z.infer<typeof WorkspaceObjectEventSchema>;

export const WORKSPACE_OBJECT_RPC_CHANNELS = {
  LIST: 'workspace-objects:list',
  EXECUTE: 'workspace-objects:execute',
  SUBSCRIBE: 'workspace-objects:subscribe',
  UNSUBSCRIBE: 'workspace-objects:unsubscribe',
  EVENT: 'workspace-objects:event',
} as const;
