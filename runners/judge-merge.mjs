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

import { readFileSync, writeFileSync, readdirSync, existsSync } from 'node:fs';
import { join, dirname, basename } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseArgs } from 'node:util';

const __dir = dirname(fileURLToPath(import.meta.url));
const ROOT  = join(__dir, '..');

const { values: flags } = parseArgs({
   options: {
      verdicts: { type: 'string', default: join(ROOT, 'results/judge') },
      tsv:      { type: 'string', default: join(ROOT, 'results/results.tsv') },
   },
});

// ── Load verdicts ─────────────────────────────────────────────────────────────
if (!existsSync(flags.verdicts)) {
   console.error(`Verdicts directory not found: ${flags.verdicts}`);
   process.exit(1);
}

const verdictFiles = readdirSync(flags.verdicts)
   .filter((f) => f.endsWith('.verdict.json'));

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

// ── Read TSV ──────────────────────────────────────────────────────────────────
if (!existsSync(flags.tsv)) {
   console.error(`TSV not found: ${flags.tsv}`);
   process.exit(1);
}

const raw   = readFileSync(flags.tsv, 'utf8');
const lines = raw.split('\n');
const headerLine = lines[0] ?? '';
const headers    = headerLine.split('\t');

// Add judge_score column if absent
let judgeIdx = headers.indexOf('judge_score');
if (judgeIdx < 0) {
   headers.push('judge_score');
   judgeIdx = headers.length - 1;
}

// ── Merge scores ──────────────────────────────────────────────────────────────
// The model column in TSV is 'model' (from `modelId(m)` which is the hf_file base + think suffix)
// The verdict model_id is 'llamacpp:<modelId>' (from `provider.id` in run-suite pfResults).
// We match on the base model ID part (strip 'llamacpp:' prefix).
const modelColIdx = headers.indexOf('model');
if (modelColIdx < 0) {
   console.error('No "model" column in TSV header.');
   process.exit(1);
}

let updatedCount = 0;
const outLines = [headers.join('\t')];

for (const line of lines.slice(1)) {
   if (!line.trim()) continue;
   const cells = line.split('\t');

   // Extend cells if needed
   while (cells.length <= judgeIdx) cells.push('');

   const modelId = cells[modelColIdx] ?? '';
   // Try exact match first, then try stripping 'llamacpp:' prefix from verdict keys
   let score = scoreByModelId.get(modelId);
   if (score == null) {
      score = scoreByModelId.get(`llamacpp:${modelId}`);
   }
   if (score != null) {
      cells[judgeIdx] = score.toFixed(2);
      updatedCount++;
   }

   outLines.push(cells.join('\t'));
}

// ── Write back ────────────────────────────────────────────────────────────────
writeFileSync(flags.tsv, outLines.join('\n') + '\n', 'utf-8');

console.log(`\njudge-merge: ${updatedCount} TSV row(s) updated with judge_score → ${basename(flags.tsv)}`);
console.log('Next: node runners/render-chart.mjs  (picks up judge_score automatically)');
