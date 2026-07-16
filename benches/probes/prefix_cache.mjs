// Probe: prefix-cache reuse (ported from runners/prompt-cache.mjs). Sends a fixed
// large prefix COLD (unique nonce → full prefill) then WARM (identical → prefill
// skipped), median over reps. Emits prefix_cache_cold_ms / _warm_ms / _speedup.

import { extraFlagsToString } from '../../runners/llamacpp-server.mjs';
import { makeFillPrompt } from '../../shared/codebase.mjs';

const median = (xs) => {
   const s = xs.filter(Number.isFinite).sort((a, b) => a - b);
   const n = s.length;
   return n ? (n % 2 ? s[(n - 1) / 2] : (s[n / 2 - 1] + s[n / 2]) / 2) : null;
};
const REPS = 3,
   DEPTH = 8192;

export const bench = {
   name: 'prefix_cache',
   kind: 'probe',
   thinkDependent: false,
   resumeBench: 'prefix_cache_cold_ms',
   async run({ srv, client, model, maxctx }) {
      const ctx = Math.max(maxctx, 16384);
      const depth = Math.min(DEPTH, Math.max(1024, ctx - 1024));
      await srv.killAll();
      await srv.waitVramClear(30000);
      await srv.startServer({ hf_repo: model.hf_repo, hf_file: model.hf_file, ctx, extraFlags: extraFlagsToString(model.extra_flags) });
      await srv.waitHealthy(360000);
      const ttftOf = async (messages) => {
         const { timings } = await client.chat(messages, { think: null, max_tokens: 4, temperature: 0.0 }, 900000);
         return timings?.prompt_ms;
      };
      let nonce = 0;
      const colds = [],
         warms = [];
      for (let r = 0; r < REPS; r++) {
         const built = makeFillPrompt(depth);
         const um = built.messages[built.messages.length - 1];
         um.content = `// prefix-cache probe ${++nonce}\n${um.content}`;
         try {
            colds.push(await ttftOf(built.messages));
            warms.push(await ttftOf(built.messages));
         } catch {
            /* skip */
         }
      }
      const cold = median(colds),
         warm = median(warms);
      if (cold == null || warm == null) return [];
      return [
         { bench: 'prefix_cache_cold_ms', score: cold, status: 'ok' },
         { bench: 'prefix_cache_warm_ms', score: warm, status: 'ok' },
         { bench: 'prefix_cache_speedup', score: warm ? cold / warm : null, status: 'ok' },
      ];
   },
};
