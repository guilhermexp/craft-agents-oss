import { existsSync, mkdirSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { parse, stringify } from 'yaml';
import { atomicWriteFileSync } from '../utils/files.ts';
import { getWorkspaceObjectsPath } from '../workspaces/storage.ts';
import type { WorkspaceObjectPayload } from './types.ts';

export interface WorkspaceObjectManifest {
  schemaVersion: 1;
  id: string;
  slug: string;
  name: string;
  revision: number;
  fields: Array<{ id: string; name: string; type: string; required: boolean }>;
}

export function getWorkspaceObjectManifestPath(workspaceRootPath: string, slug: string): string {
  return join(getWorkspaceObjectsPath(workspaceRootPath), slug, 'object.yaml');
}

export function readWorkspaceObjectManifest(path: string): WorkspaceObjectManifest | null {
  if (!existsSync(path)) return null;
  const parsed: unknown = parse(readFileSync(path, 'utf8'));
  if (!parsed || typeof parsed !== 'object') throw new Error(`Invalid workspace object manifest: ${path}`);
  const value = parsed as Partial<WorkspaceObjectManifest>;
  if (value.schemaVersion !== 1 || typeof value.id !== 'string' || typeof value.slug !== 'string' || typeof value.revision !== 'number') {
    throw new Error(`Invalid workspace object manifest: ${path}`);
  }
  return value as WorkspaceObjectManifest;
}

export function writeWorkspaceObjectManifest(workspaceRootPath: string, payload: WorkspaceObjectPayload): string {
  const path = getWorkspaceObjectManifestPath(workspaceRootPath, payload.slug);
  const existing = readWorkspaceObjectManifest(path);
  if (existing && existing.id !== payload.id) {
    throw new Error(`Workspace object manifest identity conflict at ${path}`);
  }
  const manifest: WorkspaceObjectManifest = {
    schemaVersion: 1,
    id: payload.id,
    slug: payload.slug,
    name: payload.name,
    revision: payload.revision,
    fields: payload.fields.map(field => ({ id: field.id, name: field.name, type: field.type, required: field.required ?? false })),
  };
  const serialized = stringify(manifest);
  if (existing && existing.revision > payload.revision) {
    throw new Error(`Workspace object manifest at ${path} is newer than revision ${payload.revision}`);
  }
  if (existing && stringify(existing) === serialized) return path;
  mkdirSync(dirname(path), { recursive: true });
  atomicWriteFileSync(path, serialized);
  const verified = readWorkspaceObjectManifest(path);
  if (!verified || verified.id !== payload.id || verified.revision !== payload.revision) {
    throw new Error(`Workspace object manifest verification failed at ${path}`);
  }
  return path;
}
