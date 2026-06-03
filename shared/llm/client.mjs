/**
 * LLM client for llama.cpp (OpenAI-compatible endpoint).
 *
 * Uses the official `openai` npm SDK as the transport layer, with a custom
 * `fetch` interceptor that handles llama.cpp-specific concerns before the SDK
 * parses the response:
 *
 *   1. Saves `timings` (non-standard llama.cpp field stripped by the SDK).
 *   2. Handles the 503 "model loading" race in waitHealthy().
 *
 * Reasoning traces are extracted server-side via --reasoning-format auto.
 * The server populates `reasoning_content` and delivers clean `content` for
 * all think-capable models (Qwen3, Qwen3.6, Gemma4, Nemotron, LFM2.5).
 *
 * llama.cpp extensions are forwarded as extra body fields by the SDK unchanged:
 *   chat_template_kwargs.enable_thinking  — per-request think toggle
 *   top_k, min_p, presence_penalty        — sampling params
 *   response_format.json_schema            — structured output
 *
 * This module is the future-library boundary: benches import only from
 * shared/llm/index.mjs and never reach the openai SDK directly.
 */

import OpenAI from 'openai';
import { parseToolArgs } from './repair.mjs';
import { applyThinkControl } from './think.mjs';

const DEFAULT_URL = process.env.LLAMA_URL ?? 'http://192.168.1.120:8090';
const DEFAULT_TIMEOUT_MS = 600_000;

/**
 * Create a llama.cpp client instance.
 *
 * @param {string}  baseUrl   e.g. 'http://192.168.1.120:8090'
 * @param {object}  options
 *   debug    {boolean}  emit request/response detail to stderr
 *   timeout  {number}   default request timeout ms
 */
export function createClient(baseUrl = DEFAULT_URL, { debug = false, timeout = DEFAULT_TIMEOUT_MS } = {}) {
   // Side-channel for timings from the last intercepted response.
   // The openai SDK parses responses into typed objects and drops unknown fields.
   // We save timings here during the custom fetch interception.
   let _lastTimings = null;

   /**
    * Custom fetch interceptor: saves timings.
    * Returns a re-serialized Response so the SDK parses our modified body.
    */
   async function customFetch(url, init) {
      const resp = await globalThis.fetch(url, init);
      const urlStr = typeof url === 'string' ? url : (url?.href ?? '');
      if (resp.ok && urlStr.includes('chat/completions')) {
         try {
            const text = await resp.text();
            const data = JSON.parse(text);
            // Save timings before they're stripped by the SDK
            _lastTimings = data.timings ?? null;
            return new Response(JSON.stringify(data), {
               status: resp.status,
               statusText: resp.statusText,
               headers: resp.headers,
            });
         } catch {
            // Body already consumed or not JSON — SDK will handle the error
         }
      }
      return resp;
   }

   const sdk = new OpenAI({
      baseURL: `${baseUrl}/v1`,
      apiKey: 'EMPTY',
      fetch: customFetch,
      maxRetries: 0,
      timeout,
   });

   /**
    * POST /v1/chat/completions — single completion.
    *
    * @param {Array}  messages
    * @param {object} opts
    *   think           {boolean|null}  null = omit; true/false = enable/disable thinking
    *   responseFormat  {object|null}   JSON schema for structured output
    *   tools           {Array|null}    OpenAI tools array
    *   temperature, top_p, top_k, min_p, presence_penalty, max_tokens  — sampling
    * @returns {{ completion, timings }}
    *   completion  openai ChatCompletion object
    *   timings     llama.cpp timings object or null
    */
   async function chat(messages, opts = {}, timeoutMs = timeout) {
      const { think = null, thinkControl = 'enable_thinking', responseFormat = null, tools = null, ...sampling } = opts;

      // Apply model-family think-control mechanism (enable_thinking kwarg or system keyword)
      const { messages: resolvedMessages, extraBody } = applyThinkControl(messages, think, thinkControl);
      const extra = { ...extraBody };

      if (debug) {
         process.stderr.write(
            `[llm:req] think=${think} rf=${!!responseFormat} tools=${tools?.length ?? 0} max_tokens=${opts.max_tokens}\n`,
         );
      }

      _lastTimings = null;

      const reqParams = {
         model: 'local', // llama-server ignores model field; alias set at server start
         messages: resolvedMessages,
         stream: false,
         ...sampling,
         ...extra,
      };

      if (responseFormat) {
         reqParams.response_format = {
            type: 'json_schema',
            json_schema: { name: 'output', schema: responseFormat },
         };
      }
      if (tools?.length) {
         reqParams.tools = tools;
      }

      const signal = AbortSignal.timeout(timeoutMs);
      const completion = await sdk.chat.completions.create(reqParams, { signal });

      if (debug) {
         const c = completion.choices?.[0];
         process.stderr.write(
            `[llm:res] finish=${c?.finish_reason} tokens=${completion.usage?.completion_tokens} ` +
               `tps=${_lastTimings?.predicted_per_second?.toFixed(1) ?? 'n/a'}\n`,
         );
      }

      return { completion, timings: _lastTimings };
   }

   /**
    * Multi-step tool-calling loop.
    *
    * @param {Array}    messages        Initial messages.
    * @param {Array}    toolsDef        OpenAI tools definitions array.
    * @param {Function} toolExecutor    (name, args) → string|Promise<string>
    * @param {object}   opts            Same sampling opts as chat(); plus:
    *   maxSteps  {number}  max assistant turns (default 10)
    * @returns {{ content, steps, completion, timings }}
    *   content     final assistant text (after last tool round-trip)
    *   steps       number of assistant turns taken
    *   allToolCalls  array of all { name, arguments } across all steps
    *   completion  the last ChatCompletion object
    *   timings     timings from the last call
    */
   async function toolsLoop(messages, toolsDef, toolExecutor, opts = {}) {
      const { maxSteps = 10, ...callOpts } = opts;
      const current = [...messages];
      let steps = 0;
      let lastCompletion = null;
      let lastTimings = null;
      const allToolCalls = [];

      while (steps < maxSteps) {
         const { completion, timings } = await chat(current, { tools: toolsDef, ...callOpts });
         lastCompletion = completion;
         lastTimings = timings;
         steps++;

         const choice = completion.choices?.[0];
         if (!choice) {
            break;
         }

         const assistantMsg = choice.message;

         // Add assistant turn to history
         current.push({
            role: 'assistant',
            content: assistantMsg.content ?? '',
            ...(assistantMsg.tool_calls ? { tool_calls: assistantMsg.tool_calls } : {}),
         });

         // If no tool calls or stop reason, we're done
         if (!assistantMsg.tool_calls?.length || choice.finish_reason === 'stop') {
            return {
               content: assistantMsg.content ?? '',
               steps,
               allToolCalls,
               completion,
               timings,
            };
         }

         // Execute each tool call
         for (const tc of assistantMsg.tool_calls) {
            const name = tc.function?.name ?? '';
            const args = parseToolArgs(tc.function?.arguments ?? '{}');
            allToolCalls.push({ name, arguments: args });

            let result;
            try {
               result = await toolExecutor(name, args);
            } catch (e) {
               result = `Error: ${e.message}`;
            }

            current.push({
               role: 'tool',
               tool_call_id: tc.id,
               content: String(result),
            });
         }
      }

      // Exhausted maxSteps — return whatever the last message said
      const finalMsg = lastCompletion?.choices?.[0]?.message;
      return {
         content: finalMsg?.content ?? '',
         steps,
         allToolCalls,
         completion: lastCompletion,
         timings: lastTimings,
      };
   }

   /**
    * Wait until llama-server is ready to accept inference requests.
    *
    * llama-server's /health endpoint returns 200 as soon as the HTTP server starts,
    * before the model is loaded. We send a minimal probe completion and wait until
    * it no longer returns 503 (Loading model).
    *
    * Returns true when ready, throws if not ready within timeoutMs.
    */
   async function waitHealthy(timeoutMs = 300_000) {
      const start = Date.now();
      const deadline = start + timeoutMs;
      let lastLog = start;
      const probe = { messages: [{ role: 'user', content: 'hi' }], max_tokens: 1, stream: false };

      while (Date.now() < deadline) {
         try {
            const res = await globalThis.fetch(`${baseUrl}/v1/chat/completions`, {
               method: 'POST',
               headers: { 'Content-Type': 'application/json' },
               signal: AbortSignal.timeout(5_000),
               body: JSON.stringify(probe),
            });
            if (res.status !== 503) {
               return true; // 200 = ready; non-503 = ready or real error
            }
         } catch {
            // Connection refused or timeout — server not yet accepting connections
         }

         const now = Date.now();
         if (now - lastLog >= 10_000) {
            const elapsed = Math.round((now - start) / 1000);
            console.log(`[llm] waiting for model load... ${elapsed}s`);
            lastLog = now;
         }
         await new Promise((r) => setTimeout(r, 2_000));
      }
      throw new Error(`llama-server not ready within ${timeoutMs / 1000}s at ${baseUrl}`);
   }

   /**
    * Get server properties from /props endpoint.
    * Returns { n_ctx, model_alias } or {} on failure.
    */
   async function getServerProps() {
      try {
         const res = await globalThis.fetch(`${baseUrl}/props`, {
            signal: AbortSignal.timeout(5_000),
         });
         if (!res.ok) {
            return {};
         }
         const raw = await res.json();
         let n_ctx = raw.n_ctx;
         if (!n_ctx) {
            const dgs = raw.default_generation_settings ?? {};
            n_ctx = dgs.n_ctx ?? dgs.params?.n_ctx;
         }
         return { n_ctx, model_alias: raw.model_alias ?? raw.model };
      } catch {
         return {};
      }
   }

   /**
    * Extract decode tokens-per-second from saved timings.
    * Call immediately after chat() — next call overwrites.
    */
   function tokPerSec() {
      return _lastTimings?.predicted_per_second ?? null;
   }

   /**
    * Extract prefill tokens-per-second from saved timings.
    */
   function prefillTokPerSec() {
      return _lastTimings?.prompt_per_second ?? null;
   }

   return { chat, toolsLoop, waitHealthy, getServerProps, tokPerSec, prefillTokPerSec, baseUrl };
}

/** Convenience: create a client from the default env URL. */
export function defaultClient(opts) {
   return createClient(DEFAULT_URL, opts);
}
