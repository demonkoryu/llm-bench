#!/usr/bin/env node
/**
 * Consolidate ALL historical runs into ONE authoritative checkpoint.
 *
 * Why: so there's exactly one run to compare against when tuning dials, the dashboard
 * regenerates from it, and a future `run-suite --resume` sees "config unchanged,
 * nothing to run" — except whatever was never measured for the new dashboard (the
 * coverage gap, e.g. parallel-gen for the fleet score).
 *
 * What it does:
 *   1. loadAllRuns → mergeResultRows (ok beats error, newest ts wins) → authoritative rows.
 *   2. Build the readable server `environment` (the marker) from the current config files.
 *   3. Write ONE new suite run (the checkpoint) with environment + merged results (ts
 *      preserved) + provenance.absorbed; assert no measurement is dropped.
 *   4. Report the coverage gap (per base model × registry metric) so you know exactly
 *      which runner to run next.
 *   5. Retire the absorbed run dirs + legacy CSVs by ARCHIVING them under
 *      results/runs/_archive/ (NOT deleting — these dirs aren't git-tracked), leaving
 *      one active checkpoint. Re-run after a gap-fill to fold it back in.
 *
 * Usage:
 *   node runners/consolidate-checkpoint.mjs [--target rose] [--backend vulkan]
 *        [--no-purge] [--purge-delete] [--dry-run]
 */

import { existsSync, mkdirSync, readdirSync, readFileSync, renameSync, rmSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseArgs } from 'node:util';
import { BENCH_REGISTRY, benchMatches } from '../shared/bench-registry.mjs';
import { loadHostConfig } from '../shared/hosts-config.mjs';
import { loadModelsConfig } from '../shared/models-config.mjs';
import { baseModel, createRun, loadAllRuns, mergeResultRows, runDir } from '../shared/results-store.mjs';
import { buildEnvironment } from '../shared/run-fingerprint.mjs';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const RESULTS_DIR = join(ROOT, 'results');

const { values: flags } = parseArgs({
   options: {
      target: { type: 'string', default: 'rose' },
      backend: { type: 'string', default: 'vulkan' },
      'no-purge': { type: 'boolean', default: false }, // leave absorbed runs in place
      'purge-delete': { type: 'boolean', default: false }, // hard-delete instead of archiving (runs are NOT git-tracked!)
      'dry-run': { type: 'boolean', default: false },
   },
});

const runs = loadAllRuns(RESULTS_DIR);
if (!runs.length) {
   console.error('No runs found under results/runs/. Nothing to consolidate.');
   process.exit(1);
}
const absorbed = runs.map((r) => r.run_id);
const rows = mergeResultRows(runs.flatMap((r) => r.results));
if (!rows.length) {
   console.error('Runs contain no result rows. Nothing to consolidate.');
   process.exit(1);
}

// ── Build the readable server fingerprint (the marker) from current config ──────────
const modelsConfig = loadModelsConfig(join(ROOT, 'config/models.yaml'));
let gpu = null;
try {
   ({ gpu } = loadHostConfig(join(ROOT, 'config/hosts.yaml'), flags.target, { backend: flags.backend }));
} catch {
   /* host not resolvable — environment.gpu stays null */
}
let startServerSh = '';
try {
   startServerSh = readFileSync(join(ROOT, 'scripts/llm2/start-server.sh'), 'utf8');
} catch {
   /* no start-server.sh — server_flags stay null */
}
const environment = buildEnvironment({
   gpu,
   backend: flags.backend,
   startServerShText: startServerSh,
   defaultsExtraFlags: modelsConfig.defaults?.extra_flags ?? null,
});

// ── Coverage gap: per base model, which registry metrics have no measurement ────────
const okByBase = new Map(); // base → Set(bench)
for (const r of rows) {
   if (r.status !== 'ok') {
      continue;
   }
   const b = baseModel(r.model);
   if (!okByBase.has(b)) {
      okByBase.set(b, new Set());
   }
   okByBase.get(b).add(String(r.bench));
}
const baseModels = [...okByBase.keys()].sort();
const gapByRunner = new Map(); // runner → { command, models:Set }
for (const base of baseModels) {
   const present = okByBase.get(base);
   for (const [, e] of Object.entries(BENCH_REGISTRY)) {
      const has = e.benches.some((p) => [...present].some((b) => benchMatches(p, b)));
      if (!has) {
         if (!gapByRunner.has(e.runner)) {
            gapByRunner.set(e.runner, { command: e.command, models: new Set() });
         }
         gapByRunner.get(e.runner).models.add(base);
      }
   }
}

// ── Report ─────────────────────────────────────────────────────────────────────
console.log(`\nConsolidate: ${absorbed.length} run(s) → 1 checkpoint`);
console.log(`  merged ${rows.length} authoritative result rows across ${baseModels.length} base models`);
console.log(
   `  server fingerprint: ${environment.gpu ?? '?'} · ${environment.backend} · fa=${environment.server_flags?.flash_attn ?? '?'} · kv=${environment.server_flags?.cache_type_k ?? '?'}`,
);

if (gapByRunner.size) {
   console.log(`\nCoverage gap — run these to complete the dashboard (esp. parallel-gen for fleet):`);
   for (const [, g] of [...gapByRunner.entries()].sort()) {
      console.log(`  ${g.command}`);
      console.log(`     missing for: ${[...g.models].sort().join(', ')}`);
   }
} else {
   console.log('\nCoverage: every base model has every registry metric — no gap. ✓');
}

if (flags['dry-run']) {
   console.log('\n[dry-run] no checkpoint written, nothing purged.');
   process.exit(0);
}

// ── Write the single checkpoint (ts preserved, status complete) ─────────────────────
const ck = createRun(RESULTS_DIR, {
   host: flags.target,
   gpu,
   backend: flags.backend,
   date: new Date(),
   kind: 'suite',
   environment,
   extra: {
      checkpoint: true,
      provenance: { absorbed, generated: new Date().toISOString() },
      coverage_gap: Object.fromEntries(
         [...gapByRunner].map(([runner, g]) => [runner, { command: g.command, models: [...g.models].sort() }]),
      ),
   },
});
ck.run.results.push(...rows); // merged rows already carry their original ts
const status = ck.finalize('complete');

// Enforcement: no measurement dropped.
if (ck.run.results.length !== rows.length) {
   console.error(
      `[consolidate] FATAL: checkpoint has ${ck.run.results.length} rows but merge produced ${rows.length}. Aborting before purge.`,
   );
   process.exit(1);
}
console.log(`\nCheckpoint written: ${ck.runId} (${status}, ${ck.run.results.length} rows)`);

// ── Retire absorbed runs + legacy CSV format ────────────────────────────────────────
// The runs are merged into the checkpoint, so they no longer belong in the active set.
// IMPORTANT: results/runs/* are NOT git-tracked, so the default is to ARCHIVE (move
// aside), never hard-delete — losing 600+ measured rows would waste real GPU time.
// Archived runs move under results/runs/_archive/, which listRuns() does not enumerate
// (no run.json directly inside it), so they're out of the active set but preserved.
const ARCHIVE = join(RESULTS_DIR, 'runs', '_archive');
if (flags['no-purge']) {
   console.log(
      '[consolidate] --no-purge: absorbed runs left in place (consumers will still merge them — re-run without --no-purge to retire).',
   );
} else {
   const hardDelete = flags['purge-delete'];
   if (!hardDelete) {
      mkdirSync(ARCHIVE, { recursive: true });
   }
   let moved = 0;
   for (const id of absorbed) {
      if (id === ck.runId) {
         continue;
      }
      const dir = runDir(RESULTS_DIR, id);
      if (!existsSync(dir)) {
         continue;
      }
      if (hardDelete) {
         rmSync(dir, { recursive: true, force: true });
      } else {
         const dest = join(ARCHIVE, id);
         rmSync(dest, { recursive: true, force: true }); // clear any prior archive of the same id
         renameSync(dir, dest);
      }
      moved++;
   }
   // Legacy empty CSV format (superseded by JSON runs) — archive/delete it too.
   let csvs = 0;
   if (existsSync(RESULTS_DIR)) {
      for (const f of readdirSync(RESULTS_DIR)) {
         if (!f.endsWith('.csv')) {
            continue;
         }
         if (hardDelete) {
            rmSync(join(RESULTS_DIR, f), { force: true });
         } else {
            renameSync(join(RESULTS_DIR, f), join(ARCHIVE, f));
         }
         csvs++;
      }
   }
   const verb = hardDelete ? 'deleted' : 'archived → results/runs/_archive/';
   console.log(`[consolidate] ${verb} ${moved} absorbed run dir(s)${csvs ? ` + ${csvs} legacy CSV(s)` : ''}.`);
   if (!hardDelete) {
      console.log('[consolidate] (delete results/runs/_archive yourself once you trust the checkpoint, or re-run with --purge-delete.)');
   }
}

console.log('\nNext: node runners/build-report.mjs && node runners/build-dashboard.mjs');
