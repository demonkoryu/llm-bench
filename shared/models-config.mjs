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
