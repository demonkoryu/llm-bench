/**
 * Config-driven sampling parameter resolver.
 *
 * Merge order (later layers win):
 *   1. family.default   — shared base params for this model family
 *   2. family[thinkKey] — delta for this think state (think/no_think only; null state skips)
 *   3. useCase override — looked up in the state block first, then default
 *
 * All families must have an entry in models.yaml sampling_matrix; there are no fallbacks.
 * If a family is missing, an empty object is returned (server defaults apply).
 *
 * @param {object}       model    model config entry from models.yaml
 * @param {boolean|null} think    think state: true=think, false=no_think, null=no toggle
 * @param {string}       useCase  bench name (triage, reasoning, toolcalling, …)
 * @param {object}       matrix   the sampling_matrix from models.yaml
 * @returns {object}  sampling params to spread into the request body
 */
export function resolveSampling(model, think, useCase, matrix) {
   const thinkKey = think === true ? 'think' : think === false ? 'no_think' : null;
   const family = model.family ?? '';

   // Exact match, then underscore-normalised (e.g. qwen3-coder → qwen3_coder)
   const fam = matrix?.[family] ?? matrix?.[family.replace(/-/g, '_')] ?? {};

   const base = fam.default ?? {};
   const state = thinkKey ? (fam[thinkKey] ?? {}) : {};

   // Use-case override: state block takes precedence over default
   const uc = state[useCase] ?? base[useCase] ?? {};

   return cleanSampling({ ...base, ...state, ...uc });
}

/** Strip use-case sub-keys, leaving only actual sampling params. */
function cleanSampling(obj) {
   const KNOWN_USE_CASES = new Set(['triage', 'reasoning', 'toolcalling', 'summarization', 'docqa', 'longctx', 'speed', 'default']);
   const out = {};
   for (const [k, v] of Object.entries(obj)) {
      if (!KNOWN_USE_CASES.has(k)) {
         out[k] = v;
      }
   }
   return out;
}
