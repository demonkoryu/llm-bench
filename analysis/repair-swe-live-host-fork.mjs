#!/usr/bin/env node
// One-off repair: collapse the swe_live host forks the subset-v2 sweep created, and finish the one
// evaluation-cost merge that the fork made the backfill skip.
//
// WHAT HAPPENED. The sweep runs two lanes over a SHARED work queue, so whichever card frees up next
// takes the next configuration -- deliberately, so neither GPU idles. But the two lanes use
// different target names for the same silicon (`rose` for device 0, `rose-gpu1` for device 1), and
// `host` is part of pg-store's IDENTITY_KEY. A configuration that drew device 1 in the v1 sweep and
// device 0 in the v2 sweep therefore did not SUPERSEDE its old rows, it sat down beside them: two
// complete row sets, one 12-instance and one 16-instance, both live in $LATEST.
//
// Muse-Glimmer (rose-gpu1 in v1, rose in v2) and Tiel-Coder (rose in v1, rose-gpu1 in v2) both
// swapped cards. The published page showed Muse-Glimmer at its OLD 5/12 because the summary keyed
// on the artifact alone and took whichever of the two rows came back last.
//
// AND IT COMPOUNDED. analysis/backfill-swe-live.mjs looks its stored rows up by artifact, not by
// (artifact, host), so with a fork present it read `swe_eval_s` from an arbitrary one of the two.
// For Tiel-Coder it read the v1 figure, which equalled the pre-sweep snapshot, so the "has a new
// pass been recorded yet?" guard concluded no and skipped the merge. Its evaluation cost is
// therefore still the v1 pass alone. (The backfill is fixed in the same change; this repairs the
// row it already wrote.)
//
// WHICH SIDE WINS: the host the most recent real bench-run wrote to. The rollouts, the ledger and
// the trajectories are per-configuration and card-independent -- the same work would have produced
// the same numbers on either device -- so this is picking which LABEL the one measurement keeps,
// not choosing between two measurements.
//
// Nothing is deleted. Retired rows keep their values in $TIDY for provenance and only stop being
// publishable ($LATEST drops 'invalid').
//
// CLI:  node analysis/repair-swe-live-host-fork.mjs           # dry run
//       node analysis/repair-swe-live-host-fork.mjs --apply
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { insertRows, query } from './pg-store.mjs';

const WORK = process.env.SWE_LIVE_WORK ?? '/home/demonkoryu/.local/state/swe-live';
const APPLY = process.argv.includes('--apply');

// artifact -> the host to RETIRE. The other side is the current measurement.
const RETIRE = {
   'Muse-Glimmer-30B-UD-Q5_K_XL.gguf': 'rose-gpu1', // v1 ran on device 1; v2 on device 0
   'Tiel-Coder-35B-A3B-MTP-UD-Q4_K_XL.gguf': 'rose', // v1 ran on device 0; v2 on device 1
};

for (const [gguf, staleHost] of Object.entries(RETIRE)) {
   const rows = await query(
      `SELECT host, metric, metric_value FROM $LATEST WHERE bench = 'swe_live' AND status = 'ok' AND gguf_file = '${gguf}'`,
   );
   const byHost = {};
   for (const r of rows) {
      byHost[r.host] ??= {};
      byHost[r.host][r.metric] = r.metric_value;
   }
   const keepHost = Object.keys(byHost).find((h) => h !== staleHost);
   if (!keepHost) {
      console.log(`SKIP ${gguf}: no fork present (hosts: ${Object.keys(byHost).join(', ') || 'none'})`);
      continue;
   }
   // Guard: never retire the side that has MORE of the pin. Getting the two backwards would publish
   // a 12-instance result over a 16-instance one, which is the very failure being repaired.
   const keepTotal = byHost[keepHost].swe_total ?? 0;
   const staleTotal = byHost[staleHost].swe_total ?? 0;
   if (keepTotal < staleTotal) {
      console.log(`REFUSE ${gguf}: keeping ${keepHost} (n=${keepTotal}) would discard ${staleHost} (n=${staleTotal})`);
      continue;
   }
   console.log(
      `FORK ${gguf}: keep ${keepHost} ${byHost[keepHost].swe_resolved}/${keepTotal}, ` +
         `retire ${staleHost} ${byHost[staleHost].swe_resolved}/${staleTotal}`,
   );
   if (APPLY) {
      const done = await query(
         `UPDATE measurements SET status = 'invalid'
          WHERE bench = 'swe_live' AND gguf_file = '${gguf}' AND host = '${staleHost}' AND status = 'ok' RETURNING 1`,
      );
      console.log(`     retired ${done.length} rows on ${staleHost}`);
   }

   // Finish the evaluation-cost merge the fork made the backfill skip. The kept side holds only its
   // own pass; the retired side holds the pass before it, and the configuration's patches were
   // judged in both.
   const ledgerFile = join(WORK, 'runs', gguf, 'rollouts.json');
   const ledger = existsSync(ledgerFile) ? JSON.parse(readFileSync(ledgerFile, 'utf8')) : null;
   if (!ledger || ledger.eval_seconds_merged) {
      console.log('     eval cost already merged, leaving it alone');
      continue;
   }
   const priorEvalS = byHost[staleHost].swe_eval_s;
   const thisEvalS = byHost[keepHost].swe_eval_s;
   if (priorEvalS == null || thisEvalS == null) {
      console.log('     no eval seconds on one side, nothing to merge');
      continue;
   }
   const total = priorEvalS + thisEvalS;
   console.log(`     eval cost ${thisEvalS}s (this pin) + ${priorEvalS}s (previous pin) = ${total}s`);
   if (!APPLY) {
      continue;
   }
   const template = await query(
      `SELECT * FROM $LATEST WHERE bench = 'swe_live' AND status = 'ok'
       AND gguf_file = '${gguf}' AND host = '${keepHost}' AND metric = 'swe_eval_s'`,
   );
   await insertRows([
      { ...template[0], metric_value: total, ts: new Date().toISOString(), run_id: `${template[0].run_id}-forkfix` },
   ]);
   ledger.eval_seconds_merged = {
      total,
      parts: { 'previous pin': priorEvalS, 'this pin': thisEvalS },
      at: new Date().toISOString(),
      note: 'merged by repair-swe-live-host-fork.mjs; the host fork hid the previous pin from the backfill',
   };
   writeFileSync(ledgerFile, `${JSON.stringify(ledger, null, 2)}\n`);
   console.log('     superseded swe_eval_s and recorded the merge in the ledger');
}
