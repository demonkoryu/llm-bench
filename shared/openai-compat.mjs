/**
 * OpenAI-compatible transport for llama.cpp server (all benchmarks).
 *
 * Handles llama.cpp-specific extensions:
 *   think          → chat_template_kwargs.enable_thinking (per-request)
 *   responseFormat → response_format.json_schema (triage structured output)
 *   tools          → standard OpenAI tools spec (toolcalling bench)
 *
 * Sampling params go at the request top-level (not nested under `options`
 * like Ollama). num_ctx is not a per-request param — set via -c at server start.
 */

const DEFAULT_URL        = process.env.LLAMA_URL ?? 'http://192.168.1.120:8090';
const DEFAULT_TIMEOUT_MS = 600_000;

export function openaiCompatClient(baseUrl = DEFAULT_URL) {

   /**
    * POST /v1/chat/completions
    *
    * @param {Array}         messages
    * @param {object}        opts
    *   think          {boolean|null}  null = don't set; true/false = enable/disable thinking
    *   responseFormat {object|null}   JSON schema object for structured output
    *   tools          {Array|null}    OpenAI tools array
    *   temperature    {number}
    *   top_p          {number}
    *   top_k          {number}
    *   min_p          {number}
    *   presence_penalty {number}
    *   max_tokens     {number}
    * @param {number}        timeoutMs
    */
   async function chat(messages, opts = {}, timeoutMs = DEFAULT_TIMEOUT_MS) {
      const { think = null, responseFormat = null, tools = null, ...samplingOpts } = opts;

      const body = { messages, stream: false, ...samplingOpts };

      if (think !== null) {
         body.chat_template_kwargs = { enable_thinking: think };
      }

      if (responseFormat) {
         // llama.cpp: response_format.json_schema.schema
         body.response_format = {
            type: 'json_schema',
            json_schema: { schema: responseFormat },
         };
      }

      if (tools?.length) {
         body.tools = tools;
      }

      if (process.env.BENCH_DEBUG) {
         process.stderr.write(`[req] max_tokens=${body.max_tokens} think=${body.chat_template_kwargs?.enable_thinking ?? null} rf=${!!body.response_format}\n`);
      }
      const res = await fetch(`${baseUrl}/v1/chat/completions`, {
         method: 'POST',
         headers: { 'Content-Type': 'application/json' },
         signal: AbortSignal.timeout(timeoutMs),
         body: JSON.stringify(body),
      });

      if (!res.ok) {
         const txt = await res.text().catch(() => '');
         throw new Error(`llama-server HTTP ${res.status}: ${txt.slice(0, 200)}`);
      }
      return res.json();
   }

   /** tok/s from a completions response. */
   function tokPerSec(resp) {
      // llama.cpp reports timings in the response
      const t = resp.timings;
      if (t?.predicted_per_second) return t.predicted_per_second;
      // fallback: usage tokens / wall time not available in OAI format; return null
      return null;
   }

   /** Strip <think>…</think> blocks from content. */
   function stripThink(s) {
      return (s ?? '').replace(/<think>[\s\S]*?<\/think>/g, '').trim();
   }

   /** Extract assistant content from a completions response. */
   function content(resp) {
      return resp.choices?.[0]?.message?.content ?? '';
   }

   /** Extract tool_calls from a completions response. */
   function toolCalls(resp) {
      return resp.choices?.[0]?.message?.tool_calls ?? [];
   }

   /**
    * finish_reason from a completions response.
    * llama.cpp returns 'stop' (EOS / natural end) or 'length' (max_tokens hit).
    * 'length' means the model did not converge — a harness-level miss, not 'stop'.
    */
   function finishReason(resp) {
      return resp.choices?.[0]?.finish_reason ?? null;
   }

   /**
    * Wait until llama-server is ready to accept inference requests.
    * /health returns 200 immediately when the HTTP server starts, but the model
    * may still be loading. We send a minimal probe completion and wait until it
    * doesn't return 503.
    */
   async function waitHealthy(timeoutMs = 300_000) {
      const start = Date.now();
      const deadline = start + timeoutMs;
      let lastLog = start;
      const probe = { messages: [{ role: 'user', content: 'hi' }], max_tokens: 1, stream: false };

      while (Date.now() < deadline) {
         try {
            const res = await fetch(`${baseUrl}/v1/chat/completions`, {
               method: 'POST',
               headers: { 'Content-Type': 'application/json' },
               signal: AbortSignal.timeout(5000),
               body: JSON.stringify(probe),
            });
            if (res.status !== 503) return true;   // 200 = ready; any non-503 = ready or a real error
         } catch {}
         const now = Date.now();
         if (now - lastLog >= 10_000) {
            const elapsed = Math.round((now - start) / 1000);
            console.log(`[llamacpp] waiting for model load... ${elapsed}s`);
            lastLog = now;
         }
         await new Promise((r) => setTimeout(r, 2000));
      }
      throw new Error(`llama-server not ready within ${timeoutMs}ms at ${baseUrl}`);
   }

   return { chat, tokPerSec, stripThink, content, toolCalls, finishReason, waitHealthy, baseUrl };
}
