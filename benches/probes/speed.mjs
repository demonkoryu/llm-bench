// Probe: decode/prefill speed (ported from run-suite runSpeed). Emits speed_short,
// speed_long-32k (decode tok/s on tiny vs large-gen prompts) + speed_prefill-4k/12k
// (prefill tok/s on synthetic codebase prompts). Uses the server already loaded by a
// prior probe if present; else loads at maxctx.

import { extraFlagsToString } from '../../runners/llamacpp-server.mjs';
import { makeFillPrompt } from '../../shared/codebase.mjs';

const SHORT = 'Tell me a single short sentence about the sky.';
const LONG =
   'Tell me about the history of computing. Be as comprehensive as possible and write at least 2000 words covering all major developments from ancient times to today.';

export const bench = {
   name: 'speed',
   kind: 'probe',
   thinkDependent: false,
   resumeBench: 'speed_short',
   async run({ srv, client, model, maxctx }) {
      const ctx = Math.max(maxctx, 16384);
      await srv.killAll();
      await srv.waitVramClear(30000);
      await srv.startServer({ hf_repo: model.hf_repo, hf_file: model.hf_file, ctx, extraFlags: extraFlagsToString(model.extra_flags) });
      await srv.waitHealthy(360000);
      const rows = [];
      for (const [label, prompt] of [
         ['short', SHORT],
         ['long-32k', LONG],
      ]) {
         try {
            await client.chat([{ role: 'user', content: prompt }], { think: null, max_tokens: 512, temperature: 0.7 });
            // llama.cpp: server timings. MLX/OptiQ: no timings → wall-clock e2e. These prompts are
            // decode-dominated (512 gen, tiny prompt) so e2e ≈ decode tok/s. Skip the row if neither
            // source yields a value (avoids banking null-scored rows the store would drop anyway).
            const dec = client.tokPerSec() ?? client.e2eTokPerSec();
            if (Number.isFinite(dec)) {
               rows.push({ bench: `speed_${label}`, score: dec, tok_s: dec, prefill_tps: client.prefillTokPerSec(), status: 'ok' });
            }
         } catch {
            /* skip */
         }
      }
      let nonce = 0;
      for (const promptTokens of [4096, 12288]) {
         if (promptTokens + 512 >= ctx) {
            continue;
         }
         const built = makeFillPrompt(promptTokens);
         const um = built.messages[built.messages.length - 1];
         um.content = `// speed prefill ${++nonce}\n${um.content}`;
         try {
            await client.chat(built.messages, { think: null, max_tokens: 8, temperature: 0.0, ignore_eos: true }, 900000);
            // Prefill-dominated (big prompt, 8 gen) → server prefill tps, else wall-clock e2e ≈ prefill tps.
            const pre = client.prefillTokPerSec() ?? client.e2eTokPerSec();
            if (Number.isFinite(pre)) {
               rows.push({ bench: `speed_prefill-${Math.round(promptTokens / 1024)}k`, score: pre, prefill_tps: pre, status: 'ok' });
            }
         } catch {
            /* skip */
         }
      }
      return rows;
   },
};
