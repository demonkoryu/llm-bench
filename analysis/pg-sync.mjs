#!/usr/bin/env node
// Sync the tidy Parquet dataset into central-db's `llmbench.measurements` table.
// Full idempotent refresh (parquet is the source of record). `npm run pg:sync`.
//
// Needs the DB password in the env, e.g. (PowerShell):  $env:LLMBENCH_DB_PASSWORD = '...'
// Read-back is verified through the SAME analysis/query-engine.mjs the dashboards use.
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { pgInfo, query, sync } from './pg-store.mjs';
import * as engine from './query-engine.mjs';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const RESULTS = join(ROOT, 'results');

async function main() {
   console.error(`[pg-sync] target ${pgInfo()}`);
   const { rows } = await sync(RESULTS);
   // Prove the engine reads Postgres unchanged: pull all rows and score them.
   const all = await query('SELECT * FROM $TIDY');
   const lb = engine.leaderboard(all, { think: 'both' });
   console.error(`[pg-sync] ${rows} rows synced · engine over PG: ${all.length} rows, ${lb.entities.length} scored entities`);
}
main().catch((e) => {
   console.error(`[pg-sync] FAILED: ${e.message || e}`);
   process.exit(1);
});
