import Database from 'better-sqlite3';
import { mkdirSync } from 'node:fs';
import path from 'node:path';

import { MIGRATIONS } from './migrations';

export type Db = Database.Database;

/** Applies any migrations newer than the database's user_version, each in its own transaction. */
export function migrate(db: Db): { from: number; to: number } {
  const from = db.pragma('user_version', { simple: true }) as number;
  for (let i = from; i < MIGRATIONS.length; i += 1) {
    const sql = MIGRATIONS[i];
    if (sql === undefined) break;
    db.transaction(() => {
      db.exec(sql);
      db.pragma(`user_version = ${i + 1}`);
    })();
  }
  return { from, to: MIGRATIONS.length };
}

/** Opens (creating if needed) a migrated database. Use ':memory:' in tests. */
export function openDatabase(file: string): Db {
  if (file !== ':memory:') mkdirSync(path.dirname(file), { recursive: true });
  const db = new Database(file);
  db.pragma('foreign_keys = ON');
  if (file !== ':memory:') db.pragma('journal_mode = WAL');
  db.pragma('busy_timeout = 5000');
  migrate(db);
  return db;
}
