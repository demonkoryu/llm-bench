#!/usr/bin/env node
/**
 * Build a machine-readable summary (report.json) from one or more results CSVs.
 *
 * report.json schema:
 *   {
 *     generated:    ISO timestamp,
 *     sources:      [csv filenames],
 *     environment:  { host, gpu, backend },
 *     weights:      { quality, tools, ctx, speed },
 *     models: [{ model, base_model, label, think, maxctx, maxctx_shared_from,
 *                benches: { triage, reasoning, toolcalling, docqa, summarization },
 *                speed_tok_s, quality, weighted_score }],
 *     ranking: [{ rank, label, model, think, weighted_score }]
 *   }
 *
 * Usage:
 *   node runners/build-report.mjs                          # newest results CSV
 *   node runners/build-report.mjs --input a.csv --input b.csv   # merge multiple
 *   node runners/build-report.mjs --output results/report.json
 */

import { existsSync, writeFileSync } from 'node:fs';
import { basename, dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseArgs } from 'node:util';
import { aggregateModels, DEFAULT_WEIGHTS, latestResultsFile, loadCapabilities, readTable } from '../shared/results-csv.mjs';

const __dir = dirname(fileURLToPath(import.meta.url));
const ROOT = join(__dir, '..');
const RESULTS_DIR = join(ROOT, 'results');

// Usable VRAM on the benchmark card (RX 7900 XT, rocm-reported 21458059264 B).
// Single-GPU benchmark (the results filename encodes the GPU); also recorded in
// config/hosts.yaml as vram_total_mib. Used to derive free VRAM at max ctx.
const CARD_TOTAL_MIB = 20464;

const { values: flags } = parseArgs({
   options: {
      input: { type: 'string', multiple: true },
      output: { type: 'string', default: join(RESULTS_DIR, 'report.json') },
   },
});

const inputs = flags.input?.length ? flags.input : [latestResultsFile(RESULTS_DIR)];
for (const p of inputs) {
   if (!existsSync(p)) {
      console.error(`Input not found: ${p}`);
      process.exit(1);
   }
}

// Merge rows from all inputs; dedup by model|think|bench, later input wins.
const merged = new Map();
for (const p of inputs) {
   for (const row of readTable(p)) {
      merged.set(`${row.model}|${row.think}|${row.bench}`, row);
   }
}
const rows = [...merged.values()];
if (!rows.length) {
   console.error('No result rows found in input(s).');
   process.exit(1);
}

const { models, ranking } = aggregateModels(rows);

/** Parse environment from the canonical filename llm-benchmarks-<host>-<gpu>-<backend>-<datetime>.csv */
function envFromName(name) {
   const m = /^llm-benchmarks-([^-]+)-([^-]+)-([^-]+)-/.exec(basename(name));
   return m ? { host: m[1], gpu: m[2], backend: m[3] } : {};
}
// CSV columns are authoritative for host/backend when present; gpu only lives in the name.
const sample = rows[0] ?? {};
const environment = {
   ...envFromName(inputs[0]),
   ...(sample.target ? { host: sample.target } : {}),
   ...(sample.backend ? { backend: sample.backend } : {}),
};

const caps = loadCapabilities(join(ROOT, 'config/models.yaml'));

const report = {
   generated: new Date().toISOString(),
   sources: inputs.map((p) => basename(p)),
   environment,
   weights: DEFAULT_WEIGHTS,
   models: models.map((m) => ({
      model: m.model,
      base_model: m.base_model,
      label: m.label,
      think: m.think,
      maxctx: m.maxctx,
      maxctx_shared_from: m.maxctxSharedFrom ?? null,
      benches: {
         triage: m.triage,
         reasoning: m.reasoning,
         toolcalling: m.toolcall,
         docqa: m.docqa,
         summarization: m.summ,
      },
      // capabilities: distinguishes "unsupported" from "not measured" downstream
      capabilities: { tools: caps.get(m.base_model)?.tools ?? null },
      capability_note: caps.get(m.base_model)?.note ?? null,
      // speed: generation (decode) tok/s, real prefill tok/s on 4k/12k prompts,
      // and end-to-end throughput (P-token prompt + 512 gen) for each prompt size.
      speed_tok_s: m.speedTg,
      prefill_tok_s: { '4k': m.prefill4k, '12k': m.prefill12k },
      total_tok_s: { '4k': m.total4k, '12k': m.total12k },
      // VRAM used (MiB) at the coherence ceiling, and the free headroom on the
      // card — low free = VRAM-bound (more VRAM → more ctx); high free = the model
      // hit its native/coherence limit with VRAM to spare.
      vram_at_maxctx_mib: {
         used: m.maxctxVram,
         free: m.maxctxVram != null ? CARD_TOTAL_MIB - m.maxctxVram : null,
      },
      weighted_score: m.score,
   })),
   ranking: ranking.map((m, i) => ({
      rank: i + 1,
      label: m.label,
      model: m.model,
      think: m.think,
      weighted_score: m.score,
   })),
   // Per-category leaderboards: each metric ranked independently by its own score,
   // descending. Models that didn't run a metric (null) are omitted from that list.
   category_rankings: Object.fromEntries(
      [
         ['reasoning', (m) => m.reasoning],
         ['triage', (m) => m.triage],
         ['toolcalling', (m) => m.toolcall],
         ['docqa', (m) => m.docqa],
         ['summarization', (m) => m.summ],
         ['maxctx', (m) => m.maxctx],
         ['generation_tok_s', (m) => m.speedTg],
         ['prefill_tok_s_4k', (m) => m.prefill4k],
         ['prefill_tok_s_12k', (m) => m.prefill12k],
         ['total_tok_s_4k', (m) => m.total4k],
         ['total_tok_s_12k', (m) => m.total12k],
         ['vram_free_at_maxctx_mib', (m) => (m.maxctxVram != null ? CARD_TOTAL_MIB - m.maxctxVram : null)],
      ].map(([category, get]) => [
         category,
         models
            .filter((m) => get(m) != null)
            .sort((a, b) => get(b) - get(a))
            .map((m, i) => ({ rank: i + 1, label: m.label, model: m.model, think: m.think, score: get(m) })),
      ]),
   ),
};

writeFileSync(flags.output, `${JSON.stringify(report, null, 2)}\n`, 'utf-8');
console.log(`Report written: ${flags.output}  (${report.models.length} model variants from ${report.sources.length} source(s))`);
