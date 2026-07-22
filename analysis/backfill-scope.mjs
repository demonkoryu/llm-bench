// One-off migration: populate the `scope` column on pre-existing measurement rows.
// New rows get `scope` stamped at ingest (shared/tidy-schema.mjs metricRowsFromResult); this
// backfills rows written before the column existed. scope is a pure function of the emitted
// bench name (scopeFor), so the backfill is deterministic and safely re-runnable — it only
// touches rows where scope IS NULL.
// CLI: `node analysis/backfill-scope.mjs`  (npm run scope:backfill)
import { scopeFor } from '../shared/tidy-schema.mjs';
import { ensureSchema, query } from './pg-store.mjs';

const esc = (v) => String(v).replaceAll("'", "''");

await ensureSchema(); // adds the `scope` column to the live table if missing
const benches = (await query('SELECT DISTINCT bench FROM measurements')).map((r) => r.bench);
let updated = 0;
for (const bench of benches) {
   const rows = await query(
      `UPDATE measurements SET scope='${esc(scopeFor(bench))}' WHERE bench='${esc(bench)}' AND scope IS NULL RETURNING 1`,
   );
   updated += rows.length;
}
const dist = await query('SELECT scope, count(*) AS n FROM measurements GROUP BY scope ORDER BY scope');
console.error(`[backfill-scope] updated ${updated} rows across ${benches.length} distinct benches`);
for (const r of dist) {
   console.error(`  scope=${r.scope ?? 'NULL'}: ${r.n}`);
}
process.exit(0);
