export const CURRENT_SCHEMA_VERSION = 1;

export const SCHEMA_V1 = `
CREATE TABLE IF NOT EXISTS memories (
  id                TEXT PRIMARY KEY,
  target            TEXT NOT NULL CHECK(target IN ('agent', 'user')),
  category          TEXT NOT NULL CHECK(category IN ('profile','event','knowledge','behavior','skill')),
  content           TEXT NOT NULL,
  content_hash      TEXT NOT NULL,
  reinforcement_count INTEGER NOT NULL DEFAULT 1,
  created_at        INTEGER NOT NULL,
  updated_at        INTEGER NOT NULL,
  last_accessed_at  INTEGER NOT NULL,
  source_session_id TEXT,
  metadata          TEXT DEFAULT '{}',
  UNIQUE(content_hash, target)
);

CREATE INDEX IF NOT EXISTS idx_memories_target ON memories(target);
CREATE INDEX IF NOT EXISTS idx_memories_category ON memories(category);
CREATE INDEX IF NOT EXISTS idx_memories_content_hash ON memories(content_hash);
CREATE INDEX IF NOT EXISTS idx_memories_updated_at ON memories(updated_at);
CREATE INDEX IF NOT EXISTS idx_memories_target_category_updated ON memories(target, category, updated_at);

CREATE TABLE IF NOT EXISTS memory_tags (
  memory_id TEXT NOT NULL REFERENCES memories(id) ON DELETE CASCADE,
  tag       TEXT NOT NULL,
  PRIMARY KEY (memory_id, tag)
);
CREATE INDEX IF NOT EXISTS idx_memory_tags_tag ON memory_tags(tag);

CREATE TABLE IF NOT EXISTS memory_refs (
  source_id TEXT NOT NULL REFERENCES memories(id) ON DELETE CASCADE,
  target_id TEXT NOT NULL REFERENCES memories(id) ON DELETE CASCADE,
  PRIMARY KEY (source_id, target_id)
);

CREATE VIRTUAL TABLE IF NOT EXISTS memories_fts USING fts5(
  content,
  content='memories',
  content_rowid='rowid',
  tokenize='porter unicode61'
);

CREATE TRIGGER IF NOT EXISTS memories_ai AFTER INSERT ON memories BEGIN
  INSERT INTO memories_fts(rowid, content) VALUES (new.rowid, new.content);
END;

CREATE TRIGGER IF NOT EXISTS memories_ad AFTER DELETE ON memories BEGIN
  INSERT INTO memories_fts(memories_fts, rowid, content) VALUES('delete', old.rowid, old.content);
END;

CREATE TRIGGER IF NOT EXISTS memories_au AFTER UPDATE ON memories BEGIN
  INSERT INTO memories_fts(memories_fts, rowid, content) VALUES('delete', old.rowid, old.content);
  INSERT INTO memories_fts(rowid, content) VALUES (new.rowid, new.content);
END;

CREATE TABLE IF NOT EXISTS memory_embeddings (
  memory_id  TEXT PRIMARY KEY REFERENCES memories(id) ON DELETE CASCADE,
  embedding  BLOB NOT NULL,
  dimensions INTEGER NOT NULL,
  provider   TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS processed_turns (
  turn_id      TEXT PRIMARY KEY,
  processed_at INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS schema_version (
  version INTEGER PRIMARY KEY
);
`;

export const MIGRATIONS: Record<number, string> = {
  1: SCHEMA_V1,
};

export function getInitSQL(): string {
  return SCHEMA_V1 + `\nINSERT OR IGNORE INTO schema_version VALUES (${CURRENT_SCHEMA_VERSION});`;
}
