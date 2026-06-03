#!/usr/bin/env node
/**
 * judge-prep.mjs — prepare per-model judge input bundles from bench run outputs.
 *
 * Reads the promptfoo-format JSON files written by run-suite.mjs (results/run-*.json)
 * and distills them into compact per-model bundles at results/judge/<modelId>.input.json.
 *
 * Only qualitative benches are included (summarization, docqa, reasoning) — those where
 * a language-model judge adds value over deterministic rubrics. Triage and toolcalling
 * are already fully covered by their own rubrics and are excluded.
 *
 * Bundle schema (results/judge/<modelId>.input.json):
 *   {
 *     model_id:  string,
 *     model_label: string,
 *     entries: [{
 *       bench:             string,
 *       case_id:           string,
 *       prompt:            string,    // user-facing prompt (no system preamble)
 *       output:            string,    // raw model output (think blocks still present)
 *       deterministic_score: number | null,
 *     }]
 *   }
 *
 * After judge subagents write results/judge/<modelId>.verdict.json, run judge-merge.mjs
 * to fold the scores back into results/results.tsv.
 *
 * Usage:
 *   node runners/judge-prep.mjs
 *   node runners/judge-prep.mjs --input results/run-2026-06-03T12-00-00.json
 */

import { readFileSync, writeFileSync, mkdirSync, readdirSync, existsSync } from 'node:fs';
import { join, dirname, basename } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseArgs } from 'node:util';

const __dir = dirname(fileURLToPath(import.meta.url));
const ROOT  = join(__dir, '..');

const { values: flags } = parseArgs({
   options: {
      input:  { type: 'string', default: '' },    // single file; default = all results/run-*.json
      outdir: { type: 'string', default: join(ROOT, 'results/judge') },
   },
});

// ── Qualitative benches to include ────────────────────────────────────────────
const JUDGE_BENCHES = new Set(['summarization', 'docqa', 'reasoning']);

// ── Collect source files ───────────────────────────────────────────────────────
const RESULTS_DIR = join(ROOT, 'results');
let sourceFiles;
if (flags.input) {
   sourceFiles = [flags.input];
} else {
   if (!existsSync(RESULTS_DIR)) {
      console.error('No results directory found. Run the bench first.');
      process.exit(1);
   }
   sourceFiles = readdirSync(RESULTS_DIR)
      .filter((f) => f.startsWith('run-') && f.endsWith('.json'))
      .map((f) => join(RESULTS_DIR, f));
}

if (!sourceFiles.length) {
   console.error('No run-*.json files found in results/. Run the bench first.');
   process.exit(1);
}

// ── Aggregate entries per model ────────────────────────────────────────────────
// Map: modelId → { model_id, model_label, entries[] }
const byModel = new Map();

for (const filePath of sourceFiles) {
   let runData;
   try {
      runData = JSON.parse(readFileSync(filePath, 'utf8'));
   } catch (e) {
      console.warn(`  [skip] ${basename(filePath)}: ${e.message}`);
      continue;
   }

   const results = runData?.results?.results ?? runData?.results ?? [];
   for (const row of results) {
      const bench = row.prompt?.label ?? '';
      if (!JUDGE_BENCHES.has(bench)) continue;

      const modelId    = row.provider?.id ?? '';
      const modelLabel = row.provider?.label ?? modelId;
      const caseId     = row.vars?.case_id ?? row.vars?.item_id ?? '';
      const prompt     = row.prompt?.raw ?? '';
      const output     = row.response?.output ?? '';
      const score      = row.gradingResult?.score ?? null;

      if (!modelId || !output) continue;

      if (!byModel.has(modelId)) {
         byModel.set(modelId, { model_id: modelId, model_label: modelLabel, entries: [] });
      }
      byModel.get(modelId).entries.push({
         bench,
         case_id: caseId,
         prompt: prompt.slice(0, 800),    // trim to keep bundles compact; judges read key parts
         output,
         deterministic_score: typeof score === 'number' ? Math.round(score * 100) / 100 : null,
      });
   }
}

if (!byModel.size) {
   console.error('No qualifying entries found (need summarization/docqa/reasoning results).');
   process.exit(0);
}

// ── Write bundles ─────────────────────────────────────────────────────────────
mkdirSync(flags.outdir, { recursive: true });

let written = 0;
for (const [modelId, bundle] of byModel) {
   // Sanitize modelId for use as a filename
   const safe    = modelId.replace(/[^a-zA-Z0-9._-]/g, '_').replace(/^_+|_+$/g, '');
   const outFile = join(flags.outdir, `${safe}.input.json`);
   writeFileSync(outFile, JSON.stringify(bundle, null, 2), 'utf-8');
   console.log(`  ${bundle.model_label}  →  ${basename(outFile)}  (${bundle.entries.length} entries)`);
   written++;
}

console.log(`\njudge-prep: ${written} bundle(s) written to ${flags.outdir}`);
console.log('Next: spawn one Claude Code Agent subagent per bundle with JUDGE_RUBRIC, write verdict JSON.');
console.log('Then: node runners/judge-merge.mjs  to fold scores into results.tsv');
