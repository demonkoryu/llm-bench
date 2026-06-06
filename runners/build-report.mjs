#!/usr/bin/env node
/**
 * Build a machine-readable summary (report.json) from one or more runs.
 *
 * report.json schema:
 *   {
 *     generated:    ISO timestamp,
 *     sources:      [run ids (kind/status)],
 *     environment:  { host, gpu, backend },
 *     scoring:      { formula, gates, amplifiers, rest_weights },
 *     models: [{ model, base_model, label, think, maxctx, maxctx_shared_from,
 *                benches: { triage, reasoning, toolcalling, docqa, summarization },
 *                speed_tok_s, quality, weighted_score }],
 *     ranking: [{ rank, label, model, think, weighted_score }]
 *   }
 *
 * Each --input may be a bare run id, a run directory (results/runs/<id>/), or a
 * run.json path. Rows from all runs are merged deterministically by mergeResultRows
 * — a successful measurement beats an error and the newest `ts` wins, so input
 * ORDER no longer matters (a base run and a catch-up run produce the same report
 * regardless of which is listed first). With no --input, the newest run is used.
 *
 * Usage:
 *   node runners/build-report.mjs                                 # newest run
 *   node runners/build-report.mjs --input <run-id> --input <run-id>   # merge runs
 *   node runners/build-report.mjs --input <run-id> --output results/report.json
 */

import { writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseArgs } from 'node:util';
import { aggregateModels, CARD_TOTAL_MIB, loadCapabilities, loadRuns, mergeResultRows, SCORING } from '../shared/results-store.mjs';

const __dir = dirname(fileURLToPath(import.meta.url));
const ROOT = join(__dir, '..');
const RESULTS_DIR = join(ROOT, 'results');

const { values: flags } = parseArgs({
   options: {
      input: { type: 'string', multiple: true },
      output: { type: 'string', default: join(RESULTS_DIR, 'report.json') },
   },
});

const runs = loadRuns(RESULTS_DIR, flags.input);
if (!runs.length) {
   console.error('No runs found. Run the suite first, or pass --input <run-id>.');
   process.exit(1);
}

// Merge rows across all runs deterministically (ts + status arbitrate, not order).
const rows = mergeResultRows(runs.flatMap((r) => r.results));
if (!rows.length) {
   console.error('No result rows found in run(s).');
   process.exit(1);
}

/** Describe a run for report provenance: run id + kind/status (self-describing in run.json). */
function describeSource(run) {
   return `${run.run_id} (${run.kind}/${run.status})`;
}

const { models, ranking } = aggregateModels(rows);

// host/gpu/backend live on the run object; row fields (target/backend) override when present.
const sample = rows[0] ?? {};
const first = runs[0] ?? {};
const environment = {
   ...(first.host ? { host: first.host } : {}),
   ...(first.gpu ? { gpu: first.gpu } : {}),
   ...(first.backend ? { backend: first.backend } : {}),
   ...(sample.target ? { host: sample.target } : {}),
   ...(sample.backend ? { backend: sample.backend } : {}),
};

const caps = loadCapabilities(join(ROOT, 'config/models.yaml'));

const report = {
   generated: new Date().toISOString(),
   sources: runs.map(describeSource),
   environment,
   // Multiplicative scoring: two hard gates × a context/VRAM amplifier × the
   // weighted "rest" axes. See SCORING in shared/results-store.mjs.
   scoring: SCORING,
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
      // and the synthetic legacy end-to-end estimate (kept for reference only).
      speed_tok_s: m.speedTg,
      prefill_tok_s: { '4k': m.prefill4k, '12k': m.prefill12k },
      total_tok_s: { '4k': m.total4k, '12k': m.total12k },
      // Directly-measured end-to-end throughput (tok/s) — one real request per depth
      // (prefill + fixed-length decode), read from server timings. `mean` is the
      // headline across depths; it's the throughput half of the performance axis.
      e2e_throughput_tok_s: {
         mean: m.e2eThroughput,
         ref: m.e2eRef,
         curve: m.e2eCurve.map((p) => ({ depth: p.depth, tok_s: p.tps })),
      },
      // Performance axis (rest-weight 0.25): blends throughput + cold/warm first-token
      // latency (0.4·throughput + 0.45·cold-latency + 0.15·warm-latency). Each component
      // is fleet-relative 0..1; `axis` is the value that enters restScore. ttft_8k_ms is
      // the absolute cold latency the cold-latency component is computed from (common 8k
      // depth, fair across models that can't reach 32k). warm_latency_norm folds in the
      // prompt-cache bench's warm (prefix-reused) TTFT — a fast cache hit is a real
      // serving-latency win, so prefix_cache is part of the performance rating.
      performance: {
         axis: m.performance,
         throughput_norm: m.throughputNorm,
         latency_norm: m.latencyNorm,
         warm_latency_norm: m.warmLatencyNorm,
         ttft_8k_ms: m.ttft8kMs,
         warm_ttft_ms: m.prefixCache?.warm ?? null,
      },
      // VRAM used (MiB) at the coherence ceiling, and the free headroom on the
      // card — low free = VRAM-bound (more VRAM → more ctx); high free = the model
      // hit its native/coherence limit with VRAM to spare.
      vram_at_maxctx_mib: {
         used: m.maxctxVram,
         free: m.maxctxVram != null ? CARD_TOTAL_MIB - m.maxctxVram : null,
      },
      // Decode-speed degradation under context load: tok/s at each depth, plus
      // retention at the reference depth (decode@ref ÷ decode@0). Mamba/SSM models
      // stay ~flat; KV-heavy attention models fall off steeply.
      decode_decay: {
         base_tok_s: m.decodeBase,
         retention_pct: m.decodeRetentionPct,
         ref_depth: m.decodeRefDepth,
         curve: m.decayCurve.map((p) => ({ depth: p.depth, tok_s: p.decode })),
      },
      // Parallel-generation throughput: aggregate tok/s at K concurrent slots and
      // the batching multiplier (agg@maxK ÷ agg@1) — how many agent slots one
      // model can usefully serve at once.
      parallel_gen: {
         agg_tok_s_max: m.pargenAggMax,
         max_slots: m.pargenMaxK,
         speedup: m.pargenSpeedup,
         curve: m.pargenCurve.map((p) => ({ slots: p.conc, agg_tok_s: p.tps })),
      },
      // Quality at depth (6-needle accuracy retention) + TTFT (prefill latency).
      quality_decay: {
         base_acc: m.qualityBase,
         retention_pct: m.qualityRetentionPct,
         curve: m.qualityCurve.map((p) => ({ depth: p.depth, acc: p.acc })),
      },
      ttft_ms: { ref: m.ttftRefMs, curve: m.ttftCurve.map((p) => ({ depth: p.depth, ms: p.ms })) },
      // Structured-output reliability: % schema-conformant JSON (unconstrained).
      struct_output_pct: m.structScore,
      // Instruction-following (IFEval-lite): % of verifiable prose constraints obeyed.
      // Raw metric is surfaced here, but it is NOT a rest axis — it feeds coding_mult.
      instruction_following_pct: m.ifScore,
      // Multi-turn agentic tool loop: % task completion + mean steps taken. Like
      // instruction_following, the completion_pct feeds coding_mult, not a rest axis.
      agentic_loop: { completion_pct: m.agenticScore, mean_steps: m.agenticSteps },
      // Prompt-cache prefix reuse: cold vs warm TTFT (ms) and the warm speedup ratio.
      prefix_cache: m.prefixCache ? { cold_ms: m.prefixCache.cold, warm_ms: m.prefixCache.warm, speedup: m.prefixCache.speedup } : null,
      // Coding-competence multiplier (no_think-primary): blends the raw coding grade
      // (0.6·[0.4·pass@1 + 0.6·test-rate from coding_multipl], fleet-normalized) with the
      // agentic tool-loop (0.25) and instruction-following (0.15) benches — all three
      // measure real coding capability. `mult` (0..1) is what multiplies into the score;
      // grade_norm is just the coding-grade component for reference.
      coding_grade: m.codingGrade,
      coding_mult: { mult: m.codingMult, grade_norm: m.codingGradeNorm, agentic_pct: m.agenticScore, instruction_following_pct: m.ifScore },
      // Power efficiency: decode tok/s per watt (board power via lm-sensors).
      power_eff_tok_s_per_w: m.powerEff,
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
         ['coding_grade', (m) => m.codingGrade],
         ['toolcalling', (m) => m.toolcall],
         ['docqa', (m) => m.docqa],
         ['summarization', (m) => m.summ],
         ['maxctx', (m) => m.maxctx],
         ['generation_tok_s', (m) => m.speedTg],
         ['prefill_tok_s_4k', (m) => m.prefill4k],
         ['prefill_tok_s_12k', (m) => m.prefill12k],
         ['total_tok_s_4k', (m) => m.total4k],
         ['total_tok_s_12k', (m) => m.total12k],
         ['e2e_throughput_tok_s', (m) => m.e2eThroughput], // throughput half of the performance axis
         ['performance_axis', (m) => m.performance], // blended throughput+latency value entering restScore
         ['latency_rel_8k', (m) => m.latencyNorm], // first-token latency @8k, fleet-relative (higher=faster)
         ['vram_free_at_maxctx_mib', (m) => (m.maxctxVram != null ? CARD_TOTAL_MIB - m.maxctxVram : null)],
         ['decode_retention_pct', (m) => m.decodeRetentionPct], // % of base decode held at ~32k ctx
         ['decode_tok_s_at_ref', (m) => m.decodeRef], // absolute decode tok/s at the reference depth
         ['parallel_agg_tok_s_8slots', (m) => m.pargenAggMax], // aggregate decode tok/s at max concurrency
         ['parallel_speedup', (m) => m.pargenSpeedup], // batching multiplier vs single slot
         ['quality_retention_pct', (m) => m.qualityRetentionPct], // accuracy held at ~32k vs 0
         ['struct_output_pct', (m) => m.structScore], // schema-conformant JSON rate
         ['instruction_following_pct', (m) => m.ifScore], // verifiable prose-constraint obedience
         ['agentic_loop_pct', (m) => m.agenticScore], // multi-turn tool-loop task completion
         ['prefix_cache_speedup', (m) => m.prefixCache?.speedup ?? null], // warm-prefix TTFT speedup
         ['power_eff_tok_s_per_w', (m) => m.powerEff], // decode tok/s per watt
         // (TTFT is lower-is-better — kept as per-model ttft_ms, not a descending ranking.)
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
