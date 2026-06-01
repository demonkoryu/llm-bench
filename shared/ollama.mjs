/**
 * Ollama /api/chat transport helpers.
 *
 * Centralizes: chat(), unloadAll(), warmup(), getLoadedModels().
 * `think` is always passed as a top-level field (NOT inside options) —
 * Ollama ignores it inside options (documented bug in wisp-vault-mcp-ts runs).
 */

const DEFAULT_HOST = process.env.OLLAMA_HOST ?? 'http://192.168.1.120:11434';
const DEFAULT_TIMEOUT_MS = 600_000;

export function ollamaClient(host = DEFAULT_HOST) {
   async function request(path, body, timeoutMs = DEFAULT_TIMEOUT_MS) {
      const res = await fetch(`${host}${path}`, {
         method: 'POST',
         headers: { 'Content-Type': 'application/json' },
         signal: AbortSignal.timeout(timeoutMs),
         body: JSON.stringify(body),
      });
      if (!res.ok) {
         throw new Error(`Ollama ${path} HTTP ${res.status}: ${await res.text().catch(() => '')}`);
      }
      return res.json();
   }

   /**
    * Send a chat request.
    * @param {object} opts
    * @param {string}  opts.model
    * @param {Array}   opts.messages
    * @param {boolean|null} opts.think   top-level think flag (null = omit)
    * @param {object|null}  opts.format  JSON schema for structured output
    * @param {Array|null}   opts.tools   Ollama native tools array
    * @param {object}  opts.options      sampling params (temperature, top_p, etc.)
    * @param {number}  [opts.timeoutMs]
    * Returns raw Ollama response body.
    */
   async function chat({ model, messages, think = null, format = null, tools = null, options = {}, timeoutMs }) {
      const body = { model, messages, stream: false, options };
      if (think !== null) body.think = think;
      if (format) body.format = format;
      if (tools) body.tools = tools;
      return request('/api/chat', body, timeoutMs ?? DEFAULT_TIMEOUT_MS);
   }

   /** Returns array of currently loaded model names. */
   async function getLoadedModels() {
      try {
         const res = await fetch(`${host}/api/ps`, { signal: AbortSignal.timeout(5000) });
         return (await res.json()).models ?? [];
      } catch {
         return [];
      }
   }

   /** Unload all currently loaded models (keep_alive: 0). */
   async function unloadAll() {
      const models = await getLoadedModels();
      for (const m of models) {
         await fetch(`${host}/api/generate`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ model: m.name, keep_alive: 0 }),
            signal: AbortSignal.timeout(15_000),
         }).catch(() => {});
      }
   }

   /**
    * Warm up model with a tiny request to ensure it's loaded before timing starts.
    * Uses /no_think suffix if the model supports think mode.
    */
   async function warmup(model, supportsThink = false) {
      const content = supportsThink ? 'Hi /no_think' : 'Hi';
      try {
         await chat({
            model,
            messages: [{ role: 'user', content }],
            think: supportsThink ? false : null,
            options: { num_predict: 1 },
            timeoutMs: 120_000,
         });
      } catch {
         // warmup failures are non-fatal
      }
   }

   /** Extract tok/s from a response body. */
   function tokPerSec(body) {
      if (body.eval_count && body.eval_duration) {
         return body.eval_count / (body.eval_duration / 1e9);
      }
      return null;
   }

   /** Extract thinking character count from a response body. */
   function thinkChars(body) {
      return body.message?.thinking?.length
         ?? body.message?.content?.match(/<think>([\s\S]*?)<\/think>/)?.[1]?.length
         ?? 0;
   }

   return { chat, getLoadedModels, unloadAll, warmup, tokPerSec, thinkChars, host };
}
