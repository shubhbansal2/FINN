// Builds a fresh demo-mode database for end-to-end tests from the committed fixtures.
// Deterministic: recorded provider responses only, no network, fixed demo clock.
import { spawnSync } from 'node:child_process';
import { rmSync } from 'node:fs';
import path from 'node:path';

import Database from 'better-sqlite3';

const dataDir = path.resolve(process.env.FINN_DATA_DIR ?? '.e2e-data');
rmSync(dataDir, { recursive: true, force: true });

const env = { ...process.env, FINN_DATA_MODE: 'fixture', FINN_DATA_DIR: dataDir };
for (const command of ['migrate', 'universe:sync', 'ingest:prices', 'ingest:filings']) {
  const r = spawnSync('npx', ['tsx', '--tsconfig', 'tsconfig.json', 'scripts/finn.ts', command], { env, stdio: 'inherit', shell: true });
  if (r.status !== 0) throw new Error(`seed step failed: ${command}`);
}

// One data source made unavailable on purpose: no price history for Asian Paints.
const db = new Database(path.join(dataDir, 'finn-fixture.sqlite'));
const removed = db.prepare(`DELETE FROM price_bar WHERE listing_id IN (SELECT id FROM listing WHERE company_id = 'nse:asianpaint')`).run().changes;
db.close();
console.log(`e2e seed ready in ${dataDir}; removed ${removed} Asian Paints price bars to simulate an unavailable price source`);
