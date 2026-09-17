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
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { loadLedger, loadManifest, scoredInstances, sweMetrics } from '../benches/swe_live.mjs';
import { insertRows, query } from './pg-store.mjs';

const WORK = process.env.SWE_LIVE_WORK ?? '/home/demonkoryu/.local/state/swe-live';
const APPLY = process.argv.includes('--apply');

// The ACTIVE pin, via the bench, so this can never score against a different instance list than the
// one the bench rolls out against.
const manifest = loadManifest();
const instances = scoredInstances(manifest);

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
   const stored = await query(`SELECT * FROM $LATEST WHERE bench = 'swe_live' AND gguf_file = '${cfgDir}' AND status = 'ok'`);
   if (!stored.length) {
      console.log(`SKIP ${cfgDir}: eval output present but no stored rows yet (config still running?)`);
      continue;
   }

   const outDir = join(runsDir, cfgDir);
   // eval_seconds is NOT recomputed: it is a wall clock only the process that ran the evaluation
   // observed, and nothing on disk reconstructs it. Leaving it out keeps the stored row's value
   // live rather than replacing a measurement with a guess.
   const corrected = sweMetrics({ outDir, instances, resolved, ledger: loadLedger(outDir, manifest.run_params) });

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
