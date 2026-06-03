/**
 * Config-driven sampling parameter resolver.
 *
 * Sampling params are keyed by model family × think state × use-case:
 *   family      qwen3 | qwen3.6 | qwen3-coder | gemma4 | nemotron | lfm2.5 | …
 *   thinkState  true (think) | false (no_think) | null (no toggle)
 *   useCase     triage | reasoning | toolcalling | summarization | docqa | longctx | speed
 *
 * Values come from models.yaml `sampling_matrix:` (authoritative). Falls back to
 * hardcoded vendor recommendations only when a family key is absent.
 */

import { CAPABILITY } from './think.mjs';

// ── Hardcoded vendor-recommended fallbacks ─────────────────────────────────────
// These are used when models.yaml does not define a sampling_matrix entry.
// Sourced from Qwen3/3.5/3.6 and DeepSeek-R1-0528 official guidance.
const FALLBACKS = {
   // Hybrid / thinking: Qwen3 official
   [CAPABILITY.HYBRID]: {
      think: {
         temperature: 0.6,
         top_p: 0.95,
         top_k: 20,
         min_p: 0,
         // Overrides per use-case for thinking mode:
         reasoning: { temperature: 0.6, top_p: 0.95, top_k: 20, min_p: 0 },
         toolcalling: { temperature: 0.4, top_p: 0.9, top_k: 20, min_p: 0 },
      },
      no_think: {
         temperature: 0.7,
         top_p: 0.8,
         top_k: 20,
         min_p: 0,
         presence_penalty: 1.5,
         reasoning: { temperature: 0.6, top_p: 0.95, top_k: 20, min_p: 0 },
         toolcalling: { temperature: 0.4, top_p: 0.9, top_k: 20, min_p: 0 },
      },
   },
   // Always-thinking (DeepSeek-R1 distill etc.)
   [CAPABILITY.THINKING]: {
      think: {
         temperature: 0.6,
         top_p: 0.95,
         min_p: 0.05,
         reasoning: { temperature: 0.6, top_p: 0.95, min_p: 0.01 }, // DeepSeek-R1-0528 variant
      },
   },
   // Reasoning-only split field (LFM2.5)
   [CAPABILITY.REASONING_ONLY]: {
      default: {
         temperature: 0.2,
         top_k: 80,
         min_p: 0,
         presence_penalty: 1.05,
      },
   },
   // Standard instruct (no think)
   [CAPABILITY.NON_THINKING]: {
      default: {
         temperature: 0.1,
         toolcalling: { temperature: 0.4, top_p: 0.9 },
         summarization: { temperature: 0.3 },
      },
   },
};

/**
 * Resolve sampling parameters.
 *
 * Lookup order (first match wins):
 *  1. model.family as a matrix key — exact match (e.g. "qwen3", "qwen3.6", "qwen3-coder")
 *  2. hardcoded FALLBACKS keyed by capability class
 *
 * @param {object}       model    model config entry from models.yaml
 * @param {string}       cap      capability class (from capabilityClass(model))
 * @param {boolean|null} think    think state for this run pass
 * @param {string}       useCase  bench name
 * @param {object}       matrix   the sampling_matrix from models.yaml (may be undefined)
 * @returns {object}  sampling params to spread into the request body
 */
export function resolveSampling(model, cap, think, useCase, matrix) {
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

   // 2. Hardcoded fallback keyed by capability class (for families not in the matrix)
   const fallback = FALLBACKS[cap]?.[thinkKey] ?? FALLBACKS[cap]?.default ?? {};
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
