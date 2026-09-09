// One-off repair: retire the Nemotron-3-Nano-4B rows measured on target `rose` before the
// 2026-09-09 re-measure on `rose-gpu1`.
//
// Context. Nemotron was measured 2026-08-27 on target `rose` (device 0) under llama.cpp
// f280b2698, and re-measured 2026-09-09 on target `rose-gpu1` (device 1) under 9cf3bf256 for the
// Ling-3.0-tiny head-to-head. Both row sets are live at once.
//
// Why the old rows cannot simply be left to be superseded: `host` IS part of pg-store's
// IDENTITY_KEY (so a rose-gpu1 row does NOT supersede a rose one — different identity) but is NOT
// part of scoring-config's ENTITY_DIMS, which keys on `gpu`. hosts.yaml deliberately gives both
// targets the SAME `gpu: V100` slug, because they are the same silicon and their rows are meant to
// be comparable. So both land in ONE scored entity and score.mjs AVERAGES them — the published
// triage_C1 (think) became the mean of 0.78 (f280b2698) and 0.61 (9cf3bf256), and the leaderboard's
// agent-pool / fit-ctx / VRAM columns showed August device-0 numbers next to September quality
// scores. This is exactly the "ROW FORK" the dashboard's measurements loader warns about, and it
// went unreported because identity-forks.mjs grouped BY host and so never compared the two. That
// blind spot is fixed in the same change that added this script; `host` is now a DETAIL_DIM.
//
// Scope is deliberately narrow: ONE gguf, ONE host, ONE build. Ling has no rose rows (it is new),
// and every other model's rose rows are its only measurement — retiring those would blank them from
// the dashboard rather than de-duplicate anything. The re-measure covers every bench the old rows
// covered, so nothing is lost from the board.
//
// Nothing is deleted. Rows keep their values in $TIDY for provenance and only stop being
// publishable ($LATEST drops 'invalid') and stop counting as measured (bench-run's resume done-set
// filters status='ok').
//
// CLI:  node analysis/invalidate-superseded-host.mjs           # dry run
//       node analysis/invalidate-superseded-host.mjs --apply
import { query } from './pg-store.mjs';

const APPLY = process.argv.includes('--apply');
const WHERE = `gguf_file = 'nvidia_Nemotron-3-Nano-4B-Q8_0.gguf'
   AND host = 'rose'
   AND llamacpp_build LIKE '%f280b2698%'
   AND status = 'ok'`;

const preview = await query(`
   SELECT bench, think_mode, count(*) AS rows
   FROM measurements WHERE ${WHERE}
   GROUP BY 1,2 ORDER BY 1,2`);

let total = 0;
for (const r of preview) {
   total += Number(r.rows);
   console.error(`  ${String(r.rows).padStart(3)} rows  ${r.bench.padEnd(22)} ${r.think_mode ?? '-'}`);
}
console.error(`[invalidate-superseded-host] ${total} rows across ${preview.length} (bench × think) groups`);

// Guard: only retire what the re-measure actually replaced. A bench present on rose but absent on
// rose-gpu1 would go blank on the dashboard, which is a loss, not a de-duplication — so say so
// loudly rather than discovering it after the fact on the published page.
const orphans = await query(`
   SELECT DISTINCT bench FROM measurements
   WHERE ${WHERE}
     AND bench NOT IN (
        SELECT DISTINCT bench FROM measurements
        WHERE gguf_file = 'nvidia_Nemotron-3-Nano-4B-Q8_0.gguf' AND host = 'rose-gpu1' AND status = 'ok')
   ORDER BY 1`);
if (orphans.length) {
   console.error(`[invalidate-superseded-host] WARNING: ${orphans.length} bench(es) exist on rose but NOT on rose-gpu1 —`);
   console.error('[invalidate-superseded-host] retiring these blanks them from the dashboard instead of de-duplicating:');
   for (const o of orphans) {
      console.error(`[invalidate-superseded-host]   ${o.bench}`);
   }
   console.error('[invalidate-superseded-host] Re-measure them on rose-gpu1 first, or narrow WHERE to exclude them.');
}

if (!APPLY) {
   console.error('[invalidate-superseded-host] DRY RUN — pass --apply to write. Nothing changed.');
   process.exit(0);
}

const done = await query(`UPDATE measurements SET status = 'invalid' WHERE ${WHERE} RETURNING 1`);
console.error(`[invalidate-superseded-host] marked ${done.length} rows status='invalid'`);

const left = await query(
   `SELECT count(*) AS n FROM $LATEST WHERE gguf_file = 'nvidia_Nemotron-3-Nano-4B-Q8_0.gguf' AND host = 'rose'`,
);
console.error(`[invalidate-superseded-host] rose rows still publishable in $LATEST: ${left[0].n} (expected 0)`);
process.exit(0);
