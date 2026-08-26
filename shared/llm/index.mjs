/**
 * shared/llm — reusable LLM calling layer for llama.cpp (OpenAI-compat endpoint).
 *
 * This is the future-library boundary: all benchmark code and the MCP server
 * import from here. Internals (SDK choice, workarounds) are not leaked.
 *
 * Exports:
 *   createClient(baseUrl, opts)   — main client factory
 *   defaultClient(opts)           — factory using LLAMA_URL env
 *   CAPABILITY                    — enum of model capability classes
 *   capabilityClass(model)        — derive capability from models.yaml entry
 *   thinkStates(cap)              — which think-toggle values to run for a class (what to SEND)
 *   thinkModeFor(model, think)    — the think_mode dimension for a row (how to LABEL it)
 *   reasons(model, think)         — will this request actually emit a reasoning trace?
 *   applyThinkControl(...)        — apply think-control mechanism to messages
 *   resolveSampling(...)          — config-driven sampling param resolver
 *   samplingHash(params)          — stable digest of resolved sampling params (a measurement dim)
 *   validateSamplingMatrix(...)   — reject sampling_matrix keys that can never fire
 *   stripThink(s)                 — strip <think>...</think> from output (defensive)
 *   extractJson(s)                — tolerant first-JSON-object extraction
 *   parseToolArgs(raw)            — parse tool-call arguments string tolerantly
 */

export { createClient, defaultClient } from './client.mjs';
export { extractCode, extractJson, parseToolArgs, sanitizeJson, stripThink } from './repair.mjs';
export { resolveSampling, samplingHash, validateSamplingMatrix } from './sampling.mjs';
export { applyThinkControl, CAPABILITY, capabilityClass, reasons, thinkModeFor, thinkStates } from './think.mjs';
