import { existsSync, mkdirSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { openSQLite, type SQLiteDatabase } from '../memory/sqlite-driver.ts';
import { getWorkspaceObjectsPath } from '../workspaces/storage.ts';
import { buildWorkspaceObjectPayload, storeWorkspaceObjectPayload } from './projection.ts';
import { WORKSPACE_OBJECT_SCHEMA_V1, WORKSPACE_OBJECT_SCHEMA_VERSION } from './schema.ts';
import {
  DefineWorkspaceObjectSchema,
  WorkspaceObjectEntryInputSchema,
  type DefineWorkspaceObjectInput,
  type WorkspaceObjectEntryInput,
  type WorkspaceObjectField,
  type WorkspaceObjectPayload,
  type WorkspaceObjectValue,
  WorkspaceObjectSavedViewSchema,
  type WorkspaceObjectSavedView,
} from './types.ts';

interface VersionRow { version: number }
interface ObjectRevisionRow { revision: number }
interface FieldRow { id: string; type: WorkspaceObjectField['type']; required: number; options_json: string | null; relation_object_id: string | null }
const MAX_READ_ENTRIES = 200;

export class WorkspaceObjectRepository {
  private closed = false;

  private constructor(private readonly db: SQLiteDatabase, readonly databasePath: string) {}

  static open(workspaceRootPath: string): WorkspaceObjectRepository {
    const root = resolve(workspaceRootPath);
    if (!root || root === resolve('/')) throw new Error('A concrete workspace root is required');
    const objectsPath = getWorkspaceObjectsPath(root);
    if (!existsSync(objectsPath)) mkdirSync(objectsPath, { recursive: true });
    const databasePath = join(objectsPath, 'objects.sqlite');
    const db = openSQLite(databasePath);
    db.pragma('foreign_keys = ON');
    db.pragma('journal_mode = WAL');
    const hasVersion = db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='workspace_object_schema_version'").get();
    if (hasVersion) {
      const row = db.prepare('SELECT MAX(version) AS version FROM workspace_object_schema_version').get() as VersionRow | undefined;
      if ((row?.version ?? 0) > WORKSPACE_OBJECT_SCHEMA_VERSION) {
        db.close();
        throw new Error(`Workspace object database uses newer schema version ${row?.version}`);
      }
    }
    db.runSql(WORKSPACE_OBJECT_SCHEMA_V1);
    return new WorkspaceObjectRepository(db, databasePath);
  }

  close(): void {
    if (this.closed) return;
    this.closed = true;
    this.db.close();
  }

  defineObject(input: DefineWorkspaceObjectInput): WorkspaceObjectPayload {
    const parsed = DefineWorkspaceObjectSchema.parse(input);
    const now = Date.now();
    this.transaction(() => {
      this.db.prepare('INSERT INTO workspace_objects(id, slug, name, revision, created_at, updated_at) VALUES (?, ?, ?, 1, ?, ?)')
        .run(parsed.id, parsed.slug, parsed.name, now, now);
      parsed.fields.forEach((field, index) => {
        this.db.prepare(`INSERT INTO workspace_object_fields
          (id, object_id, name, type, required, options_json, relation_object_id, sort_order)
          VALUES (?, ?, ?, ?, ?, ?, ?, ?)`)
          .run(field.id, parsed.id, field.name, field.type, field.required ? 1 : 0,
            field.options ? JSON.stringify(field.options) : null, field.relationObjectId ?? null, index);
      });
      this.db.prepare('INSERT INTO workspace_object_action_history(object_id, revision, action, created_at) VALUES (?, 1, ?, ?)')
        .run(parsed.id, 'defined', now);
      this.refreshProjection(parsed.id, 1);
    });
    return this.requireObject(parsed.id);
  }

  upsertEntries(objectId: string, inputs: WorkspaceObjectEntryInput[]): WorkspaceObjectPayload {
    const parsed = inputs.map(input => WorkspaceObjectEntryInputSchema.parse(input));
    const fields = this.getFieldRows(objectId);
    if (!this.objectExists(objectId)) throw new Error(`Unknown object: ${objectId}`);
    for (const input of parsed) this.validateEntry(fields, input);
    for (const input of parsed) this.assertOwnedByObject('workspace_object_entries', input.id, objectId);
    const now = Date.now();
    this.transaction(() => {
      for (const input of parsed) {
        this.db.prepare(`INSERT INTO workspace_object_entries(id, object_id, created_at, updated_at) VALUES (?, ?, ?, ?)
          ON CONFLICT(id) DO UPDATE SET updated_at=excluded.updated_at`).run(input.id, objectId, now, now);
        for (const [fieldId, value] of Object.entries(input.values)) this.writeValue(input.id, fieldId, fields.get(fieldId)!, value);
      }
      const revision = this.bumpRevision(objectId, now);
      this.db.prepare('INSERT INTO workspace_object_action_history(object_id, revision, action, created_at) VALUES (?, ?, ?, ?)')
        .run(objectId, revision, 'entries-upserted', now);
      this.refreshProjection(objectId, revision);
    });
    return this.requireObject(objectId);
  }

  deleteEntries(objectId: string, entryIds: string[]): WorkspaceObjectPayload {
    if (!this.objectExists(objectId)) throw new Error(`Unknown object: ${objectId}`);
    if (entryIds.length === 0 || entryIds.length > 200) throw new Error('entryIds must contain 1-200 entries');
    const now = Date.now();
    this.transaction(() => {
      for (const entryId of entryIds) {
        this.db.prepare('DELETE FROM workspace_object_entries WHERE id = ? AND object_id = ?').run(entryId, objectId);
      }
      const revision = this.bumpRevision(objectId, now);
      this.db.prepare('INSERT INTO workspace_object_action_history(object_id, revision, action, created_at) VALUES (?, ?, ?, ?)')
        .run(objectId, revision, 'entries-deleted', now);
      this.refreshProjection(objectId, revision);
    });
    return this.requireObject(objectId);
  }

  upsertSavedView(objectId: string, input: WorkspaceObjectSavedView): WorkspaceObjectPayload {
    if (!this.objectExists(objectId)) throw new Error(`Unknown object: ${objectId}`);
    const view = WorkspaceObjectSavedViewSchema.parse(input);
    this.assertOwnedByObject('workspace_object_saved_views', view.id, objectId);
    const configJson = JSON.stringify(view.config);
    if (Buffer.byteLength(configJson, 'utf8') > 64_000) throw new Error('Saved view config exceeds 64KB');
    const now = Date.now();
    this.transaction(() => {
      const revision = this.bumpRevision(objectId, now);
      this.db.prepare(`INSERT INTO workspace_object_saved_views(id, object_id, name, config_json, revision) VALUES (?, ?, ?, ?, ?)
        ON CONFLICT(id) DO UPDATE SET name=excluded.name, config_json=excluded.config_json, revision=excluded.revision`)
        .run(view.id, objectId, view.name, configJson, revision);
      this.db.prepare('INSERT INTO workspace_object_action_history(object_id, revision, action, created_at) VALUES (?, ?, ?, ?)')
        .run(objectId, revision, 'view-upserted', now);
      this.refreshProjection(objectId, revision);
    });
    return this.requireObject(objectId);
  }

  getObject(objectId: string, entryLimit = MAX_READ_ENTRIES): WorkspaceObjectPayload | null {
    const boundedEntryLimit = Math.max(1, Math.min(entryLimit, MAX_READ_ENTRIES));
    const revision = this.db.prepare('SELECT revision FROM workspace_objects WHERE id = ?').get(objectId) as ObjectRevisionRow | undefined;
    if (!revision) return null;
    const projection = this.db.prepare('SELECT source_revision, payload_json FROM workspace_object_payloads WHERE object_id = ?').get(objectId) as { source_revision: number; payload_json: string } | undefined;
    if (projection?.source_revision === revision.revision) {
      try {
        const payload = JSON.parse(projection.payload_json) as WorkspaceObjectPayload;
        return { ...payload, entries: payload.entries.slice(0, boundedEntryLimit) };
      } catch { /* rebuild below */ }
    }
    const rebuilt = buildWorkspaceObjectPayload(this.db, objectId);
    if (rebuilt) storeWorkspaceObjectPayload(this.db, rebuilt);
    return rebuilt ? { ...rebuilt, entries: rebuilt.entries.slice(0, boundedEntryLimit) } : null;
  }

  listObjects(limit = 100): WorkspaceObjectPayload[] {
    const bounded = Math.max(1, Math.min(limit, 200));
    const rows = this.db.prepare('SELECT id FROM workspace_objects ORDER BY updated_at DESC LIMIT ?').all(bounded) as Array<{ id: string }>;
    return rows.map(row => this.getObject(row.id)).filter((value): value is WorkspaceObjectPayload => value !== null);
  }

  setProjectionStatus(objectId: string, status: 'ready' | 'projection-error', error?: string): void {
    const revision = this.requireRevision(objectId);
    this.db.prepare(`INSERT INTO workspace_object_projection_state(object_id, source_revision, status, error) VALUES (?, ?, ?, ?)
      ON CONFLICT(object_id) DO UPDATE SET source_revision=excluded.source_revision, status=excluded.status, error=excluded.error`)
      .run(objectId, revision, status, error ?? null);
    const payload = buildWorkspaceObjectPayload(this.db, objectId);
    if (payload) storeWorkspaceObjectPayload(this.db, payload);
  }

  withProjectionLock<T>(operation: () => T): T {
    return this.transaction(operation);
  }

  deleteProjectionForTest(objectId: string): void { this.db.prepare('DELETE FROM workspace_object_payloads WHERE object_id = ?').run(objectId); }
  markProjectionStaleForTest(objectId: string): void { this.db.prepare('UPDATE workspace_object_payloads SET source_revision = -1 WHERE object_id = ?').run(objectId); }
  hasFreshProjectionForTest(objectId: string): boolean {
    const row = this.db.prepare(`SELECT p.source_revision AS projection_revision, o.revision AS object_revision
      FROM workspace_object_payloads p JOIN workspace_objects o ON o.id=p.object_id WHERE p.object_id=?`).get(objectId) as { projection_revision: number; object_revision: number } | undefined;
    return !!row && row.projection_revision === row.object_revision;
  }
  setSchemaVersionForTest(version: number): void {
    this.db.prepare('DELETE FROM workspace_object_schema_version').run();
    this.db.prepare('INSERT INTO workspace_object_schema_version(version) VALUES (?)').run(version);
  }

  private transaction<T>(operation: () => T): T {
    this.db.runSql('BEGIN IMMEDIATE');
    try {
      const result = operation();
      this.db.runSql('COMMIT');
      return result;
    } catch (error) {
      this.db.runSql('ROLLBACK');
      throw error;
    }
  }

  private refreshProjection(objectId: string, revision: number): void {
    this.db.prepare(`INSERT INTO workspace_object_projection_state(object_id, source_revision, status, error) VALUES (?, ?, 'ready', NULL)
      ON CONFLICT(object_id) DO UPDATE SET source_revision=excluded.source_revision, status='ready', error=NULL`).run(objectId, revision);
    const payload = buildWorkspaceObjectPayload(this.db, objectId);
    if (!payload) throw new Error(`Unable to build projection for ${objectId}`);
    storeWorkspaceObjectPayload(this.db, payload);
  }

  private validateEntry(fields: Map<string, FieldRow>, input: WorkspaceObjectEntryInput): void {
    for (const field of fields.values()) {
      if (field.required === 1 && (input.values[field.id] === undefined || input.values[field.id] === null)) throw new Error(`${field.id} is required`);
    }
    for (const [fieldId, value] of Object.entries(input.values)) {
      const field = fields.get(fieldId);
      if (!field) throw new Error(`Unknown field ${fieldId}`);
      if (value === null) continue;
      if (field.type === 'number' && typeof value !== 'number') throw new Error(`${fieldId} must be a number`);
      if (field.type === 'boolean' && typeof value !== 'boolean') throw new Error(`${fieldId} must be a boolean`);
      if (field.type !== 'number' && field.type !== 'boolean' && typeof value !== 'string') throw new Error(`${fieldId} must be a string`);
      if ((field.type === 'select' || field.type === 'status') && !this.parseOptions(field.options_json).includes(String(value))) throw new Error(`${fieldId} has an unsupported option`);
      if (field.type === 'date' && !isValidIsoDate(String(value))) throw new Error(`${fieldId} must be a valid YYYY-MM-DD date`);
      if (field.type === 'datetime' && !isValidIsoDateTime(String(value))) throw new Error(`${fieldId} must be an ISO datetime with timezone`);
      if (field.type === 'relation') {
        const target = this.db.prepare('SELECT object_id FROM workspace_object_entries WHERE id = ?').get(value) as { object_id: string } | undefined;
        if (!target || target.object_id !== field.relation_object_id) throw new Error(`${fieldId} references an invalid entry`);
      }
    }
  }

  private writeValue(entryId: string, fieldId: string, field: FieldRow, value: WorkspaceObjectValue): void {
    const text = value === null || field.type === 'number' || field.type === 'boolean' ? null : value;
    const number = field.type === 'number' ? value : null;
    const boolean = field.type === 'boolean' && value !== null ? (value ? 1 : 0) : null;
    this.db.prepare(`INSERT INTO workspace_object_values(entry_id, field_id, value_text, value_number, value_boolean) VALUES (?, ?, ?, ?, ?)
      ON CONFLICT(entry_id, field_id) DO UPDATE SET value_text=excluded.value_text, value_number=excluded.value_number, value_boolean=excluded.value_boolean`)
      .run(entryId, fieldId, text, number, boolean);
    this.db.prepare('DELETE FROM workspace_object_relations WHERE source_entry_id=? AND field_id=?').run(entryId, fieldId);
    if (field.type === 'relation' && typeof value === 'string') {
      this.db.prepare('INSERT INTO workspace_object_relations(source_entry_id, field_id, target_entry_id) VALUES (?, ?, ?)').run(entryId, fieldId, value);
    }
  }

  private getFieldRows(objectId: string): Map<string, FieldRow> {
    const rows = this.db.prepare('SELECT id, type, required, options_json, relation_object_id FROM workspace_object_fields WHERE object_id = ?').all(objectId) as FieldRow[];
    return new Map(rows.map(row => [row.id, row]));
  }
  private parseOptions(value: string | null): string[] {
    if (!value) return [];
    const parsed: unknown = JSON.parse(value);
    return Array.isArray(parsed) && parsed.every(option => typeof option === 'string') ? parsed : [];
  }
  private objectExists(objectId: string): boolean { return !!this.db.prepare('SELECT 1 AS ok FROM workspace_objects WHERE id = ?').get(objectId); }
  private assertOwnedByObject(table: 'workspace_object_entries' | 'workspace_object_saved_views', id: string, objectId: string): void {
    const row = this.db.prepare(`SELECT object_id FROM ${table} WHERE id = ?`).get(id) as { object_id: string } | undefined;
    if (row && row.object_id !== objectId) throw new Error(`${id} already belongs to another workspace object`);
  }
  private bumpRevision(objectId: string, now: number): number {
    this.db.prepare('UPDATE workspace_objects SET revision=revision+1, updated_at=? WHERE id=?').run(now, objectId);
    return this.requireRevision(objectId);
  }
  private requireRevision(objectId: string): number {
    const row = this.db.prepare('SELECT revision FROM workspace_objects WHERE id = ?').get(objectId) as ObjectRevisionRow | undefined;
    if (!row) throw new Error(`Unknown object: ${objectId}`);
    return row.revision;
  }
  private requireObject(objectId: string): WorkspaceObjectPayload {
    const payload = this.getObject(objectId);
    if (!payload) throw new Error(`Unknown object: ${objectId}`);
    return payload;
  }
}

function isValidIsoDate(value: string): boolean {
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(value);
  if (!match) return false;
  const year = Number(match[1]);
  const month = Number(match[2]);
  const day = Number(match[3]);
  const parsed = new Date(Date.UTC(year, month - 1, day));
  return parsed.getUTCFullYear() === year && parsed.getUTCMonth() === month - 1 && parsed.getUTCDate() === day;
}

function isValidIsoDateTime(value: string): boolean {
  return /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(?::\d{2}(?:\.\d{1,3})?)?(?:Z|[+-]\d{2}:\d{2})$/.test(value)
    && !Number.isNaN(Date.parse(value));
}
