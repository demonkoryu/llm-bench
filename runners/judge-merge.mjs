#!/usr/bin/env node
/**
 * judge-merge.mjs — fold judge verdict scores back into results/results.tsv.
 *
 * Reads results/judge/<modelId>.verdict.json files written by the judge subagents
 * and inserts/updates a `judge_score` column in results/results.tsv.
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
 * The merge strategy:
 *   - The TSV gains a `judge_score` column (appended if missing).
 *   - For each model matching a verdict file, the judge_score is written into
 *     ALL bench rows for that model (same score for all benches — it's per-model).
 *   - Existing judge_score values are overwritten.
 *   - Models without a verdict file keep judge_score='' (empty).
 *
 * Usage:
 *   node runners/judge-merge.mjs
 *   node runners/judge-merge.mjs --verdicts results/judge --tsv results/results.tsv
 */

import { existsSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { basename, dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseArgs } from 'node:util';
import { formatRow, headerLine, latestResultsFile, readTable } from '../shared/results-csv.mjs';

const __dir = dirname(fileURLToPath(import.meta.url));
const ROOT = join(__dir, '..');
const RESULTS_DIR = join(ROOT, 'results');

const { values: flags } = parseArgs({
   options: {
      verdicts: { type: 'string', default: join(ROOT, 'results/judge') },
      results: { type: 'string' },
      tsv: { type: 'string' }, // legacy alias for --results
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

// Map modelId → judge_score (0-10)
const scoreByModelId = new Map();
for (const vf of verdictFiles) {
   try {
      const v = JSON.parse(readFileSync(join(flags.verdicts, vf), 'utf8'));
      if (v.model_id && typeof v.judge_score === 'number') {
         scoreByModelId.set(v.model_id, v.judge_score);
         console.log(`  loaded  ${v.model_id}  judge_score=${v.judge_score.toFixed(2)}`);
      }
   } catch (e) {
      console.warn(`  [skip] ${vf}: ${e.message}`);
   }
}

if (!scoreByModelId.size) {
   console.error('No valid verdict scores found.');
   process.exit(1);
}

// ── Read results table ──────────────────────────────────────────────────────────
const resultsPath = flags.results ?? flags.tsv ?? latestResultsFile(RESULTS_DIR);
if (!existsSync(resultsPath)) {
   console.error(`Results file not found: ${resultsPath}`);
   process.exit(1);
}

const rows = readTable(resultsPath);
if (!rows.length) {
   console.error(`No rows in ${resultsPath}`);
   process.exit(1);
}

// Preserve the file's existing column order; ensure judge_score is present.
const columns = Object.keys(rows[0]);
if (!columns.includes('judge_score')) {
   columns.push('judge_score');
}

// ── Merge scores ──────────────────────────────────────────────────────────────
// The 'model' column is modelId(m) (hf_file base + think suffix). Verdict model_id
// may carry the run-suite provider prefix 'llamacpp:<modelId>' — match either form.
let updatedCount = 0;
for (const row of rows) {
   const modelId = row.model ?? '';
   const score = scoreByModelId.get(modelId) ?? scoreByModelId.get(`llamacpp:${modelId}`);
   if (score != null) {
      row.judge_score = score.toFixed(2);
      updatedCount++;
   } else if (row.judge_score == null) {
      row.judge_score = '';
   }
}

// ── Write back ────────────────────────────────────────────────────────────────
const out = [headerLine(columns), ...rows.map((r) => formatRow(r, columns))].join('\n');
writeFileSync(resultsPath, `${out}\n`, 'utf-8');

console.log(`\njudge-merge: ${updatedCount} row(s) updated with judge_score → ${basename(resultsPath)}`);
console.log('Next: node runners/render-chart.mjs  (picks up judge_score automatically)');
