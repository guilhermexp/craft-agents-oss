import { afterEach, beforeEach, describe, expect, it } from 'bun:test';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { getHermesKanbanDbPath, listKanbanTasksByIds, listKanbanTasksCreatedSince } from './hermes-kanban.ts';

describe('Hermes Kanban task reader', () => {
  let previousCraftHermesHome: string | undefined;
  let previousKanbanHome: string | undefined;
  let previousKanbanBoard: string | undefined;
  let previousKanbanDb: string | undefined;
  let hermesHome: string;

  beforeEach(() => {
    previousCraftHermesHome = process.env.CRAFT_HERMES_HOME;
    previousKanbanHome = process.env.HERMES_KANBAN_HOME;
    previousKanbanBoard = process.env.HERMES_KANBAN_BOARD;
    previousKanbanDb = process.env.HERMES_KANBAN_DB;
    hermesHome = mkdtempSync(join(tmpdir(), 'craft-hermes-kanban-'));
    process.env.CRAFT_HERMES_HOME = hermesHome;
    delete process.env.HERMES_KANBAN_HOME;
    delete process.env.HERMES_KANBAN_BOARD;
    delete process.env.HERMES_KANBAN_DB;
  });

  afterEach(() => {
    restoreEnv('CRAFT_HERMES_HOME', previousCraftHermesHome);
    restoreEnv('HERMES_KANBAN_HOME', previousKanbanHome);
    restoreEnv('HERMES_KANBAN_BOARD', previousKanbanBoard);
    restoreEnv('HERMES_KANBAN_DB', previousKanbanDb);
    rmSync(hermesHome, { recursive: true, force: true });
  });

  function restoreEnv(key: string, value: string | undefined) {
    if (value === undefined) {
      delete process.env[key];
    } else {
      process.env[key] = value;
    }
  }

  it('returns no tasks when the Hermes kanban database is absent', () => {
    expect(listKanbanTasksCreatedSince(0)).toEqual([]);
    expect(listKanbanTasksByIds(['task-1'])).toEqual([]);
  });

  it('resolves the default shared Hermes kanban database', () => {
    expect(getHermesKanbanDbPath()).toBe(join(hermesHome, 'kanban.db'));
  });

  it('honors the selected Hermes kanban board marker', () => {
    const boardDir = join(hermesHome, 'kanban', 'boards', 'project-a');
    mkdirSync(boardDir, { recursive: true });
    writeFileSync(join(boardDir, 'board.json'), '{}\n', 'utf-8');
    mkdirSync(join(hermesHome, 'kanban'), { recursive: true });
    writeFileSync(join(hermesHome, 'kanban', 'current'), 'project-a\n', 'utf-8');

    expect(getHermesKanbanDbPath()).toBe(join(boardDir, 'kanban.db'));
  });

  it('lets explicit Hermes kanban env vars override the selected board', () => {
    const envDb = join(hermesHome, 'custom-kanban.db');
    process.env.HERMES_KANBAN_DB = envDb;
    process.env.HERMES_KANBAN_BOARD = 'ignored-board';

    expect(getHermesKanbanDbPath()).toBe(envDb);
  });
});
