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
 *   thinkStates(cap)              — which think-toggle values to run for a class
 *   applyThinkControl(...)        — apply think-control mechanism to messages
 *   resolveSampling(...)          — config-driven sampling param resolver
 *   stripThink(s)                 — strip <think>...</think> from output (defensive)
 *   extractJson(s)                — tolerant first-JSON-object extraction
 *   parseToolArgs(raw)            — parse tool-call arguments string tolerantly
 */

export { createClient, defaultClient } from './client.mjs';
export { extractJson, parseToolArgs, sanitizeJson, stripThink } from './repair.mjs';
export { resolveSampling } from './sampling.mjs';
export { applyThinkControl, CAPABILITY, capabilityClass, thinkStates } from './think.mjs';
