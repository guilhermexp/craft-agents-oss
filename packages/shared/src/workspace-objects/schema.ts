export const WORKSPACE_OBJECT_SCHEMA_VERSION = 1;

export const WORKSPACE_OBJECT_SCHEMA_V1 = `
CREATE TABLE IF NOT EXISTS workspace_object_schema_version (
  version INTEGER PRIMARY KEY
);
CREATE TABLE IF NOT EXISTS workspace_objects (
  id TEXT PRIMARY KEY,
  slug TEXT NOT NULL UNIQUE,
  name TEXT NOT NULL,
  revision INTEGER NOT NULL DEFAULT 0,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS workspace_object_fields (
  id TEXT PRIMARY KEY,
  object_id TEXT NOT NULL REFERENCES workspace_objects(id) ON DELETE CASCADE,
  name TEXT NOT NULL,
  type TEXT NOT NULL CHECK(type IN ('text','number','boolean','date','datetime','select','status','relation','file')),
  required INTEGER NOT NULL DEFAULT 0,
  options_json TEXT,
  relation_object_id TEXT REFERENCES workspace_objects(id),
  sort_order INTEGER NOT NULL,
  UNIQUE(object_id, name)
);
CREATE TABLE IF NOT EXISTS workspace_object_entries (
  id TEXT PRIMARY KEY,
  object_id TEXT NOT NULL REFERENCES workspace_objects(id) ON DELETE CASCADE,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS workspace_object_values (
  entry_id TEXT NOT NULL REFERENCES workspace_object_entries(id) ON DELETE CASCADE,
  field_id TEXT NOT NULL REFERENCES workspace_object_fields(id) ON DELETE CASCADE,
  value_text TEXT,
  value_number REAL,
  value_boolean INTEGER,
  PRIMARY KEY(entry_id, field_id)
);
CREATE TABLE IF NOT EXISTS workspace_object_relations (
  source_entry_id TEXT NOT NULL REFERENCES workspace_object_entries(id) ON DELETE CASCADE,
  field_id TEXT NOT NULL REFERENCES workspace_object_fields(id) ON DELETE CASCADE,
  target_entry_id TEXT NOT NULL REFERENCES workspace_object_entries(id) ON DELETE CASCADE,
  PRIMARY KEY(source_entry_id, field_id, target_entry_id)
);
CREATE TABLE IF NOT EXISTS workspace_object_saved_views (
  id TEXT PRIMARY KEY,
  object_id TEXT NOT NULL REFERENCES workspace_objects(id) ON DELETE CASCADE,
  name TEXT NOT NULL,
  config_json TEXT NOT NULL,
  revision INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS workspace_object_action_history (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  object_id TEXT NOT NULL REFERENCES workspace_objects(id) ON DELETE CASCADE,
  revision INTEGER NOT NULL,
  action TEXT NOT NULL,
  created_at INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS workspace_object_payloads (
  object_id TEXT PRIMARY KEY REFERENCES workspace_objects(id) ON DELETE CASCADE,
  source_revision INTEGER NOT NULL,
  payload_json TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS workspace_object_projection_state (
  object_id TEXT PRIMARY KEY REFERENCES workspace_objects(id) ON DELETE CASCADE,
  source_revision INTEGER NOT NULL,
  status TEXT NOT NULL CHECK(status IN ('ready','projection-error')),
  error TEXT
);
CREATE INDEX IF NOT EXISTS idx_workspace_object_fields_object ON workspace_object_fields(object_id, sort_order);
CREATE INDEX IF NOT EXISTS idx_workspace_object_entries_object ON workspace_object_entries(object_id);
CREATE INDEX IF NOT EXISTS idx_workspace_object_values_field ON workspace_object_values(field_id);
CREATE INDEX IF NOT EXISTS idx_workspace_object_relations_target ON workspace_object_relations(target_entry_id);
INSERT OR IGNORE INTO workspace_object_schema_version(version) VALUES (1);
`;
