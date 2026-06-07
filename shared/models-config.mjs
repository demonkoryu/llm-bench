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
   const models = includeDisabled ? all : all.filter((m) => m.disabled !== true);
   return { ...cfg, defaults, models };
}
