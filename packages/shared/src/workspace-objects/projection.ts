import type { SQLiteDatabase } from '../memory/sqlite-driver.ts';
import type {
  WorkspaceObjectEntry,
  WorkspaceObjectField,
  WorkspaceObjectPayload,
  WorkspaceObjectProjectionStatus,
  WorkspaceObjectValue,
  WorkspaceObjectSavedView,
} from './types.ts';

interface ObjectRow { id: string; slug: string; name: string; revision: number }
interface FieldRow { id: string; name: string; type: WorkspaceObjectField['type']; required: number; options_json: string | null; relation_object_id: string | null }
interface EntryRow { id: string }
interface ValueRow { entry_id: string; field_id: string; value_text: string | null; value_number: number | null; value_boolean: number | null }
interface ViewRow { id: string; name: string; config_json: string }

function parseOptions(value: string | null): string[] | undefined {
  if (!value) return undefined;
  const parsed: unknown = JSON.parse(value);
  return Array.isArray(parsed) && parsed.every(item => typeof item === 'string') ? parsed : undefined;
}

function decodeValue(field: WorkspaceObjectField, row: ValueRow): WorkspaceObjectValue {
  if (field.type === 'number') return row.value_number;
  if (field.type === 'boolean') return row.value_boolean === null ? null : row.value_boolean === 1;
  return row.value_text;
}

export function buildWorkspaceObjectPayload(db: SQLiteDatabase, objectId: string): WorkspaceObjectPayload | null {
  const object = db.prepare('SELECT id, slug, name, revision FROM workspace_objects WHERE id = ?').get(objectId) as ObjectRow | undefined;
  if (!object) return null;
  const fieldRows = db.prepare(`SELECT id, name, type, required, options_json, relation_object_id
    FROM workspace_object_fields WHERE object_id = ? ORDER BY sort_order, id`).all(objectId) as FieldRow[];
  const fields: WorkspaceObjectField[] = fieldRows.map(field => ({
    id: field.id, name: field.name, type: field.type, required: field.required === 1,
    ...(parseOptions(field.options_json) ? { options: parseOptions(field.options_json) } : {}),
    ...(field.relation_object_id ? { relationObjectId: field.relation_object_id } : {}),
  }));
  const fieldById = new Map(fields.map(field => [field.id, field]));
  const entries = db.prepare('SELECT id FROM workspace_object_entries WHERE object_id = ? ORDER BY created_at, id').all(objectId) as EntryRow[];
  const values = db.prepare(`SELECT v.entry_id, v.field_id, v.value_text, v.value_number, v.value_boolean
    FROM workspace_object_values v JOIN workspace_object_entries e ON e.id = v.entry_id
    WHERE e.object_id = ? ORDER BY v.entry_id, v.field_id`).all(objectId) as ValueRow[];
  const valuesByEntry = new Map<string, Record<string, WorkspaceObjectValue>>();
  for (const row of values) {
    const field = fieldById.get(row.field_id);
    if (!field) continue;
    const target = valuesByEntry.get(row.entry_id) ?? {};
    target[row.field_id] = decodeValue(field, row);
    valuesByEntry.set(row.entry_id, target);
  }
  const payloadEntries: WorkspaceObjectEntry[] = entries.map(entry => ({ id: entry.id, values: valuesByEntry.get(entry.id) ?? {} }));
  const viewRows = db.prepare('SELECT id, name, config_json FROM workspace_object_saved_views WHERE object_id = ? ORDER BY name, id').all(objectId) as ViewRow[];
  const savedViews: WorkspaceObjectSavedView[] = viewRows.map(view => ({ id: view.id, name: view.name, config: JSON.parse(view.config_json) as Record<string, unknown> }));
  const state = db.prepare('SELECT status FROM workspace_object_projection_state WHERE object_id = ?').get(objectId) as { status: WorkspaceObjectProjectionStatus } | undefined;
  return { id: object.id, slug: object.slug, name: object.name, revision: object.revision, projectionStatus: state?.status ?? 'ready', fields, entries: payloadEntries, savedViews };
}

export function storeWorkspaceObjectPayload(db: SQLiteDatabase, payload: WorkspaceObjectPayload): void {
  db.prepare(`INSERT INTO workspace_object_payloads(object_id, source_revision, payload_json) VALUES (?, ?, ?)
    ON CONFLICT(object_id) DO UPDATE SET source_revision=excluded.source_revision, payload_json=excluded.payload_json`)
    .run(payload.id, payload.revision, JSON.stringify(payload));
}
