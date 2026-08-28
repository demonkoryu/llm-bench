// One-off repair: retire the coding rows whose think-mode runs measured the TOKEN BUDGET
// rather than the model.
//
// A `coding_no_code` case means the model emitted no extractable code block. At think-time that
// is almost always budget starvation — the reasoning trace consumed max_tokens before the code
// fence — so grading the case 0/N grades the harness. benches/coding.mjs now returns
// status:'invalid' for any bench result with noCode > 0, and $LATEST drops 'invalid'. This script
// applies the same rule retroactively to rows written before it existed.
//
// A no-code case contaminates the WHOLE bench result, not just the coding_no_code metric: the
// pass@1 and test-rate counts from the same run are computed over the same starved cases. So the
// unit of invalidation is the full (run × served config × bench) group, all five leaf metrics.
//
// Non-destructive by design: nothing is deleted. The rows keep their values and stay visible in
// $TIDY for provenance; they just stop being publishable ($LATEST) and stop counting as measured
// (bench-run's resume done-set filters on status='ok'), which is what makes a plain resumed
// re-run re-measure exactly these combos and nothing else.
//
// CLI:  node analysis/invalidate-no-code.mjs           # dry run — reports, changes nothing
//       node analysis/invalidate-no-code.mjs --apply   # performs the UPDATE
import { query } from './pg-store.mjs';

const APPLY = process.argv.includes('--apply');

// The served-configuration identity, plus run_id: two rows agreeing on all of these came out of
// the same bench execution. Mirrors pg-store's IDENTITY_KEY (sans metric/case_id) + run_id.
const GROUP = [
   'run_id', 'gguf_file', 'kv_quant', 'chat_template', 'sampling_hash', 'ctx',
   'n_parallel', 'batch', 'ubatch', 'spec_decode', 'host', 'backend', 'gpu', 'bench', 'think_mode',
];
// IS NOT DISTINCT FROM, not `=`: kv_quant / spec_decode / chat_template are NULL for several
// backends, and a plain equality join drops exactly those rows (it silently reported 25 of the
// 100 affected rows before this was fixed).
const cols = GROUP.map((c) => `"${c}"`).join(', ');
const on = GROUP.map((c) => `m."${c}" IS NOT DISTINCT FROM b."${c}"`).join(' AND ');
const BAD = `SELECT DISTINCT ${cols} FROM measurements WHERE metric = 'coding_no_code' AND metric_value > 0`;

const preview = await query(`
   WITH bad AS (${BAD})
   SELECT m.gguf_file, m.backend, m.quant, m.kv_quant, m.spec_decode, m.bench, m.think_mode,
          m.run_id, count(*) AS rows
   FROM measurements m JOIN bad b ON ${on}
   WHERE m.status = 'ok'
   GROUP BY 1,2,3,4,5,6,7,8 ORDER BY 1,2,4,6`);

let total = 0;
for (const r of preview) {
   total += Number(r.rows);
   const cfg = [r.gguf_file ?? '<no artifact>', r.quant, `kv=${r.kv_quant ?? '-'}`, r.backend, `spec=${r.spec_decode ?? '-'}`].join(' ');
   console.error(`  ${String(r.rows).padStart(2)} rows  ${cfg}  ${r.bench} [${r.think_mode}]  ${r.run_id}`);
}
console.error(`[invalidate-no-code] ${total} rows across ${preview.length} (run × config × bench) groups`);

if (!APPLY) {
   console.error('[invalidate-no-code] DRY RUN — pass --apply to write. Nothing changed.');
   process.exit(0);
}

const done = await query(`
   WITH bad AS (${BAD})
   UPDATE measurements m SET status = 'invalid'
   FROM bad b WHERE ${on} AND m.status = 'ok' RETURNING 1`);
console.error(`[invalidate-no-code] marked ${done.length} rows status='invalid'`);

const left = await query(`SELECT count(*) AS n FROM $LATEST WHERE metric = 'coding_no_code' AND metric_value > 0`);
console.error(`[invalidate-no-code] no-code rows still publishable in $LATEST: ${left[0].n} (expected 0)`);
process.exit(0);
