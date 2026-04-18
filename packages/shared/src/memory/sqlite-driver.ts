/**
 * SQLite driver adapter.
 *
 * Bun's runtime does not yet support the `better-sqlite3` native module
 * (oven-sh/bun#4290), and Node/Electron have no `bun:sqlite`. This module
 * selects the right driver at runtime and exposes a minimal shared API.
 *
 * esbuild must mark both `bun:sqlite` and `better-sqlite3` as external so the
 * un-taken branch stays as a literal `require()` call and is never executed.
 */

export interface SQLiteStatement {
  get(...params: unknown[]): unknown;
  all(...params: unknown[]): unknown[];
  run(...params: unknown[]): { changes: number; lastInsertRowid: number | bigint };
}

export interface SQLiteDatabase {
  prepare(sql: string): SQLiteStatement;
  runSql(sql: string): void;
  pragma(arg: string): void;
  close(): void;
}

declare const Bun: unknown;

export function openSQLite(dbPath: string): SQLiteDatabase {
  if (typeof Bun !== 'undefined') {
    const { Database } = require('bun:sqlite') as typeof import('bun:sqlite');
    const db = new Database(dbPath, { create: true });
    return {
      prepare: (sql: string) => {
        const stmt = db.query(sql);
        return {
          get: (...params: unknown[]) =>
            params.length === 0 ? stmt.get() : stmt.get(...(params as never[])),
          all: (...params: unknown[]) =>
            params.length === 0 ? stmt.all() : stmt.all(...(params as never[])),
          run: (...params: unknown[]) => {
            const res = params.length === 0 ? stmt.run() : stmt.run(...(params as never[]));
            return { changes: res.changes, lastInsertRowid: res.lastInsertRowid };
          },
        };
      },
      runSql: (sql: string) => db.exec(sql),
      pragma: (arg: string) => db.run(`PRAGMA ${arg};`),
      close: () => db.close(),
    };
  }

  const Database = require('better-sqlite3');
  const db = new Database(dbPath);
  return {
    prepare: (sql: string) => db.prepare(sql),
    runSql: (sql: string) => db.exec(sql),
    pragma: (arg: string) => db.pragma(arg),
    close: () => db.close(),
  };
}
