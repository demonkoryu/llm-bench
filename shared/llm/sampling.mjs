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

/**
 * Stable short digest of a resolved sampling-param object — the value persisted as the
 * `sampling_hash` measurement dim and used in bench-run's resume key.
 *
 * Exists because `sampling_profile` is only `family/think_mode`, a function of dims already in the
 * key, so it cannot detect a re-baseline that changed nothing but temperature or presence_penalty.
 * Keys are sorted so property order never affects the digest; null/undefined values are dropped so
 * "absent" and "explicitly null" agree. Returns null for empty sampling (server defaults apply),
 * matching the null written for probes, which resolve their own sampling.
 *
 * FNV-1a, same construction as tidy-schema's measurementId — a change detector, not a checksum.
 * @param {object} params  resolved sampling params (the output of resolveSampling)
 * @returns {string|null}  8-hex-char digest, or null when there are no params
 */
export function samplingHash(params) {
   const entries = Object.entries(params ?? {})
      .filter(([, v]) => v !== null && v !== undefined)
      .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
   if (!entries.length) {
      return null;
   }
   const s = entries.map(([k, v]) => `${k}=${JSON.stringify(v)}`).join(';');
   let h = 0x811c9dc5;
   for (let i = 0; i < s.length; i++) {
      h ^= s.charCodeAt(i);
      h = Math.imul(h, 0x01000193);
   }
   return (h >>> 0).toString(16).padStart(8, '0');
}

/** Strip use-case sub-keys, leaving only actual sampling params. */
function cleanSampling(obj) {
   const KNOWN_USE_CASES = new Set([
      'triage',
      'reasoning',
      'toolcalling',
      'summarization',
      'docqa',
      'coding',
      'longctx',
      'speed',
      'default',
   ]);
   const out = {};
   for (const [k, v] of Object.entries(obj)) {
      if (!KNOWN_USE_CASES.has(k)) {
         out[k] = v;
      }
   }
   return out;
}
