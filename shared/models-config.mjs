/**
 * hf_file -> human label, straight off the YAML.
 *
 * Deliberately NOT built from loadModelsConfig(): that expands `kv_variants` into one entry per KV
 * quant and appends " · KV <quant>" to each label, so the map would carry one arbitrary variant's
 * KV in the model's NAME. Consumers that display a model (the dashboard board/pivot) show kv_quant
 * as its own column, and stamping a second, possibly contradictory KV into the name misreports the
 * row. Defaults merging and disabled-filtering are equally irrelevant to a name, so this reads the
 * file plainly. Entries without a `label` are omitted; callers fall back to the artifact filename.
 */
export function loadModelLabels(path) {
   const cfg = yaml.load(readFileSync(path, 'utf8')) ?? {};
   return Object.fromEntries((cfg.models ?? []).filter((m) => m?.hf_file && m?.label).map((m) => [m.hf_file, m.label]));
}

/**
 * Central loader for config/models.yaml.
 *
 * The single reason this exists instead of a bare `yaml.load()` at each call site:
 * **global defaults**. A top-level `defaults.extra_flags` block is merged into every
 * model's `extra_flags`, with per-model keys overriding. This is what keeps batch
 * sizing (batch-size / ubatch-size: 2048) uniform across the fleet WITHOUT copying
 * it onto every entry — a new model now inherits it automatically instead of
 * silently regressing to llama.cpp's default -ub 512 (which throttles Vulkan
 * prefill ~6×; see the prefill-ubatch history).
 *
 * Merge precedence (low → high): defaults.extra_flags  <  model.extra_flags
 * So a model that OOMs at max ctx overrides with `extra_flags: { ubatch-size: 1024 }`
 * and inherits batch-size from defaults.
 *
 * A model whose `extra_flags` is a STRING (legacy free-form passthrough) opts out of
 * the object merge and is left untouched — none currently use that form.
 */

import { readFileSync } from 'node:fs';
import yaml from 'js-yaml';

/**
 * Canonical per-entry base id: the GGUF filename minus `.gguf`, plus an optional
 * `--<variant>` tag (e.g. `--kvq4_0`) when the entry is a KV-quant variant. This is
 * the SINGLE source of model identity for every runner — the suite appends a think
 * suffix on top (base[--variant][--think]); secondaries emit it verbatim. Two config
 * entries that share an hf_file (the two KV variants of one GGUF) get distinct ids
 * only because of the variant tag, which is what keeps their rows from colliding.
 */
export function modelBaseId(model) {
   const base = String(model.hf_file ?? '').replace(/\.gguf$/i, '');
   return model.variant ? `${base}--${model.variant}` : base;
}

/**
 * Expand a model carrying `kv_variants: [q8_0, q4_0, ...]` into one entry per KV quant.
 * Each variant injects `--cache-type-k/v <quant>` into extra_flags and stamps a
 * `variant` tag (→ a distinct id via modelBaseId + a distinct label), so the quants
 * rank as separate configurations in the same dashboard — exactly like a hybrid's
 * think/no-think rows. The list is read from the model, else from defaults.kv_variants.
 * No list (or a single-element list resolving to one quant) → the model is returned
 * unchanged. Symmetric K/V only (asymmetric de-fuses the FA kernel).
 */
function expandKvVariants(model, defaults = {}) {
   const variants = model.kv_variants ?? defaults.kv_variants;
   if (!Array.isArray(variants) || variants.length === 0) {
      return [model];
   }
   return variants.map((q) => {
      const quant = String(q);
      const mf = model.extra_flags;
      const extra_flags =
         typeof mf === 'string'
            ? `${mf} --cache-type-k ${quant} --cache-type-v ${quant}`.trim()
            : { ...(mf ?? {}), 'cache-type-k': quant, 'cache-type-v': quant };
      return {
         ...model,
         variant: `kv${quant}`,
         label: `${model.label ?? modelBaseId(model)} · KV ${quant}`,
         extra_flags,
      };
   });
}

/** Merge defaults.extra_flags into one model entry (per-model keys win). */
export function applyDefaults(model, defaults = {}) {
   const df = defaults.extra_flags;
   if (!df || typeof df !== 'object') {
      return model;
   }
   const mf = model.extra_flags;
   if (typeof mf === 'string') {
      // Legacy string form: can't object-merge; leave as the model declared it.
      return model;
   }
   return { ...model, extra_flags: { ...df, ...(mf ?? {}) } };
}

/**
 * Load and parse config/models.yaml with defaults merged into every model.
 * Returns the full parsed config object (so `.sampling_matrix`, etc. still work),
 * with `.models` rewritten to carry effective per-model `extra_flags`.
 *
 * Models flagged `disabled: true` are filtered OUT by default — they stay in the
 * YAML (reversible, documented) but never reach the runners. Pass
 * `{ includeDisabled: true }` to get the full list (e.g. for a "what's parked"
 * report).
 */
export function loadModelsConfig(path, { includeDisabled = false } = {}) {
   const cfg = yaml.load(readFileSync(path, 'utf8')) ?? {};
   const defaults = cfg.defaults ?? {};
   const all = (cfg.models ?? []).map((m) => applyDefaults(m, defaults));
   // Filter disabled BEFORE expanding KV variants so a parked model doesn't spawn
   // (filtered-out) variant rows, and the active count stays clean.
   const active = includeDisabled ? all : all.filter((m) => m.disabled !== true);
   const models = active.flatMap((m) => expandKvVariants(m, defaults));
   return { ...cfg, defaults, models };
}

// ── Structured subject dimensions (derive-first, override-friendly) ─────────────
// The tidy store needs arch/params/finetune/quant/bpw as queryable columns. Rather
// than hand-editing every YAML entry, derive them from the fields already present
// (hf_file / label / family / type / repo) and let a model override any of them by
// declaring the field explicitly. Same function feeds live-emit and backfill so a
// historical run and a fresh run tag identically.

// Approximate bits-per-weight by quant token prefix (longest match wins).
const BPW = [
   ['Q8_0', 8.5],
   ['Q6_K', 6.6],
   ['Q5_K_M', 5.7],
   ['Q5_K_S', 5.5],
   ['Q5_0', 5.5],
   ['Q5_1', 6.0],
   // Unsloth's dynamic Q5. Derived from the artifact, not guessed: Muse-Glimmer-30B-UD-Q5_K_XL.gguf
   // is 21,789,618,976 B for a 30B model -> 5.81 bpw. Sits above Q5_K_M as the dynamic variants do.
   ['Q5_K_XL', 5.8],
   ['UD-Q5_K_XL', 5.8],
   ['Q4_K_XL', 4.8],
   ['Q4_K_M', 4.85],
   ['Q4_K_S', 4.6],
   ['UD-Q4_K_XL', 4.8],
   ['Q4_0', 4.5],
   ['Q4_1', 4.9],
   ['IQ4_XS', 4.25],
   ['IQ4_NL', 4.5],
   ['IQ3_M', 3.7],
   ['IQ3_XS', 3.3],
   ['IQ2_M', 2.7],
   ['Q3_K_M', 3.9],
   ['Q3_K_L', 4.3],
   ['Q2_K', 3.0],
   ['F16', 16],
   ['BF16', 16],
   ['F32', 32],
];
const QUANT_RE = /(?:UD-)?(IQ\d(?:_[A-Z]+)?|Q\d(?:_\d|_K(?:_[A-Z]+)?)?|F16|BF16|F32)/i;

export function parseQuant(hf_file = '') {
   const base = String(hf_file).replace(/\.gguf$/i, '');
   const m = QUANT_RE.exec(base);
   if (m) {
      return m[0].replace(/^UD-/i, '');
   }
   const seg = base.split('-').pop();
   return seg || null;
}
export function bpwForQuant(quant) {
   if (!quant) {
      return null;
   }
   const q = quant.toUpperCase();
   let best = null;
   for (const [tok, v] of BPW) {
      if (q.includes(tok) && (!best || tok.length > best[0].length)) {
         best = [tok, v];
      }
   }
   return best ? best[1] : null;
}
function parseParams(text = '') {
   // total = first "<n>B"; active = "A<n>B" (MoE). Dense → active = total.
   const total = /(\d+(?:\.\d+)?)\s*B\b/i.exec(text);
   const active = /A(\d+(?:\.\d+)?)\s*B\b/i.exec(text);
   const t = total ? Number(total[1]) : null;
   const a = active ? Number(active[1]) : t;
   return { total_params: t, active_params: a };
}
function parseFinetune(text = '') {
   const s = text.toLowerCase();
   if (/coder/.test(s)) {
      return 'coder';
   }
   if (/abliterat|uncensor/.test(s)) {
      return 'abliterated';
   }
   if (/\bapex\b/.test(s)) {
      return 'apex';
   }
   if (/\bqat\b/.test(s)) {
      return 'qat';
   }
   if (/distill|(^|[^a-z])r1([^a-z]|$)|reasoning/.test(s)) {
      return 'reasoning-distill';
   }
   if (/instruct|-it\b|-it-|\bit\b/.test(s)) {
      return 'instruct';
   }
   return null;
}
// Classify by SPARSITY (active < total → MoE) crossed with family hybrid-ness, so the
// dense-hybrid 27B (active==total) and the sparse 35B-A3B (active≪total) — same family —
// separate correctly. This is the axis the dense-vs-MoE study turns on.
export function deriveArch(family = '', total = null, active = null) {
   const f = String(family).toLowerCase();
   const sparse = total != null && active != null && active < total;
   // Every qwen3.x from 3.5 on is gated-delta. This was /qwen3\.[56]/ and so silently
   // dropped qwen3.8 through to the generic dense/moe branch below — which is why the
   // Q6_K 27B recorded arch 'dense' while its NVFP4/OptiQ siblings, which declare arch
   // explicitly in models.yaml, recorded 'gated-delta-dense' for the same weights.
   if (/qwen3\.(?:[5-9]|\d\d)/.test(f)) {
      return sparse ? 'gated-delta-moe' : 'gated-delta-dense';
   }
   if (/lfm|mamba|falcon-h|jamba|hybrid/.test(f)) {
      return 'mamba-hybrid';
   }
   return sparse ? 'moe' : 'dense';
}

/**
 * The BASE MODEL a row is about — the weights, independent of how they were quantized,
 * converted, served or finetuned. `family` is only the generation (qwen3.6) and `gguf_file`
 * is one artifact of one quant on one engine, so neither answers "how does Qwen3.8-27B do
 * across NVFP4, OptiQ and Q6_K" — the question the dashboard could not previously ask.
 *
 * Derived from family + params rather than declared per entry, so it cannot drift from the
 * param columns beside it and a new models.yaml entry gets one without remembering to. The
 * MoE active-param token stays in the id because it separates genuinely different models
 * (a dense 26B is not a 26B-A4B); dense models get no suffix. `model:` in models.yaml
 * overrides for anything this shape does not fit.
 */
export function deriveModelId(family, total, active) {
   if (!family || total == null) {
      return null;
   }
   const base = `${String(family).toLowerCase()}-${total}b`;
   return active != null && active < total ? `${base}-a${active}b` : base;
}

/** Subject dims for a (possibly kv-variant-expanded) model entry. Overrides win. */
export function deriveSubjectDims(model = {}) {
   const hf_file = model.hf_file ?? null;
   const label = model.label ?? '';
   const text = `${model.hf_repo ?? ''} ${hf_file ?? ''} ${label}`;
   const quant = model.quant ?? parseQuant(hf_file);
   // Parse from hf_file first — it reliably carries the MoE "A<n>B" active-param token
   // (labels often omit it, which would wrongly make a 35B-A3B MoE look 35B-active).
   // But not always: google's QAT file is plain `gemma-4-26B_q4_0-it.gguf` while the repo
   // it comes from is `gemma-4-26B-A4B-it-qat-...`, so a filename that yields a total but
   // no A-token falls back to the repo for the active side rather than assuming dense.
   const fromFile = parseParams(hf_file ?? '');
   const params = fromFile.total_params != null ? fromFile : parseParams(label);
   if (params.total_params != null && params.active_params === params.total_params) {
      const fromRepo = parseParams(model.hf_repo ?? '');
      if (fromRepo.total_params === params.total_params && fromRepo.active_params < fromRepo.total_params) {
         params.active_params = fromRepo.active_params;
      }
   }
   const total_params = model.total_params ?? params.total_params;
   const active_params = model.active_params ?? params.active_params;
   const family = model.family ?? null;
   return {
      family,
      model: model.model ?? deriveModelId(family, total_params, active_params),
      type: model.type ?? null,
      arch: model.arch ?? deriveArch(model.family, total_params, active_params),
      total_params,
      active_params,
      finetune: model.finetune ?? parseFinetune(text) ?? 'instruct',
      repo: model.hf_repo ?? null,
      gguf_file: hf_file,
      quant,
      effective_bpw: model.effective_bpw ?? bpwForQuant(quant),
   };
}
