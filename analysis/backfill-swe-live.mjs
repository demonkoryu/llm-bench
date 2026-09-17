#!/usr/bin/env node
// Recompute swe_live metrics from evaluation output already on disk, and supersede the stored rows.
//
// WHY THIS EXISTS. readResolved() guessed at the harness's field names (`resolved`/`resolved_ids`)
// where it actually writes `success_ids`. Finding neither, it returned an empty set — so a
// configuration that resolved 8 of 12 was recorded as 0/12. The rollouts and the evaluation were
// both correct and both expensive; only the parse of the verdict file was wrong, so re-running
// anything would burn GPU hours to reproduce data that is already sitting in runs/<config>/eval/.
//
// It SUPERSEDES rather than mutates: new rows are inserted at the same identity with a fresh
// timestamp, and $LATEST's latest-wins projection makes them live while the wrong rows stay as
// history. Editing metric_value in place would erase the evidence that the store ever held a bad
// number, which is exactly the thing worth keeping.
//
// The metrics themselves come from the BENCH (sweMetrics), not from a copy of its formulas kept
// here. The copy is how this file came to emit context and step-cost metrics the bench did not,
// which meant those numbers reached the dashboard only when someone remembered to run this script.
//
// Usage: node analysis/backfill-swe-live.mjs [--apply]
//        (dry run by default — prints what would change)
import { existsSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { loadLedger, loadManifest, scoredInstances, sweMetrics } from '../benches/swe_live.mjs';
import { insertRows, query } from './pg-store.mjs';

const WORK = process.env.SWE_LIVE_WORK ?? '/home/demonkoryu/.local/state/swe-live';
const APPLY = process.argv.includes('--apply');

// The ACTIVE pin, via the bench, so this can never score against a different instance list than the
// one the bench rolls out against.
const manifest = loadManifest();
const instances = scoredInstances(manifest);

// Evaluation wall clock as it stood under the PREVIOUS pin, captured before the sweep that filled
// in the new instances. Absent on a machine that never ran an older pin, which is the normal case.
const SNAPSHOT_FILE = join(WORK, 'eval-seconds-v1.json');
const EVAL_SNAPSHOT = existsSync(SNAPSHOT_FILE) ? JSON.parse(readFileSync(SNAPSHOT_FILE, 'utf8')) : { eval_seconds: {} };

/** Same two-source read as the fixed bench: results.json success_ids, cross-checked per instance. */
function resolvedFrom(evalDir) {
   const out = new Set();
   const rf = join(evalDir, 'results.json');
   if (existsSync(rf)) {
      const j = JSON.parse(readFileSync(rf, 'utf8'));
      for (const id of j.success_ids ?? j.resolved_ids ?? j.resolved ?? []) {
         out.add(id);
      }
   }
   for (const e of readdirSync(evalDir, { withFileTypes: true })) {
      if (!e.isDirectory()) {
         continue;
      }
      const p = join(evalDir, e.name, 'report.json');
      if (existsSync(p)) {
         try {
            const r = JSON.parse(readFileSync(p, 'utf8'));
            if (r.resolved === true) {
               out.add(r.instance_id ?? e.name);
            }
         } catch {}
      }
   }
   return out;
}

const runsDir = join(WORK, 'runs');
for (const cfgDir of readdirSync(runsDir)) {
   const evalDir = join(runsDir, cfgDir, 'eval');
   if (!existsSync(join(evalDir, 'results.json'))) {
      continue;
   }
   const resolved = resolvedFrom(evalDir);
   const k = instances.filter((i) => resolved.has(i.instance_id)).length;
   const n = instances.length;

   // The stored rows for this artifact, so the corrected ones land at the SAME identity.
   //
   // NARROWED TO THE NEWEST HOST, and that is load-bearing. `host` is part of pg-store's identity
   // key, so a configuration measured on `rose` in one sweep and `rose-gpu1` in the next has TWO
   // live row sets — which V100 lane claimed it is not supposed to be a property of the result, but
   // the store cannot know that. Taking them together made `stored.find(metric)` return whichever
   // host sorted first, so the corrected rows were written onto the OTHER host's template: a third,
   // phantom entity carrying a mix of both. That is what happened to Tiel-Coder here, and it also
   // silently defeated the eval-seconds merge, which compares against `stored`.
   //
   // Since 2026-09-17 a row's `host` is the MACHINE, not the lane, so the two V100 targets can no
   // longer split one configuration in two and this normally finds exactly one host. The guard
   // stays because the store is not single-machine by design — m1 is its own machine — and picking
   // arbitrarily among genuinely different machines would be the same bug wearing a different hat.
   const allStored = await query(`SELECT * FROM $LATEST WHERE bench = 'swe_live' AND gguf_file = '${cfgDir}' AND status = 'ok'`);
   if (!allStored.length) {
      console.log(`SKIP ${cfgDir}: eval output present but no stored rows yet (config still running?)`);
      continue;
   }
   const newestHost = allStored.reduce((a, b) => (new Date(b.ts) > new Date(a.ts) ? b : a)).host;
   const stored = allStored.filter((r) => r.host === newestHost);
   if (stored.length !== allStored.length) {
      const others = [...new Set(allStored.filter((r) => r.host !== newestHost).map((r) => r.host))];
      console.log(`     ${cfgDir}: correcting host '${newestHost}'; ${others.join(', ')} also hold rows (retire them separately)`);
   }

   const outDir = join(runsDir, cfgDir);
   // eval_seconds is NOT recomputed from disk: it is a wall clock only the process that ran the
   // evaluation observed, and nothing on disk reconstructs it.
   //
   // It does, however, need MERGING once, and only once. Evaluation is incremental like the
   // rollouts: a pin bump evaluates just the patches for the instances it added, so the bench
   // stores the cost of judging four patches over what was the cost of judging twelve. Published
   // unmerged, "eval min" would report a configuration's 16-instance evaluation as cheaper than its
   // 12-instance one. The pre-bump figures were snapshotted before the sweep (nothing on disk
   // holds them afterwards), and the merge is recorded in the ledger so a second backfill pass does
   // not add them again.
   const ledger = loadLedger(outDir, manifest.run_params);
   const storedEvalS = stored.find((r) => r.metric === 'swe_eval_s')?.metric_value ?? null;
   let evalSeconds = null;
   const priorEvalS = EVAL_SNAPSHOT.eval_seconds?.[cfgDir];
   // storedEvalS === priorEvalS means no new evaluation pass has been recorded yet — the row still
   // holds the previous pin's figure — so there is nothing to merge and adding the snapshot would
   // simply double it. This is what a backfill run BEFORE the sweep looks like.
   if (priorEvalS != null && storedEvalS != null && storedEvalS !== priorEvalS && !ledger.eval_seconds_merged) {
      evalSeconds = priorEvalS + storedEvalS;
      ledger.eval_seconds_merged = {
         total: evalSeconds,
         parts: { [EVAL_SNAPSHOT.pin]: priorEvalS, 'this pin': storedEvalS },
         at: new Date().toISOString(),
      };
      if (APPLY) {
         writeFileSync(join(outDir, 'rollouts.json'), `${JSON.stringify(ledger, null, 2)}\n`);
      }
   }
   const corrected = sweMetrics({ outDir, instances, resolved, ledger, evalSeconds });

   const was = stored.find((r) => r.metric === 'swe_resolved')?.metric_value ?? null;
   const differs = Object.entries(corrected).filter(([metric, v]) => {
      const had = stored.find((r) => r.metric === metric)?.metric_value;
      // Float metrics never compare exactly across a recomputation; anything under a part in a
      // million is the same number arrived at twice, not a change worth superseding a row for.
      return had == null || (typeof v === 'number' && typeof had === 'number' ? Math.abs(v - had) > Math.abs(v) * 1e-9 + 1e-9 : v !== had);
   });
   if (differs.length === 0) {
      console.log(`OK   ${cfgDir}: stored ${k}/${n} already correct`);
      continue;
   }

   const what =
      was === k
         ? `${k}/${n} correct, ${differs.length} metric(s) to update (${differs.map(([m]) => m).join(', ')})`
         : `stored ${was}/${n} → actual ${k}/${n}`;
   console.log(`FIX  ${cfgDir}: ${what}` + (APPLY ? '' : '   (dry run)'));
   if (!APPLY) {
      continue;
   }
   const template = stored[0];
   const ts = new Date().toISOString();
   // NOT filtered to metrics already present: the context/speed metrics are new, so requiring a
   // pre-existing row would silently drop exactly the ones this pass exists to add.
   const rows = Object.entries(corrected)
      .filter(([, v]) => v != null)
      .map(([metric, value]) => {
         const base = stored.find((r) => r.metric === metric) ?? template;
         return { ...base, metric, metric_value: value, ts, run_id: `${base.run_id}-swefix` };
      });
   const res = await insertRows(rows);
   console.log(`     inserted ${rows.length} superseding rows (${res?.inserted ?? rows.length})`);
}
