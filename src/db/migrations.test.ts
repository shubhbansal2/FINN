// @vitest-environment node
import Database from 'better-sqlite3';
import { describe, expect, it } from 'vitest';

import { migrate, openDatabase } from './connection';
import { MIGRATIONS } from './migrations';
import { addToWatchlist, ensureWatchlist, getPreference, listCompanies, removeFromWatchlist, setPreference, upsertCompany, watchlistIds } from './repositories';

const T = '2026-11-01T00:00:00.000Z';

function company(db: ReturnType<typeof openDatabase>, id: string, role: 'portfolio' | 'research') {
  upsertCompany(db, { id, name: id.toUpperCase(), sector: 'Test', size: 'large', reportingProfile: 'unknown', role, irDomains: [], listings: [{ exchange: 'NSE', symbol: id.slice(4).toUpperCase() }] }, T);
}

describe('schema migrations', () => {
  it('migrates a fresh database to the latest version and is idempotent', () => {
    const db = new Database(':memory:');
    expect(migrate(db)).toEqual({ from: 0, to: MIGRATIONS.length });
    expect(db.pragma('user_version', { simple: true })).toBe(MIGRATIONS.length);
    expect(migrate(db)).toEqual({ from: MIGRATIONS.length, to: MIGRATIONS.length });
  });

  it('upgrades a database left at an older version without losing rows', () => {
    const db = new Database(':memory:');
    db.pragma('foreign_keys = ON');
    // Apply all but the last migration, store a row, then upgrade.
    for (let i = 0; i < MIGRATIONS.length - 1; i += 1) {
      db.exec(MIGRATIONS[i] ?? '');
      db.pragma(`user_version = ${i + 1}`);
    }
    db.prepare(`INSERT INTO company (id, name, sector, size, reporting_profile, role, ir_domains, created_at, updated_at) VALUES ('nse:x', 'X', 's', 'large', 'unknown', 'portfolio', '[]', ?, ?)`).run(T, T);
    expect(migrate(db).from).toBe(MIGRATIONS.length - 1);
    expect(db.prepare(`SELECT COUNT(*) AS n FROM company`).get()).toEqual({ n: 1 });
  });

  it('enforces CHECK and foreign-key constraints', () => {
    const db = openDatabase(':memory:');
    expect(() => db.prepare(`INSERT INTO company (id, name, sector, size, reporting_profile, role, ir_domains, created_at, updated_at) VALUES ('nse:y', 'Y', 's', 'huge', 'unknown', 'portfolio', '[]', ?, ?)`).run(T, T)).toThrow(/CHECK/);
    expect(() => db.prepare(`INSERT INTO watchlist_entry (company_id, added_at) VALUES ('nse:missing', ?)`).run(T)).toThrow(/FOREIGN KEY/);
    expect(() => setPreference(db, 'k'.repeat(65), 'v', T)).toThrow(/CHECK/);
  });
});

describe('watchlist persistence', () => {
  it('seeds from the portfolio once, then keeps user changes, including an empty list', () => {
    const db = openDatabase(':memory:');
    ensureWatchlist(db, T); // no companies yet: nothing seeded, not marked as seeded
    expect(getPreference(db, 'watchlist.seeded')).toBeNull();
    company(db, 'nse:aaa', 'portfolio');
    company(db, 'nse:bbb', 'portfolio');
    company(db, 'nse:ccc', 'research');
    ensureWatchlist(db, T);
    expect(watchlistIds(db)).toEqual(['nse:aaa', 'nse:bbb']);

    expect(addToWatchlist(db, 'nse:ccc', T)).toBe(true);
    expect(addToWatchlist(db, 'nse:unknown', T)).toBe(false);
    removeFromWatchlist(db, 'nse:aaa');
    removeFromWatchlist(db, 'nse:bbb');
    removeFromWatchlist(db, 'nse:ccc');
    ensureWatchlist(db, T); // must not re-seed an emptied watchlist
    expect(watchlistIds(db)).toEqual([]);
    expect(listCompanies(db, { watchlist: true })).toEqual([]);
  });
});
