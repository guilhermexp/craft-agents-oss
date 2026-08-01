import { existsSync, mkdirSync, readFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { dirname, join } from 'node:path';
import { atomicWriteFileSync } from '../utils/files.ts';
import { getWorkspaceObjectsPath } from '../workspaces/storage.ts';
import { WorkspaceObjectEventSchema, type WorkspaceObjectEvent } from './types.ts';

function safeEventFileName(objectId: string): string {
  return `${createHash('sha256').update(objectId).digest('hex')}.json`;
}

export function getWorkspaceObjectEventProjectionPath(workspaceRootPath: string, objectId: string): string {
  return join(getWorkspaceObjectsPath(workspaceRootPath), '.events', safeEventFileName(objectId));
}

export function readWorkspaceObjectEventProjection(path: string): WorkspaceObjectEvent | null {
  if (!existsSync(path)) return null;
  let parsed: unknown;
  try {
    parsed = JSON.parse(readFileSync(path, 'utf8'));
  } catch {
    throw new Error(`Invalid workspace object event projection: ${path}`);
  }
  const result = WorkspaceObjectEventSchema.safeParse(parsed);
  if (!result.success) throw new Error(`Invalid workspace object event projection: ${path}`);
  return result.data;
}

export function writeWorkspaceObjectEventProjection(workspaceRootPath: string, event: WorkspaceObjectEvent): string {
  const value = WorkspaceObjectEventSchema.parse(event);
  const path = getWorkspaceObjectEventProjectionPath(workspaceRootPath, value.objectId);
  mkdirSync(dirname(path), { recursive: true });
  atomicWriteFileSync(path, `${JSON.stringify(value)}\n`);
  const verified = readWorkspaceObjectEventProjection(path);
  if (!verified || verified.objectId !== value.objectId || verified.revision !== value.revision
    || verified.projectionStatus !== value.projectionStatus) {
    throw new Error(`Workspace object event projection verification failed at ${path}`);
  }
  return path;
}
