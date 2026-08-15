/**
 * Config-driven sampling parameter resolver.
 *
 * Merge order (later layers win):
 *   1. family.default        — shared base params for this model family
 *   2. family[thinkKey]      — delta for this think state (think/no_think only; null state skips)
 *   3. per_profile[profile]  — override for this bench's sampling profile, looked up in the
 *                              state block first, then default
 *
 * Overrides are keyed by SAMPLING PROFILE, never by bench name. A bench opts in by declaring
 * `samplingProfile` alongside `thinkDependent` (see benches/*.mjs); a bench that declares none
 * gets base+state only. Keying on bench name is exactly what let the `coding` override rot into
 * dead config when the coding bench was split into coding_hard/coding_practical/coding_bugfix —
 * the config kept naming a bench that no longer existed and nothing noticed for months. A profile
 * is declared once in the bench factory, so splitting a bench can no longer desync it.
 *
 * All families must have an entry in models.yaml sampling_matrix; there are no fallbacks.
 * If a family is missing, an empty object is returned (server defaults apply).
 *
 * @param {object}       model    model config entry from models.yaml
 * @param {boolean|null} think    think state: true=think, false=no_think, null=no toggle
 * @param {string|null}  profile  the bench's declared samplingProfile, or null/undefined for none
 * @param {object}       matrix   the sampling_matrix from models.yaml
 * @returns {object}  sampling params to spread into the request body
 */
export function resolveSampling(model, think, profile, matrix) {
   const thinkKey = think === true ? 'think' : think === false ? 'no_think' : null;
   const family = model.family ?? '';

   // Exact match, then underscore-normalised (e.g. qwen3-coder → qwen3_coder)
   const fam = matrix?.[family] ?? matrix?.[family.replace(/-/g, '_')] ?? {};

   const base = fam.default ?? {};
   const state = thinkKey ? (fam[thinkKey] ?? {}) : {};

   // Profile override: state block takes precedence over default
   const uc = profile ? (state.per_profile?.[profile] ?? base.per_profile?.[profile] ?? {}) : {};

   return stripOverrideBlocks({ ...base, ...state, ...uc });
}

/** Valid state-block names inside a family entry. */
const STATE_BLOCKS = new Set(['default', 'think', 'no_think']);

/**
 * Fail loudly on sampling_matrix entries that can never fire.
 *
 * The `coding` override sat dead in three families for months, and picked up a documented A/B
 * finding on the way, because nothing ever checked that its key named something real. Profiles
 * are a closed set — every one a bench declares — so a stale or misspelled key is decidable at
 * load time rather than discoverable by reading resolver internals.
 *
 * @param {object} matrix            the sampling_matrix from models.yaml
 * @param {Set<string>} declared     every samplingProfile declared by a registered bench
 * @throws {Error} listing every offending key at once, so one run fixes the whole file
 */
export function validateSamplingMatrix(matrix, declared) {
   const errs = [];
   for (const [family, fam] of Object.entries(matrix ?? {})) {
      if (!fam || typeof fam !== 'object') {
         continue;
      }
      for (const [stateName, block] of Object.entries(fam)) {
         if (!STATE_BLOCKS.has(stateName)) {
            errs.push(`sampling_matrix.${family}.${stateName}: unknown state block (expected default/think/no_think)`);
            continue;
         }
         for (const profile of Object.keys(block?.per_profile ?? {})) {
            if (!declared.has(profile)) {
               errs.push(`sampling_matrix.${family}.${stateName}.per_profile.${profile}: no bench declares this samplingProfile`);
            }
         }
      }
   }
   if (errs.length) {
      const known = [...declared].sort().join(', ') || '(none)';
      throw new Error(`invalid sampling_matrix:\n  ${errs.join('\n  ')}\ndeclared profiles: ${known}`);
   }
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

/**
 * Drop the override container, leaving only actual sampling params.
 *
 * Overrides live under one named key, so this is a removal by name rather than a guess about
 * which entries look like params. That matters: sampling params are not reliably scalar
 * (`stop` is an array, `logit_bias` an object), so any structural test would silently swallow
 * legitimate params the day one is added.
 */
function stripOverrideBlocks({ per_profile: _overrides, ...params }) {
   return params;
}
