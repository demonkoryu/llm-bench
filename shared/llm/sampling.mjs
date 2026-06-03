/**
 * Config-driven sampling parameter resolver.
 *
 * Sampling params are keyed by model family × think state × use-case:
 *   family      qwen3 | qwen3.6 | qwen3-coder | gemma4 | nemotron | lfm2.5 | …
 *   thinkState  true (think) | false (no_think) | null (no toggle)
 *   useCase     triage | reasoning | toolcalling | summarization | docqa | longctx | speed
 *
 * Values come from models.yaml `sampling_matrix:` (authoritative). Falls back to
 * models.yaml `sampling_fallbacks:` (keyed by capability class) when a family key
 * is absent. The fallbacks object is passed in by the caller (run-suite reads it
 * from the same YAML load).
 */

/**
 * Resolve sampling parameters.
 *
 * Lookup order (first match wins):
 *  1. model.family as a matrix key — exact match (e.g. "qwen3", "qwen3.6", "qwen3-coder")
 *  2. YAML fallbacks keyed by capability class
 *
 * @param {object}       model     model config entry from models.yaml
 * @param {string}       cap       capability class (from capabilityClass(model))
 * @param {boolean|null} think     think state for this run pass
 * @param {string}       useCase   bench name
 * @param {object}       matrix    the sampling_matrix from models.yaml (may be undefined)
 * @param {object}       fallbacks the sampling_fallbacks from models.yaml (may be undefined)
 * @returns {object}  sampling params to spread into the request body
 */
export function resolveSampling(model, cap, think, useCase, matrix, fallbacks) {
   const thinkKey = think === true ? 'think' : think === false ? 'no_think' : 'default';
   const family = model.family ?? '';

   // 1. Look up by model family name — exact match first, then underscore-normalised
   //    (YAML keys with dashes are valid; we store the literal family name in the matrix)
   const familyEntry =
      matrix?.[family]?.[thinkKey] ??
      matrix?.[family]?.default ??
      matrix?.[family.replace(/-/g, '_')]?.[thinkKey] ??
      matrix?.[family.replace(/-/g, '_')]?.default;

   if (familyEntry) {
      const useCaseOverride = familyEntry[useCase];
      return cleanSampling(useCaseOverride ? { ...familyEntry, ...useCaseOverride } : familyEntry);
   }

   // 2. YAML fallback keyed by capability class (for families not in the matrix)
   const fb = fallbacks ?? {};
   const fallback = fb[cap]?.[thinkKey] ?? fb[cap]?.default ?? {};
   const useCaseOverride = fallback[useCase];
   return cleanSampling(useCaseOverride ? { ...fallback, ...useCaseOverride } : fallback);
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
