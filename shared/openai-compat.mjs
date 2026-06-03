/**
 * Compatibility shim — delegates to shared/llm/client.mjs.
 *
 * Keeps the old openaiCompatClient() interface working for:
 *   benchmarks/longctx/passkey-bench.mjs
 *   benchmarks/longctx/multifact-bench.mjs
 *   benchmarks/toolcalling/decay-bench.mjs
 *
 * New code should import from shared/llm/index.mjs directly.
 */

import { createClient } from './llm/index.mjs';
import { stripThink } from './llm/index.mjs';

export function openaiCompatClient(baseUrl) {
   const llm = createClient(baseUrl);

   /** POST /v1/chat/completions — returns raw response-like object (old API). */
   async function chat(messages, opts = {}, timeoutMs = 600_000) {
      const { completion, timings } = await llm.chat(messages, opts, timeoutMs);
      // Attach timings to the completion object so tokPerSec() still works
      if (timings && completion) completion._timings = timings;
      return completion;
   }

   function tokPerSec(resp) { return resp?._timings?.predicted_per_second ?? null; }
   function content(resp) { return resp?.choices?.[0]?.message?.content ?? ''; }
   function toolCalls(resp) { return resp?.choices?.[0]?.message?.tool_calls ?? []; }
   function finishReason(resp) { return resp?.choices?.[0]?.finish_reason ?? null; }
   function waitHealthy(timeoutMs) { return llm.waitHealthy(timeoutMs); }

   return { chat, tokPerSec, content, toolCalls, finishReason, stripThink, waitHealthy, baseUrl };
}
