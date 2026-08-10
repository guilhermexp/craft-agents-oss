import { mkdirSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { parse, stringify } from 'yaml';
import { z } from 'zod';
import { atomicWriteFileSync } from '../utils/files.ts';
import { getWorkspaceObjectsPath } from '../workspaces/storage.ts';
import { WorkspaceObjectFieldTypeSchema, type WorkspaceObjectPayload } from './types.ts';

const WorkspaceObjectSlugSchema = z.string().regex(/^[a-z0-9]+(?:-[a-z0-9]+)*$/).max(120);

export const WorkspaceObjectManifestSchema = z.strictObject({
  schemaVersion: z.literal(1),
  id: z.string().min(1).max(120),
  slug: WorkspaceObjectSlugSchema,
  name: z.string().min(1).max(160),
  revision: z.number().int().positive(),
  fields: z.array(z.strictObject({
    id: z.string().min(1).max(120),
    name: z.string().min(1).max(160),
    type: WorkspaceObjectFieldTypeSchema,
    required: z.boolean(),
  })).max(200),
});
export type WorkspaceObjectManifest = z.infer<typeof WorkspaceObjectManifestSchema>;

export function getWorkspaceObjectManifestPath(workspaceRootPath: string, slug: string): string {
  const result = WorkspaceObjectSlugSchema.safeParse(slug);
  if (!result.success) throw new Error(`Invalid workspace object slug: ${slug}`);
  return join(getWorkspaceObjectsPath(workspaceRootPath), result.data, 'object.yaml');
}

export function readWorkspaceObjectManifest(path: string): WorkspaceObjectManifest | null {
  let source: string;
  try {
    source = readFileSync(path, 'utf8');
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null;
    throw error;
  }
  let parsed: unknown;
  try {
    parsed = parse(source);
  } catch {
    throw new Error(`Invalid workspace object manifest: ${path}`);
  }
  const result = WorkspaceObjectManifestSchema.safeParse(parsed);
  if (!result.success) throw new Error(`Invalid workspace object manifest: ${path}`);
  return result.data;
}

export function writeWorkspaceObjectManifest(workspaceRootPath: string, payload: WorkspaceObjectPayload): string {
  const path = getWorkspaceObjectManifestPath(workspaceRootPath, payload.slug);
  let existing: WorkspaceObjectManifest | null = null;
  try {
    existing = readWorkspaceObjectManifest(path);
  } catch (error) {
    if (!(error instanceof Error) || !error.message.startsWith('Invalid workspace object manifest:')) throw error;
  }
  if (existing && existing.id !== payload.id) throw new Error(`Workspace object manifest identity conflict at ${path}`);
  if (existing && existing.slug !== payload.slug) throw new Error(`Workspace object manifest slug conflict at ${path}`);
  const manifest: WorkspaceObjectManifest = {
    schemaVersion: 1,
    id: payload.id,
    slug: payload.slug,
    name: payload.name,
    revision: payload.revision,
    fields: payload.fields.map(field => ({ id: field.id, name: field.name, type: field.type, required: field.required ?? false })),
  };
  const serialized = stringify(manifest);
  if (existing && stringify(existing) === serialized) return path;
  mkdirSync(dirname(path), { recursive: true });
  atomicWriteFileSync(path, serialized);
  const verified = readWorkspaceObjectManifest(path);
  if (!verified || verified.id !== payload.id || verified.revision !== payload.revision) {
    throw new Error(`Workspace object manifest verification failed at ${path}`);
  }
  return path;
}
