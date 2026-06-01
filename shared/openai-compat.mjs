/**
 * OpenAI-compatible transport for llama.cpp server and MLX runner.
 * Used for the long-context KV sweep (llama-server --port X).
 */

const DEFAULT_URL = process.env.LLAMA_URL ?? 'http://127.0.0.1:8090';
const DEFAULT_TIMEOUT_MS = 600_000;

export function openaiCompatClient(baseUrl = DEFAULT_URL) {
   /**
    * POST /v1/chat/completions
    * @param {Array}  messages
    * @param {object} opts      temperature, max_tokens, stream, etc.
    */
   async function chat(messages, opts = {}, timeoutMs = DEFAULT_TIMEOUT_MS) {
      const res = await fetch(`${baseUrl}/v1/chat/completions`, {
         method: 'POST',
         headers: { 'Content-Type': 'application/json' },
         signal: AbortSignal.timeout(timeoutMs),
         body: JSON.stringify({ messages, stream: false, ...opts }),
      });
      if (!res.ok) {
         throw new Error(`OpenAI-compat HTTP ${res.status}: ${await res.text().catch(() => '')}`);
      }
      return res.json();
   }

   /** Wait until /health returns 200 or timeout expires. */
   async function waitHealthy(timeoutMs = 60_000) {
      const deadline = Date.now() + timeoutMs;
      while (Date.now() < deadline) {
         try {
            const res = await fetch(`${baseUrl}/health`, { signal: AbortSignal.timeout(2000) });
            if (res.ok) return true;
         } catch {}
         await new Promise((r) => setTimeout(r, 1000));
      }
      throw new Error(`llama-server not healthy within ${timeoutMs}ms at ${baseUrl}`);
   }

   return { chat, waitHealthy, baseUrl };
}
