// Tidy long-format measurement schema (pure, zero I/O).
//
// One row = one measured leaf metric, with every configuration axis as an explicit
// queryable column. This is the clean-slate replacement for the string-encoded model
// ids + per-run environment blobs that made cross-config comparison impossible.
//
// `metricRowsFromResult(rawRow, dims)` explodes a heterogeneous per-bench result object
// into leaf rows, which the orchestrator inserts into Postgres (analysis/pg-store.mjs).

// ── Column order + schema type tokens (drives the Postgres measurements table schema) ──
export const COLUMNS = {
   // identity / provenance
   measurement_id: 'VARCHAR',
   run_id: 'VARCHAR',
   run_kind: 'VARCHAR',
   ts: 'TIMESTAMP',
   seed_run_id: 'VARCHAR',
   // subject (the model under test)
   family: 'VARCHAR',
   // Base-model identity (qwen3.8-27b, gemma4-26b-a4b): the weights, independent of quant,
   // engine and artifact. See deriveModelId in shared/models-config.mjs.
   model: 'VARCHAR',
   arch: 'VARCHAR',
   type: 'VARCHAR',
   total_params: 'DOUBLE',
   active_params: 'DOUBLE',
   finetune: 'VARCHAR',
   repo: 'VARCHAR',
   gguf_file: 'VARCHAR',
   quant: 'VARCHAR',
   effective_bpw: 'DOUBLE',
   // serving config
   chat_template: 'VARCHAR',
   kv_quant: 'VARCHAR',
   flash_attn: 'BOOLEAN',
   ctx: 'BIGINT',
   n_parallel: 'BIGINT',
   batch: 'BIGINT',
   ubatch: 'BIGINT',
   spec_decode: 'VARCHAR',
   sampling_profile: 'VARCHAR',
   // Digest of the RESOLVED sampling params (temp/top_p/penalties/…) for this (model, think, bench).
   // sampling_profile is only `family/think_mode` — a function of dims already present — so it cannot
   // distinguish a re-baseline that changed nothing but temperature. This can, and it is what
   // bench-run's resume key uses. Null on probes (they set their own sampling) and on legacy rows.
   sampling_hash: 'VARCHAR',
   think_mode: 'VARCHAR',
   // platform
   host: 'VARCHAR',
   gpu: 'VARCHAR',
   vram_total: 'BIGINT',
   backend: 'VARCHAR',
   llamacpp_build: 'VARCHAR',
   // Engine version for ANY engine — llamacpp_build is llama.cpp-specific (parsed from
   // `llama-server --version`) and was null for the entire OptiQ run, leaving MLX rows with no
   // engine provenance at all. For llamacpp this mirrors llamacpp_build; for OptiQ it is the
   // `system_fingerprint` every response carries (mlx-lm ver, mlx ver, OS, arch, GPU).
   engine_version: 'VARCHAR',
   driver: 'VARCHAR',
   // the measurement
   bench: 'VARCHAR',
   case_id: 'VARCHAR',
   metric: 'VARCHAR',
   metric_value: 'DOUBLE',
   unit: 'VARCHAR',
   // 'general' = template-independent (probe/serving metric: VRAM, throughput, KV, capacity —
   // depends on model/quant/kv/backend/gpu, NOT chat_template); 'template' = varies by
   // chat_template (all capability benches, plus quality_decay accuracy). Consumers merge
   // 'general' rows across chat_template variants of the same config. See scopeFor().
   scope: 'VARCHAR',
   n: 'BIGINT',
   spread: 'DOUBLE',
   status: 'VARCHAR',
};
export const COLUMN_NAMES = Object.keys(COLUMNS);

// Metric template-dependence — an explicit, queryable enum value on every row (single source
// of allowed values; no bare string literals). Same string-enum idiom as scoring-config's NORM.
export const SCOPE = Object.freeze({ GENERAL: 'general', TEMPLATE: 'template' });

// A metric is 'general' (template-independent) iff its EMITTED (sub-)bench name is a perf/serving
// probe. Classified by the emitted bench string, not the registry bench: quality_decay is a probe
// but its `quality_decay-*` accuracy rows are template-dependent, while the `ttft-*` timing rows it
// also emits are general — so this keys on what actually landed in the row. Mirrors the
// SCORE_UNIT_BY_BENCH structure below (same probe-name patterns).
const GENERAL_BENCH = [/^agent_ctx$/, /^fit_ctx$/, /^vram_per_ctx_tok$/, /^power_eff$/, /^e2e-/, /^ttft-/, /^speed(_|$)/, /^prefix_cache_/];
export const scopeFor = (bench) => (GENERAL_BENCH.some((re) => re.test(bench)) ? SCOPE.GENERAL : SCOPE.TEMPLATE);

// Dimension columns the caller supplies via `dims` (everything except the measurement + provenance).
export const DIM_COLUMNS = [
   'family',
   'model',
   'arch',
   'type',
   'total_params',
   'active_params',
   'finetune',
   'repo',
   'gguf_file',
   'quant',
   'effective_bpw',
   'chat_template',
   'kv_quant',
   'flash_attn',
   'ctx',
   'n_parallel',
   'batch',
   'ubatch',
   'spec_decode',
   'sampling_profile',
   'sampling_hash',
   'think_mode',
   'host',
   'gpu',
   'vram_total',
   'backend',
   'llamacpp_build',
   'engine_version',
   'driver',
];

// ── Spine fields that are NOT measurements (skip when exploding) ─────────────────
const SPINE = new Set(['target', 'backend', 'model', 'think', 'bench', 'status', 'ts', 'notes', 'n', 'spread', 'case_id', 'lane_ctx']);

// Capacity/VRAM facts must only be emitted by the probe that owns them, not duplicated
// onto every core-quality row (which would fill the store with noise).
const CARRIED = new Set(['ctx_loaded', 'oom_ceiling', 'coherence_ceiling', 'vram_mib']);
const CORE_QUALITY = /^(triage|reasoning|toolcalling|summarization|docqa|coding_)/;
const ownsCarried = (bench) => !CORE_QUALITY.test(bench);

// ── Unit resolution ─────────────────────────────────────────────────────────────
const UNIT_EXACT = {
   tok_s: 'tok_s',
   prefill_tps: 'tok_s',
   vram_mib: 'mib',
   ctx_loaded: 'tokens',
   oom_ceiling: 'tokens',
   coherence_ceiling: 'tokens',
   // agent_ctx (multi-agent shared-pool capacity)
   total_ctx: 'tokens',
   planner_ctx: 'tokens',
   coder_ctx: 'tokens',
   n_slots: 'count',
   n_coders: 'count',
   gtt_mib: 'mib',
   halls: 'count',
   json_fail: 'count',
   wall_s: 's',
   toolcall_pass: 'count',
   toolcall_total: 'count',
   reasoning_correct: 'count',
   reasoning_total: 'count',
   // Despite the name, this is the COUNT of cases that fully passed (benches/coding.mjs emits
   // counts; consumers derive the rate as coding_pass_at_1/coding_total). It was labelled 'ratio',
   // which is a lie the value never satisfied — it ranges 0..coding_total, not 0..1.
   coding_pass_at_1: 'count',
   coding_total: 'count',
   coding_tests_passed: 'count',
   coding_tests_total: 'count',
   coding_no_code: 'count',
   summ_kw: 'ratio',
   summ_area: 'ratio',
   summ_tags: 'ratio',
   summ_length: 'ratio',
   docqa_correctness: 'points',
   docqa_coverage: 'points',
   docqa_faithfulness: 'points',
};
// score's unit depends on the bench that produced it.
const SCORE_UNIT_BY_BENCH = [
   [/^agent_ctx$/, 'count'], // score = n_coders (coder agents alongside the planner)
   [/^fit_ctx$/, 'tokens'],
   [/^vram_per_ctx_tok$/, 'kib'],
   [/^power_eff$/, 'tok_s_per_w'],
   [/^e2e-/, 'tok_s'],
   [/^ttft-/, 'ms'],
   [/^speed(_|$)/, 'tok_s'],
   [/^speed_decay-/, 'tok_s'],
   [/^speed_pargen-/, 'tok_s'],
   [/^quality_decay-/, 'percent'],
   [/^prefix_cache_(cold|warm)_ms$/, 'ms'],
   [/^prefix_cache_speedup$/, 'ratio'],
   [/^struct_output$/, 'percent'],
   [/^instruction_following$/, 'percent'],
   [/^agentic_loop$/, 'percent'],
];
function unitFor(bench, field) {
   if (field === 'score') {
      for (const [re, u] of SCORE_UNIT_BY_BENCH) {
         if (re.test(bench)) {
            return u;
         }
      }
      return 'score';
   }
   if (UNIT_EXACT[field]) {
      return UNIT_EXACT[field];
   }
   if (/^triage_[RC]\d+$/.test(field)) {
      return 'ratio'; // per-rule 0..1 rubric scores
   }
   if (/_ms$/.test(field)) {
      return 'ms';
   }
   if (/_tps$|_tok_s$/.test(field)) {
      return 'tok_s';
   }
   if (/_mib$|_vram$/.test(field)) {
      return 'mib';
   }
   return 'value';
}

const isNumeric = (v) => typeof v === 'number' && Number.isFinite(v);
// run.json uses '-' / '?' / '' for "not measured". Coerce numeric strings, reject sentinels.
function numOrNull(v) {
   if (isNumeric(v)) {
      return v;
   }
   if (typeof v === 'string' && v.trim() !== '' && v !== '-' && v !== '?') {
      const n = Number(v);
      return Number.isFinite(n) ? n : null;
   }
   return null;
}

// Small stable hash for measurement_id (dedup key). FNV-1a, hex.
export function measurementId(parts) {
   let h = 0x811c9dc5;
   const s = parts.join('');
   for (let i = 0; i < s.length; i++) {
      h ^= s.charCodeAt(i);
      h = Math.imul(h, 0x01000193);
   }
   return (h >>> 0).toString(16).padStart(8, '0');
}

/**
 * Explode one raw run.json result row into leaf tidy rows.
 * @param {object} rawRow  a run.json results[] entry (model/think/bench/status/ts + metric fields)
 * @param {object} dims    resolved dimension columns (subject/serving/platform) + {run_id, run_kind, seed_run_id}
 * @returns {object[]} tidy rows (each a full COLUMN_NAMES-shaped object)
 */
export function metricRowsFromResult(rawRow, dims) {
   const bench = rawRow.bench;
   const ts = dims.ts ?? rawRow.ts ?? null;
   const think_mode = dims.think_mode ?? rawRow.think ?? null;
   const out = [];
   for (const [field, raw] of Object.entries(rawRow)) {
      if (SPINE.has(field)) {
         continue;
      }
      if (CARRIED.has(field) && !ownsCarried(bench)) {
         continue;
      }
      const value = numOrNull(raw);
      if (value === null) {
         continue;
      }
      const metric = field; // leaf = the raw field; composites are derived at scoring time
      const unit = unitFor(bench, field);
      const base = {
         measurement_id: measurementId([
            dims.run_id,
            dims.gguf_file,
            dims.kv_quant,
            think_mode,
            dims.chat_template,
            bench,
            metric,
            rawRow.case_id ?? '',
         ]),
         run_id: dims.run_id,
         run_kind: dims.run_kind ?? null,
         ts,
         seed_run_id: dims.seed_run_id ?? null,
         bench,
         case_id: rawRow.case_id ?? null,
         metric,
         metric_value: value,
         unit,
         scope: scopeFor(bench),
         // per-metric spread (from multi-sample aggregation) wins over a row-level spread
         n: rawRow.n ?? 1,
         spread: rawRow.__spread?.[field] ?? rawRow.spread ?? null,
         status: rawRow.status ?? 'ok',
      };
      for (const d of DIM_COLUMNS) {
         base[d] = dims[d] ?? null;
      }
      base.think_mode = think_mode;
      // A per-CASE context wins over the run-level one. `dims.ctx` is whatever --ctx the run was
      // launched with (16384 by default), which is right for a bench served at the run's window but
      // wrong for a probe that reloads the server per case at a context of its own: agent_ctx sweeps
      // lane widths and emits a `lane_64k`/`lane_128k` case per width, so without this every lane
      // lands stamped 16384 and the ctx dimension says the run's flag rather than what was measured.
      // (Repaired in Postgres by hand once, on 2026-08-25, before being fixed here.)
      // The depth probes (throughput, quality_decay) reload at max(maxctx, floor) and so stamp
      // lane_ctx too — without it a ttft-64k row could claim ctx=40960, a window that cannot hold
      // its own depth. 35 such rows were deleted on 2026-08-26 rather than re-stamped: ctx is an
      // identity dimension, so correcting it forks the row instead of superseding it, and every
      // affected row was on a backend (vulkan, optiq) that no longer exists to re-measure.
      if (rawRow.lane_ctx != null) {
         base.ctx = numOrNull(rawRow.lane_ctx) ?? base.ctx;
      }
      // ensure full column set / column order
      const row = {};
      for (const c of COLUMN_NAMES) {
         row[c] = base[c] ?? null;
      }
      out.push(row);
   }
   return out;
}
