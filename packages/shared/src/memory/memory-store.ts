import { Database } from 'bun:sqlite';
import { randomUUID } from 'node:crypto';

import type {
  Memory,
  MemoryCategory,
  MemoryTarget,
  MemorySearchOptions,
  MemorySearchResult,
} from './types.ts';
import { RETENTION_DAYS } from './types.ts';
import { getInitSQL } from './schema.ts';
import { computeContentHash } from './deduplication.ts';
import { sanitizeMemoryContent } from './sanitizer.ts';
import { computeSalience, daysBetween } from './salience.ts';

interface MemoryRow {
  id: string;
  target: string;
  category: string;
  content: string;
  content_hash: string;
  reinforcement_count: number;
  created_at: number;
  updated_at: number;
  last_accessed_at: number;
  source_session_id: string | null;
  metadata: string;
}

function rowToMemory(row: MemoryRow, tags: string[], refIds: string[]): Memory {
  return {
    id: row.id,
    target: row.target as MemoryTarget,
    category: row.category as MemoryCategory,
    content: row.content,
    contentHash: row.content_hash,
    tags,
    refIds,
    reinforcementCount: row.reinforcement_count,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    lastAccessedAt: row.last_accessed_at,
    sourceSessionId: row.source_session_id ?? undefined,
    metadata: row.metadata ? JSON.parse(row.metadata) : undefined,
  };
}

export class MemoryStore {
  private db: Database;

  constructor(dbPath?: string) {
    this.db = new Database(dbPath ?? ':memory:', { create: true });
    this.db.run('PRAGMA journal_mode = WAL;');
    this.db.run('PRAGMA foreign_keys = ON;');
  }

  initialize(): void {
    const versionRow = this.db.query(
      "SELECT name FROM sqlite_master WHERE type='table' AND name='schema_version'"
    ).get() as { name: string } | null;

    if (!versionRow) {
      this.db.exec(getInitSQL());
    }

    this.pruneExpired();
  }

  close(): void {
    this.db.close();
  }

  // -- CRUD --

  async upsert(params: {
    target: MemoryTarget;
    category: MemoryCategory;
    content: string;
    tags?: string[];
    refIds?: string[];
    sourceSessionId?: string;
    metadata?: Record<string, unknown>;
  }): Promise<{ memory: Memory; wasReinforced: boolean }> {
    const sanitizeResult = sanitizeMemoryContent(params.content);
    if (!sanitizeResult.safe) {
      throw new Error(sanitizeResult.reason);
    }

    const contentHash = await computeContentHash(params.content, params.target);
    const now = Date.now();

    const existing = this.db.query(
      'SELECT * FROM memories WHERE content_hash = ? AND target = ?'
    ).get(contentHash, params.target) as MemoryRow | null;

    if (existing) {
      this.db.query(
        'UPDATE memories SET reinforcement_count = reinforcement_count + 1, updated_at = ?, last_accessed_at = ? WHERE id = ?'
      ).run(now, now, existing.id);

      const tags = this.getTagsForMemory(existing.id);
      const refIds = this.getRefsForMemory(existing.id);
      const updated = this.db.query('SELECT * FROM memories WHERE id = ?').get(existing.id) as MemoryRow;
      return { memory: rowToMemory(updated, tags, refIds), wasReinforced: true };
    }

    const id = randomUUID();
    this.db.query(`
      INSERT INTO memories (id, target, category, content, content_hash, reinforcement_count, created_at, updated_at, last_accessed_at, source_session_id, metadata)
      VALUES (?, ?, ?, ?, ?, 1, ?, ?, ?, ?, ?)
    `).run(id, params.target, params.category, params.content, contentHash, now, now, now, params.sourceSessionId ?? null, JSON.stringify(params.metadata ?? {}));

    if (params.tags?.length) {
      const insertTag = this.db.query('INSERT OR IGNORE INTO memory_tags (memory_id, tag) VALUES (?, ?)');
      for (const tag of params.tags) {
        insertTag.run(id, tag);
      }
    }

    if (params.refIds?.length) {
      const insertRef = this.db.query('INSERT OR IGNORE INTO memory_refs (source_id, target_id) VALUES (?, ?)');
      for (const refId of params.refIds) {
        insertRef.run(id, refId);
      }
    }

    const memory = rowToMemory(
      this.db.query('SELECT * FROM memories WHERE id = ?').get(id) as MemoryRow,
      params.tags ?? [],
      params.refIds ?? [],
    );
    return { memory, wasReinforced: false };
  }

  get(id: string): Memory | null {
    const row = this.db.query('SELECT * FROM memories WHERE id = ?').get(id) as MemoryRow | null;
    if (!row) return null;

    this.db.query('UPDATE memories SET last_accessed_at = ? WHERE id = ?').run(Date.now(), id);

    return rowToMemory(row, this.getTagsForMemory(id), this.getRefsForMemory(id));
  }

  delete(id: string): boolean {
    const result = this.db.query('DELETE FROM memories WHERE id = ?').run(id);
    return result.changes > 0;
  }

  // -- Search --

  searchFTS(query: string, options?: {
    target?: MemoryTarget;
    category?: MemoryCategory;
    limit?: number;
  }): MemorySearchResult[] {
    const limit = options?.limit ?? 20;
    const now = Date.now();

    const ftsQuery = this.sanitizeFTSQuery(query);
    if (!ftsQuery) return [];

    let sql = `
      SELECT m.*, fts.rank
      FROM memories_fts fts
      JOIN memories m ON m.rowid = fts.rowid
      WHERE memories_fts MATCH ?
    `;
    const sqlParams: (string | number)[] = [ftsQuery];

    if (options?.target) {
      sql += ' AND m.target = ?';
      sqlParams.push(options.target);
    }
    if (options?.category) {
      sql += ' AND m.category = ?';
      sqlParams.push(options.category);
    }

    sql += ' ORDER BY fts.rank LIMIT ?';
    sqlParams.push(limit * 3);

    const rows = this.db.query(sql).all(...sqlParams) as (MemoryRow & { rank: number })[];

    if (rows.length === 0) return [];

    const maxRank = Math.max(...rows.map(r => Math.abs(r.rank)), 1);

    return rows
      .map(row => {
        const similarity = 1 - Math.abs(row.rank) / maxRank;
        const salienceScore = computeSalience({
          similarity: Math.max(0.1, similarity),
          reinforcementCount: row.reinforcement_count,
          daysSinceLastAccess: daysBetween(row.last_accessed_at, now),
          category: row.category as MemoryCategory,
        });
        return {
          memory: rowToMemory(row, this.getTagsForMemory(row.id), this.getRefsForMemory(row.id)),
          salienceScore,
          matchType: 'fts' as const,
        };
      })
      .filter(r => r.salienceScore > 0)
      .sort((a, b) => b.salienceScore - a.salienceScore)
      .slice(0, limit);
  }

  searchHybrid(options: MemorySearchOptions): MemorySearchResult[] {
    return this.searchFTS(options.query, {
      target: options.target,
      category: options.category,
      limit: options.limit,
    }).filter(r => !options.minSalience || r.salienceScore >= options.minSalience);
  }

  // -- Bulk queries --

  getByTarget(target: MemoryTarget, category?: MemoryCategory): Memory[] {
    let sql = 'SELECT * FROM memories WHERE target = ?';
    const sqlParams: (string | number)[] = [target];

    if (category) {
      sql += ' AND category = ?';
      sqlParams.push(category);
    }
    sql += ' ORDER BY updated_at DESC';

    const rows = this.db.query(sql).all(...sqlParams) as MemoryRow[];
    return rows.map(row => rowToMemory(row, this.getTagsForMemory(row.id), this.getRefsForMemory(row.id)));
  }

  getAll(): Memory[] {
    const rows = this.db.query('SELECT * FROM memories ORDER BY updated_at DESC').all() as MemoryRow[];
    return rows.map(row => rowToMemory(row, this.getTagsForMemory(row.id), this.getRefsForMemory(row.id)));
  }

  count(): { agent: number; user: number; total: number } {
    const rows = this.db.query(
      'SELECT target, COUNT(*) as cnt FROM memories GROUP BY target'
    ).all() as { target: string; cnt: number }[];

    const counts = { agent: 0, user: 0, total: 0 };
    for (const row of rows) {
      if (row.target === 'agent') counts.agent = row.cnt;
      if (row.target === 'user') counts.user = row.cnt;
      counts.total += row.cnt;
    }
    return counts;
  }

  // -- Turn tracking --

  hasTurnBeenProcessed(turnId: string): boolean {
    const row = this.db.query('SELECT turn_id FROM processed_turns WHERE turn_id = ?').get(turnId);
    return row != null;
  }

  markTurnProcessed(turnId: string): void {
    this.db.query('INSERT OR IGNORE INTO processed_turns (turn_id, processed_at) VALUES (?, ?)').run(turnId, Date.now());
  }

  // -- Embeddings --

  storeEmbedding(memoryId: string, embedding: Float32Array, provider: string): void {
    const buffer = Buffer.from(embedding.buffer, embedding.byteOffset, embedding.byteLength);
    this.db.query(
      'INSERT OR REPLACE INTO memory_embeddings (memory_id, embedding, dimensions, provider) VALUES (?, ?, ?, ?)'
    ).run(memoryId, buffer, embedding.length, provider);
  }

  getEmbedding(memoryId: string): Float32Array | null {
    const row = this.db.query(
      'SELECT embedding, dimensions FROM memory_embeddings WHERE memory_id = ?'
    ).get(memoryId) as { embedding: Buffer; dimensions: number } | null;
    if (!row) return null;
    return new Float32Array(row.embedding.buffer, row.embedding.byteOffset, row.dimensions);
  }

  // -- Maintenance --

  pruneExpired(): number {
    const now = Date.now();
    let totalPruned = 0;

    for (const [category, days] of Object.entries(RETENTION_DAYS)) {
      if (days === Infinity) continue;
      const cutoff = now - days * 24 * 60 * 60 * 1000;
      const result = this.db.query(
        'DELETE FROM memories WHERE category = ? AND last_accessed_at < ? AND reinforcement_count <= 1'
      ).run(category, cutoff);
      totalPruned += result.changes;
    }
    return totalPruned;
  }

  pruneAndArchive(thresholdSalience: number): number {
    const now = Date.now();
    const all = this.db.query('SELECT * FROM memories').all() as MemoryRow[];
    let pruned = 0;

    for (const row of all) {
      const salience = computeSalience({
        similarity: 1,
        reinforcementCount: row.reinforcement_count,
        daysSinceLastAccess: daysBetween(row.last_accessed_at, now),
        category: row.category as MemoryCategory,
      });

      if (salience < thresholdSalience) {
        this.delete(row.id);
        pruned++;
      }
    }
    return pruned;
  }

  vacuum(): void {
    this.db.run('VACUUM;');
  }

  // -- Helpers --

  private sanitizeFTSQuery(query: string): string {
    const tokens = query
      .replace(/[^\w\s]/g, ' ')
      .split(/\s+/)
      .filter(t => t.length > 0);

    if (tokens.length === 0) return '';
    return tokens.map(t => `"${t}"`).join(' OR ');
  }

  private getTagsForMemory(memoryId: string): string[] {
    const rows = this.db.query('SELECT tag FROM memory_tags WHERE memory_id = ?').all(memoryId) as { tag: string }[];
    return rows.map(r => r.tag);
  }

  private getRefsForMemory(memoryId: string): string[] {
    const rows = this.db.query('SELECT target_id FROM memory_refs WHERE source_id = ?').all(memoryId) as { target_id: string }[];
    return rows.map(r => r.target_id);
  }
}
