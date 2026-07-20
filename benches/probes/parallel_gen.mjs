// Probe: parallel-generation throughput (ported from runners/parallel-gen.mjs). Starts
// the server with --parallel MAXP and fires K = 1/2/4/8 concurrent generations,
// measuring aggregate tok/s = Σ tokens ÷ wall time. Emits speed_pargen-<K>.

import { extraFlagsToString } from '../../runners/llamacpp-server.mjs';
import { makeFillPrompt } from '../../shared/codebase.mjs';

const CONC = [1, 2, 4, 8],
   MAXP = 8,
   GEN = 128;

export const bench = {
   name: 'parallel_gen',
   kind: 'probe',
   thinkDependent: false,
   resumeBench: 'speed_pargen-1',
   async run({ srv, client, model }) {
      await srv.killAll();
      await srv.waitVramClear(30000);
      const extra = `--parallel ${MAXP} ${extraFlagsToString(model.extra_flags)}`.trim();
      await srv.startServer({ hf_repo: model.hf_repo, hf_file: model.hf_file, ctx: 16384, extraFlags: extra });
      await srv.waitHealthy(360000);
      const rows = [];
      for (const k of CONC) {
         const t0 = Date.now();
         const reqs = Array.from({ length: k }, (_, i) => {
            const built = makeFillPrompt(512);
            built.messages[built.messages.length - 1].content = `// pargen ${k}-${i}\n${built.messages[built.messages.length - 1].content}`;
            return client
               .chat(built.messages, { think: null, max_tokens: GEN, temperature: 0.0, ignore_eos: true }, 900000)
               .then((r) => r.timings?.predicted_n ?? 0)
               .catch(() => 0);
         });
         const toks = (await Promise.all(reqs)).reduce((a, b) => a + b, 0);
         const wallS = (Date.now() - t0) / 1000;
         if (toks > 0 && wallS > 0) {
            rows.push({
               bench: `speed_pargen-${k}`,
               score: toks / wallS,
               tok_s: toks / wallS,
               ctx_loaded: 16384,
               status: 'ok',
               notes: `parallel=${MAXP} conc=${k}`,
            });
         }
      }
      return rows;
   },
};
