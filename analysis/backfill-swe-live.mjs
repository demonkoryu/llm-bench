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
// Usage: node analysis/backfill-swe-live.mjs [--apply]
//        (dry run by default — prints what would change)
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { trajectoryStats } from '../benches/swe_live.mjs';
import { insertRows, query } from './pg-store.mjs';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const WORK = process.env.SWE_LIVE_WORK ?? '/home/demonkoryu/.local/state/swe-live';
const MANIFEST = join(ROOT, 'benchmarks', 'swe-bench-live', 'subset-v1.json');
const APPLY = process.argv.includes('--apply');

const manifest = JSON.parse(readFileSync(MANIFEST, 'utf8'));
const instances = manifest.instances.filter((i) => manifest.gold_validated.resolvable.includes(i.instance_id));

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
   const was = stored.find((r) => r.metric === 'swe_resolved')?.metric_value ?? null;
   const hasStats = stored.some((r) => r.metric === 'swe_ctx_per_resolve');
   if (was === k && hasStats) {
      console.log(`OK   ${cfgDir}: stored ${k}/${n} already correct`);
      continue;
   }

   // Context and step cost, read from the trajectories. Added after the first full sweep, so
   // configurations measured before the bench emitted them get them here rather than by re-running
   // 10 hours of rollouts to recover numbers the trajectories already contain.
   const stats = trajectoryStats(join(runsDir, cfgDir));
   const rollout = stored.find((r) => r.metric === 'swe_rollout_s')?.metric_value ?? null;

   const byLang = {};
   for (const i of instances) {
      byLang[i.language] ??= { n: 0, k: 0 };
      byLang[i.language].n += 1;
      if (resolved.has(i.instance_id)) {
         byLang[i.language].k += 1;
      }
   }
   const corrected = {
      ...(k && rollout ? { swe_gpu_h_per_resolve: rollout / 3600 / k } : {}),
      ...(stats
         ? {
              ...(k ? { swe_ctx_per_resolve: Math.round(stats.ctxTotal / k) } : {}),
              swe_ctx_median: stats.ctxMedian,
              swe_ctx_max: stats.ctxMax,
              swe_calls: stats.calls,
              swe_s_per_call: stats.calls && rollout ? rollout / stats.calls : null,
              swe_gen_tok_s: rollout ? stats.generated / rollout : null,
           }
         : {}),
      swe_resolved: k,
      swe_total: n,
      swe_rate: n ? k / n : null,
      ...Object.fromEntries(Object.entries(byLang).map(([l, v]) => [`swe_lang_${l}`, v.n ? v.k / v.n : null])),
   };

   const what = was === k ? `${k}/${n} correct, adding context/speed metrics` : `stored ${was}/${n} → actual ${k}/${n}`;
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
