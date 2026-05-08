import { existsSync, readFileSync } from 'fs';
import { isAbsolute, join } from 'path';
import { createRequire } from 'module';
import { normalizeHermesRuntimeConfig } from '@craft-agent/shared/hermes/acp-config';

const require = createRequire(import.meta.url);
const DEFAULT_BOARD = 'default';
const BOARD_SLUG_RE = /^[a-z0-9][a-z0-9_-]{0,63}$/;

export interface HermesKanbanTask {
  id: string;
  title: string;
  assignee: string | null;
  status: string;
  result: string | null;
  createdAt: number;
  completedAt: number | null;
}

interface SqliteDatabase {
  prepare(sql: string): {
    all(...params: unknown[]): unknown[];
  };
  close(): void;
}

function normalizeBoardSlug(slug: string | undefined): string | null {
  const normalized = slug?.trim().toLowerCase();
  if (!normalized) return null;
  return BOARD_SLUG_RE.test(normalized) ? normalized : null;
}

export function getHermesKanbanHome(): string {
  return process.env.HERMES_KANBAN_HOME?.trim() || normalizeHermesRuntimeConfig().hermesHome;
}

function boardExists(hermesHome: string, board: string): boolean {
  if (board === DEFAULT_BOARD) return true;
  return existsSync(join(hermesHome, 'kanban', 'boards', board, 'kanban.db'))
    || existsSync(join(hermesHome, 'kanban', 'boards', board, 'board.json'));
}

function getCurrentBoard(hermesHome: string): string {
  const envBoard = normalizeBoardSlug(process.env.HERMES_KANBAN_BOARD);
  if (envBoard) return envBoard;

  try {
    const currentPath = join(hermesHome, 'kanban', 'current');
    if (existsSync(currentPath)) {
      const fromFile = normalizeBoardSlug(readFileSync(currentPath, 'utf-8'));
      if (fromFile && boardExists(hermesHome, fromFile)) return fromFile;
    }
  } catch {
    // Fall through to the default board if the current-board marker is unreadable.
  }

  return DEFAULT_BOARD;
}

export function getHermesKanbanDbPath(): string {
  const explicitDb = process.env.HERMES_KANBAN_DB?.trim();
  if (explicitDb) {
    return isAbsolute(explicitDb) ? explicitDb : join(getHermesKanbanHome(), explicitDb);
  }

  const hermesHome = getHermesKanbanHome();
  const board = getCurrentBoard(hermesHome);
  if (board === DEFAULT_BOARD) return join(hermesHome, 'kanban.db');
  return join(hermesHome, 'kanban', 'boards', board, 'kanban.db');
}

function openKanbanDb(): SqliteDatabase | null {
  const dbPath = getHermesKanbanDbPath();
  if (!existsSync(dbPath)) return null;

  try {
    const { DatabaseSync } = require('node:sqlite') as {
      DatabaseSync: new (path: string, options?: { readOnly?: boolean }) => SqliteDatabase;
    };
    return new DatabaseSync(dbPath, { readOnly: true });
  } catch {
    return null;
  }
}

function rowToTask(row: Record<string, unknown>): HermesKanbanTask {
  return {
    id: String(row.id),
    title: String(row.title),
    assignee: typeof row.assignee === 'string' ? row.assignee : null,
    status: String(row.status),
    result: typeof row.result === 'string' ? row.result : null,
    createdAt: Number(row.created_at),
    completedAt: typeof row.completed_at === 'number' ? row.completed_at : null,
  };
}

export function listKanbanTasksCreatedSince(unixSeconds: number): HermesKanbanTask[] {
  const db = openKanbanDb();
  if (!db) return [];
  try {
    return db.prepare(`
      SELECT id, title, assignee, status, result, created_at, completed_at
      FROM tasks
      WHERE created_at > ?
      ORDER BY created_at ASC
    `).all(unixSeconds)
      .map(row => rowToTask(row as Record<string, unknown>));
  } finally {
    db.close();
  }
}

export function listKanbanTasksByIds(taskIds: string[]): HermesKanbanTask[] {
  if (taskIds.length === 0) return [];
  const db = openKanbanDb();
  if (!db) return [];
  try {
    const placeholders = taskIds.map(() => '?').join(',');
    return db.prepare(`
      SELECT id, title, assignee, status, result, created_at, completed_at
      FROM tasks
      WHERE id IN (${placeholders})
      ORDER BY created_at ASC
    `).all(...taskIds)
      .map(row => rowToTask(row as Record<string, unknown>));
  } finally {
    db.close();
  }
}

export function isTerminalKanbanStatus(status: string): boolean {
  return status === 'done' || status === 'blocked' || status === 'archived';
}
