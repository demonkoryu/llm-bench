#!/usr/bin/env node
// ONE-TIME migration: give each already-measured configuration a rollout ledger, so extending the
// pinned subset does not mean re-rolling the instances it already attempted.
//
// WHAT IS RECOVERABLE AND WHAT IS NOT. A rollout leaves its trajectory on disk, and the trajectory
// carries the patch and the exit status — everything needed to score it. The one thing it does not
// carry is how long the rollout took, and that was only ever stored as a per-configuration TOTAL.
// So the ledger gets a `carried` bucket: the instances these rollouts covered, and their combined
// wall clock as the sweep measured it. Per-instance durations for that work are gone, and inventing
// them by dividing the total evenly would be a fabrication dressed as data.
//
// Without this, benches/swe_live.mjs sees no ledger entry for the v1 instances and rolls all twelve
// again for every configuration — roughly 18 GPU-hours to reproduce results already on disk.
//
// Usage: node analysis/seed-swe-live-ledger.mjs [--apply]
//        (dry run by default)
import { existsSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { loadManifest } from '../benches/swe_live.mjs';
import { query } from './pg-store.mjs';

const WORK = process.env.SWE_LIVE_WORK ?? '/home/demonkoryu/.local/state/swe-live';
const APPLY = process.argv.includes('--apply');
const manifest = loadManifest();
const params = manifest.run_params;

// Mirrors budgetOf() in the bench. Duplicated deliberately and only here: a migration that imported
// the live definition would silently re-stamp old work with whatever the budget becomes later,
// which is the one thing a ledger must never do.
const budget = {
   rollout_timeout_s: params.rollout_timeout_s,
   step_limit: params.step_limit,
   ctx: params.ctx,
   agent: params.agent,
   agent_overlay: params.agent_overlay ?? null,
};

const runsDir = join(WORK, 'runs');
for (const cfgDir of readdirSync(runsDir).sort()) {
   const outDir = join(runsDir, cfgDir);
   const ledgerFile = join(outDir, 'rollouts.json');
   if (existsSync(ledgerFile)) {
      console.log(`SKIP ${cfgDir}: already has a ledger`);
      continue;
   }
   // Instances with a trajectory: the work actually done, whatever the pin says today.
   const done = readdirSync(outDir, { withFileTypes: true })
      .filter((e) => e.isDirectory() && existsSync(join(outDir, e.name, `${e.name}.traj.json`)))
      .map((e) => e.name)
      .sort();
   if (done.length === 0) {
      console.log(`SKIP ${cfgDir}: no trajectories on disk`);
      continue;
   }
   const stored = await query(
      `SELECT metric, metric_value FROM $LATEST WHERE bench = 'swe_live' AND gguf_file = '${cfgDir}' AND status = 'ok'`,
   );
   const seconds = stored.find((r) => r.metric === 'swe_rollout_s')?.metric_value ?? null;
   if (seconds == null) {
      // No stored total means the cost of this work is genuinely unknown. Seeding a ledger anyway
      // would let the bench reuse the rollouts while reporting zero seconds for them, and every
      // derived cost — GPU-hours per resolve, seconds per step — would come out flatteringly low.
      console.log(`SKIP ${cfgDir}: ${done.length} trajectories but no stored swe_rollout_s to attribute to them`);
      continue;
   }
   const ledger = {
      schema: 'llm-bench.swe-bench-live.rollouts',
      budget,
      carried: {
         instances: done,
         seconds,
         note:
            `Seeded ${new Date().toISOString().slice(0, 10)} from the stored swe_rollout_s of the ` +
            'subset-v1 sweep (2026-09-16). A bucket, not per-instance timings: only the total was ever recorded.',
      },
      instances: {},
   };
   console.log(`SEED ${cfgDir}: ${done.length} instances, ${seconds}s carried${APPLY ? '' : '   (dry run)'}`);
   if (APPLY) {
      writeFileSync(ledgerFile, `${JSON.stringify(ledger, null, 2)}\n`);
   }
}

// Cross-check against the pin, so a seeded ledger that does not cover the carried-forward instances
// is visible now rather than as a surprise re-roll during the sweep.
const carriedForward = new Set(manifest.instances.map((i) => i.instance_id));
for (const cfgDir of readdirSync(runsDir).sort()) {
   const f = join(runsDir, cfgDir, 'rollouts.json');
   if (!existsSync(f)) {
      continue;
   }
   const l = JSON.parse(readFileSync(f, 'utf8'));
   const covered = new Set([...(l.carried?.instances ?? []), ...Object.keys(l.instances ?? {})]);
   const todo = [...carriedForward].filter((id) => !covered.has(id));
   console.log(`     ${cfgDir}: covers ${covered.size}, ${todo.length} still to roll out`);
}
