/**
 * Config-driven sampling parameter resolver.
 *
 * Sampling params are a function of three axes:
 *   capabilityClass  non_thinking | hybrid | thinking | reasoning_only
 *   useCase          triage | reasoning | toolcalling | summarization | docqa | longctx | speed
 *   thinkState       true | false | null
 *
 * Values are sourced from models.yaml `sampling_matrix:` so they can be tuned
 * without touching code. Falls back to hardcoded vendor recommendations when a
 * key is missing.
 *
 * Hybrid models have separate rows for think=true vs think=false; non_thinking
 * and reasoning_only models use thinkState=null rows.
 */

import { CAPABILITY } from './think.mjs';

// ── Hardcoded vendor-recommended fallbacks ─────────────────────────────────────
// These are used when models.yaml does not define a sampling_matrix entry.
// Sourced from Qwen3/3.5/3.6 and DeepSeek-R1-0528 official guidance.
const FALLBACKS = {
   // Hybrid / thinking: Qwen3 official
   [CAPABILITY.HYBRID]: {
      think: {
         temperature: 0.6, top_p: 0.95, top_k: 20, min_p: 0,
         // Overrides per use-case for thinking mode:
         reasoning:   { temperature: 0.6, top_p: 0.95, top_k: 20, min_p: 0 },
         toolcalling: { temperature: 0.4, top_p: 0.9,  top_k: 20, min_p: 0 },
      },
      no_think: {
         temperature: 0.7, top_p: 0.8, top_k: 20, min_p: 0, presence_penalty: 1.5,
         reasoning:   { temperature: 0.6, top_p: 0.95, top_k: 20, min_p: 0 },
         toolcalling: { temperature: 0.4, top_p: 0.9,  top_k: 20, min_p: 0 },
      },
   },
   // Always-thinking (DeepSeek-R1 distill etc.)
   [CAPABILITY.THINKING]: {
      think: {
         temperature: 0.6, top_p: 0.95, min_p: 0.05,
         reasoning:   { temperature: 0.6, top_p: 0.95, min_p: 0.01 },   // DeepSeek-R1-0528 variant
      },
   },
   // Reasoning-only split field (LFM2.5)
   [CAPABILITY.REASONING_ONLY]: {
      null: {
         temperature: 0.2, top_k: 80, min_p: 0, presence_penalty: 1.05,
      },
   },
   // Standard instruct (no think)
   [CAPABILITY.NON_THINKING]: {
      null: {
         temperature: 0.1,
         toolcalling: { temperature: 0.4, top_p: 0.9 },
         summarization: { temperature: 0.3 },
      },
   },
};

/**
 * Resolve sampling parameters.
 *
 * @param {object}  model      model config entry from models.yaml
 * @param {string}  cap        capability class (from capabilityClass(model))
 * @param {boolean|null} think think state for this run pass
 * @param {string}  useCase    bench name
 * @param {object}  matrix     the sampling_matrix from models.yaml (may be undefined)
 * @returns {object}  sampling params to spread into the request body
 */
export function resolveSampling(model, cap, think, useCase, matrix) {
   // 1. Try per-model override first (models.yaml sampling_overrides per model id)
   const modelOverride = matrix?.model_overrides?.[model.id ?? model.hf_file];
   if (modelOverride?.[useCase]) return cleanSampling(modelOverride[useCase]);
   if (modelOverride?.default) return mergeWithUseCase(modelOverride.default, modelOverride[useCase]);

   // 2. Look up from matrix by cap class + think state + use-case
   const thinkKey = think === true ? 'think' : think === false ? 'no_think' : 'null';
   const capEntry = matrix?.[cap]?.[thinkKey] ?? FALLBACKS[cap]?.[thinkKey] ?? FALLBACKS[cap]?.null ?? {};
   const useCaseOverride = capEntry[useCase];

   return cleanSampling(useCaseOverride ? { ...capEntry, ...useCaseOverride } : capEntry);
}

/** Strip use-case sub-keys, leaving only actual sampling params. */
function cleanSampling(obj) {
   const KNOWN_USE_CASES = new Set(['triage','reasoning','toolcalling','summarization','docqa','longctx','speed','default']);
   const out = {};
   for (const [k, v] of Object.entries(obj)) {
      if (!KNOWN_USE_CASES.has(k)) out[k] = v;
   }
   return out;
}

function mergeWithUseCase(base, override) {
   return cleanSampling(override ? { ...base, ...override } : base);
}
