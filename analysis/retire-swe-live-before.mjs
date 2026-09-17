#!/usr/bin/env node
// Retire every swe_live row measured before a given instant, so the published rate comes from one
// agent configuration rather than a blend of two.
//
// WHY A TIMESTAMP AND NOT A PIN VERSION. Rows do not record which pin produced them -- the pin fixes
// the instances and the budget, but a measurement row carries only its own dimensions. The sweep
// that establishes a new configuration has a start time, and everything older than it was measured
// under the previous one. Crude, and exactly as precise as it needs to be: the cut is per bench, and
// swe_live has no other writer.
//
// THE CASE THIS WAS BUILT FOR. v5 drops the observation-truncation overlay that v1-v4 merged, so the
// model sees 10,000 characters of command output where it used to see 4,000. That changes what the
// agent perceived at every single step, which makes an old rollout not a worse measurement but a
// measurement of a different thing. Latest-wins would have hidden the problem rather than fixed it:
// a configuration whose v5 sweep failed halfway would keep serving its 4,000-char rows beside five
// configurations' 10,000-char ones, and nothing on the page would say so.
//
// Nothing is deleted. Retired rows keep their values in $TIDY for provenance and only stop being
// publishable ($LATEST drops 'invalid') and stop counting as measured (bench-run's resume done-set
// filters status='ok').
//
// CLI:  node analysis/retire-swe-live-before.mjs --before 2026-09-17T12:30:00Z
//       node analysis/retire-swe-live-before.mjs --before 2026-09-17T12:30:00Z --apply
import { query } from './pg-store.mjs';

const args = process.argv.slice(2);
const APPLY = args.includes('--apply');
const before = args[args.indexOf('--before') + 1];
if (!args.includes('--before') || !before || Number.isNaN(Date.parse(before))) {
   console.error('usage: retire-swe-live-before.mjs --before <ISO-8601 instant> [--apply]');
   process.exit(2);
}
const cut = new Date(before).toISOString();

const older = await query(`SELECT gguf_file, count(*) AS n FROM $TIDY
   WHERE bench = 'swe_live' AND status = 'ok' AND ts < '${cut}' GROUP BY 1 ORDER BY 1`);
const newer = await query(`SELECT gguf_file, count(*) AS n FROM $TIDY
   WHERE bench = 'swe_live' AND status = 'ok' AND ts >= '${cut}' GROUP BY 1 ORDER BY 1`);
const keep = new Map(newer.map((r) => [r.gguf_file, Number(r.n)]));

console.log(`swe_live rows older than ${cut}:`);
let total = 0;
for (const r of older) {
   total += Number(r.n);
   console.log(`  ${String(r.n).padStart(4)} rows  ${r.gguf_file}   (newer rows: ${keep.get(r.gguf_file) ?? 0})`);
}
console.log(`${total} row(s) to retire.`);

// Refuse to blank a configuration. Retiring rows that nothing replaces does not de-duplicate
// anything -- it deletes a result from the page, which is a different and much worse act than the
// one intended here. This is the guard that catches a sweep that died halfway.
const orphans = older.filter((r) => !keep.has(r.gguf_file)).map((r) => r.gguf_file);
if (orphans.length) {
   console.error(`REFUSING: ${orphans.length} configuration(s) have NO rows at or after the cut:`);
   for (const o of orphans) {
      console.error(`   ${o}`);
   }
   console.error('Retiring these would blank them from the dashboard rather than supersede them.');
   console.error('Re-measure them first, or move the cut.');
   process.exit(1);
}
if (total === 0) {
   console.log('Nothing to do.');
   process.exit(0);
}
if (!APPLY) {
   console.log('DRY RUN -- pass --apply to write. Nothing changed.');
   process.exit(0);
}

const done = await query(
   `UPDATE measurements SET status = 'invalid'
    WHERE bench = 'swe_live' AND status = 'ok' AND ts < '${cut}' RETURNING 1`,
);
console.log(`retired ${done.length} row(s)`);
const left = await query("SELECT count(DISTINCT gguf_file) AS n FROM $LATEST WHERE bench = 'swe_live' AND status = 'ok'");
console.log(`configurations still publishable: ${left[0].n}`);
