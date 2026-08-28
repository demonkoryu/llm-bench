// One-off repair: retire every think-mode coding measurement taken under the PRE-32K regime.
//
// Context. The coding benches' think-time token budget was raised to 32768 on 2026-08-28
// (benches/coding.mjs, was 8192/8192/16384). A 32k budget is only real at ctx >= ~40k — at the
// ctx=16384 most of these rows were measured at, the server clamps generation to what is left of
// the window and the "32k budget" would be fiction. So the re-measurement runs at ctx=40960.
//
// Why the old rows cannot simply be left to be superseded: `ctx` IS part of pg-store's
// IDENTITY_KEY (so a ctx=40960 row does NOT supersede a ctx=16384 one — different identity) but is
// NOT part of scoring-config's ENTITY_DIMS (so both land in the SAME scored entity, and score.mjs
// AVERAGES them). That combination is precisely the "ROW FORK" the dashboard's measurements loader
// warns about: the published coding grade would silently become the mean of a starved 16k run and
// a healthy 40k one. Retiring the old rows is what keeps the re-measurement clean.
//
// Scope is deliberately narrow: think_mode='think' AND bench LIKE 'coding%'. no_think coding rows
// are untouched — their budgets (4096/8192) were never think-dependent and never starved, so they
// remain valid as measured. Nothing is deleted; rows keep their values in $TIDY for provenance and
// only stop being publishable ($LATEST drops 'invalid') and stop counting as measured (bench-run's
// resume done-set filters status='ok').
//
// CLI:  node analysis/invalidate-stale-think-coding.mjs           # dry run
//       node analysis/invalidate-stale-think-coding.mjs --apply
import { query } from './pg-store.mjs';

const APPLY = process.argv.includes('--apply');
const WHERE = `bench LIKE 'coding%' AND think_mode = 'think' AND status = 'ok'`;

const preview = await query(`
   SELECT model, quant, kv_quant, backend, spec_decode, ctx, bench, count(*) AS rows
   FROM measurements WHERE ${WHERE}
   GROUP BY 1,2,3,4,5,6,7 ORDER BY 1,3,4,7`);

let total = 0;
for (const r of preview) {
   total += Number(r.rows);
   console.error(
      `  ${String(r.rows).padStart(2)} rows  ${(r.model ?? '?').padEnd(18)} ${(r.quant ?? '').padEnd(14)} ` +
         `kv=${String(r.kv_quant ?? '-').padEnd(6)} ${r.backend.padEnd(12)} ctx=${String(r.ctx).padEnd(6)} ${r.bench}`,
   );
}
console.error(`[invalidate-stale-think-coding] ${total} rows across ${preview.length} (config × bench) groups`);

if (!APPLY) {
   console.error('[invalidate-stale-think-coding] DRY RUN — pass --apply to write. Nothing changed.');
   process.exit(0);
}

const done = await query(`UPDATE measurements SET status = 'invalid' WHERE ${WHERE} RETURNING 1`);
console.error(`[invalidate-stale-think-coding] marked ${done.length} rows status='invalid'`);

const left = await query(`SELECT count(*) AS n FROM $LATEST WHERE bench LIKE 'coding%' AND think_mode = 'think'`);
console.error(`[invalidate-stale-think-coding] think-mode coding rows publishable in $LATEST: ${left[0].n} (expected 0 until the re-run lands)`);
process.exit(0);
