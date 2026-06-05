#!/usr/bin/env node
/**
 * judge-merge.mjs — record judge verdict scores as their own immutable run.
 *
 * Reads results/judge/<modelId>.verdict.json files written by the judge subagents
 * and writes ONE run (kind 'judge') with a `judge` row per model. Like every other
 * secondary runner it never mutates the run it read from — build-report merges runs
 * deterministically, and `judge` is a base-model-keyed (think-independent) bench.
 *
 * Verdict file schema (results/judge/<modelId>.verdict.json):
 *   {
 *     model_id:    string,
 *     judge_score: number,       // 0-10 overall quality score
 *     per_bench: {
 *       summarization?: number,  // 0-10
 *       docqa?:         number,  // 0-10
 *       reasoning?:     number,  // 0-10
 *     },
 *     reasoning:   string,       // brief judge rationale
 *     flagged_outputs: string[], // case_ids with notable issues
 *   }
 *
 * Each verdict becomes a row: { model, think:'n/a', bench:'judge', score:<0-10>,
 * notes:<per-bench breakdown> }. The model id is normalized to the base model
 * (provider prefix + think suffix stripped) so it keys like the other shared benches.
 *
 * Usage:
 *   node runners/judge-merge.mjs
 *   node runners/judge-merge.mjs --verdicts results/judge --input <seed-run-id>
 */

import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseArgs } from 'node:util';
import { baseModel, openSecondaryRun } from '../shared/results-store.mjs';

const __dir = dirname(fileURLToPath(import.meta.url));
const ROOT = join(__dir, '..');
const RESULTS_DIR = join(ROOT, 'results');

const { values: flags } = parseArgs({
   options: {
      verdicts: { type: 'string', default: join(ROOT, 'results/judge') },
      input: { type: 'string' }, // seed run to read provenance from (default: newest)
      target: { type: 'string', default: 'rose' },
      backend: { type: 'string', default: 'vulkan' },
   },
});

// ── Load verdicts ─────────────────────────────────────────────────────────────
if (!existsSync(flags.verdicts)) {
   console.error(`Verdicts directory not found: ${flags.verdicts}`);
   process.exit(1);
}

const verdictFiles = readdirSync(flags.verdicts).filter((f) => f.endsWith('.verdict.json'));
if (!verdictFiles.length) {
   console.error('No *.verdict.json files found. Run judge subagents first.');
   process.exit(1);
}

// Normalize a verdict model_id to the base model: drop the run-suite provider
// prefix ('llamacpp:') and the think suffix (--think/--nothi).
const normalizeId = (id) => baseModel(String(id).replace(/^llamacpp:/, ''));

const verdicts = [];
for (const vf of verdictFiles) {
   try {
      const v = JSON.parse(readFileSync(join(flags.verdicts, vf), 'utf8'));
      if (v.model_id && typeof v.judge_score === 'number') {
         verdicts.push(v);
         console.log(`  loaded  ${v.model_id}  judge_score=${v.judge_score.toFixed(2)}`);
      }
   } catch (e) {
      console.warn(`  [skip] ${vf}: ${e.message}`);
   }
}

if (!verdicts.length) {
   console.error('No valid verdict scores found.');
   process.exit(1);
}

// ── Write a judge run ───────────────────────────────────────────────────────────
const { run } = openSecondaryRun(RESULTS_DIR, {
   target: flags.target,
   backend: flags.backend,
   kind: 'judge',
   inputFlag: flags.input,
});

for (const v of verdicts) {
   const perBench = Object.entries(v.per_bench ?? {})
      .map(([k, n]) => `${k}=${n}`)
      .join(' ');
   run.append({
      target: flags.target,
      backend: flags.backend,
      model: normalizeId(v.model_id),
      think: 'n/a',
      bench: 'judge',
      score: v.judge_score.toFixed(2),
      status: 'ok',
      notes: perBench,
   });
}

run.finalize('complete');
console.log(`\njudge-merge: ${verdicts.length} judge row(s) → ${run.dir}`);
