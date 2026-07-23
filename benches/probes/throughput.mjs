// Probe: throughput + TTFT at depth (ported from runners/throughput-ttft.mjs).
// Emits e2e-<k>k (e2e tok/s, decode tok/s, prefill tok/s) + ttft-<k>k (ms).
// Self-manages the server (loads at maxctx so the depths fit); a unique nonce per rep
// busts the KV prefix cache for a true full prefill.
//
// Two measurement paths by engine:
//   • llama.cpp — one non-streaming request per rep; the server's `timings` object gives the
//     authoritative prefill/decode split and TTFT = prompt_ms (server-measured).
//   • MLX/OptiQ — no server `timings`, so we STREAM (SSE) and clock wall-time to the first emitted
//     token for a real TTFT (≈ prefill + 1 decode; localhost RTT negligible), deriving e2e/decode/
//     prefill from the terminal include_usage chunk. This is the only way to fill ttft on Apple Silicon.

import { extraFlagsToString } from '../../runners/llamacpp-server.mjs';
import { makeFillPrompt } from '../../shared/codebase.mjs';

const median = (xs) => {
   const s = xs.filter(Number.isFinite).sort((a, b) => a - b);
   const n = s.length;
   return n ? (n % 2 ? s[(n - 1) / 2] : (s[n / 2 - 1] + s[n / 2]) / 2) : null;
};
const MLX_ENGINES = new Set(['optiq', 'rapidmlx']);
const DEPTHS = [2048, 8192, 32768];
const GEN = 128,
   REPS = 2;

export const bench = {
   name: 'throughput',
   kind: 'probe',
   thinkDependent: false,
   resumeBench: 'e2e-32k',
   async run({ srv, client, model, maxctx }) {
      const ctx = Math.max(maxctx, 8192);
      const isMlx = MLX_ENGINES.has(model.engine ?? 'llamacpp');
      await srv.killAll();
      await srv.waitVramClear(30000);
      await srv.startServer({ hf_repo: model.hf_repo, hf_file: model.hf_file, ctx, extraFlags: extraFlagsToString(model.extra_flags) });
      await srv.waitHealthy(360000);
      let nonce = 0;
      const rows = [];
      for (const d of DEPTHS.filter((x) => x + GEN + 512 < ctx)) {
         const ttfts = [],
            e2es = [],
            decs = [],
            prefs = [];
         for (let r = 0; r < REPS; r++) {
            const built = makeFillPrompt(d);
            const um = built.messages[built.messages.length - 1];
            um.content = `// throughput probe ${++nonce}\n${um.content}`;
            if (isMlx) {
               // MLX/OptiQ: no server timings. Stream to clock a real TTFT (wall-ms to the first token)
               // and derive e2e/decode/prefill from the include_usage token counts. TTFT ≈ prefill + 1
               // decode; e2e = (prompt+completion)/wall; decode ≈ tokens-after-first ÷ (wall − ttft).
               let s;
               try {
                  s = await client.chatStream(built.messages, { think: null, max_tokens: GEN, temperature: 0.0, ignore_eos: true }, 900000);
               } catch {
                  continue;
               }
               const pt = s.usage?.prompt_tokens,
                  ct = s.usage?.completion_tokens;
               if (Number.isFinite(s.ttftMs)) {
                  ttfts.push(s.ttftMs);
               }
               if (Number.isFinite(s.wallMs) && s.wallMs > 0 && Number.isFinite(pt) && Number.isFinite(ct) && pt + ct > 0) {
                  e2es.push((pt + ct) / (s.wallMs / 1000));
                  if (Number.isFinite(s.ttftMs) && s.wallMs > s.ttftMs && ct > 1) {
                     decs.push((ct - 1) / ((s.wallMs - s.ttftMs) / 1000));
                  }
                  if (Number.isFinite(s.ttftMs) && s.ttftMs > 0 && pt > 0) {
                     prefs.push(pt / (s.ttftMs / 1000));
                  }
               }
               continue;
            }
            let t;
            try {
               ({ timings: t } = await client.chat(
                  built.messages,
                  { think: null, max_tokens: GEN, temperature: 0.0, ignore_eos: true },
                  900000,
               ));
            } catch {
               continue;
            }
            const pn = t?.prompt_n,
               pm = t?.prompt_ms,
               gn = t?.predicted_n,
               gm = t?.predicted_ms;
            if ([pn, pm, gn, gm].every(Number.isFinite) && pm + gm > 0) {
               // llama.cpp server timings → full prefill/decode/ttft split.
               ttfts.push(pm);
               e2es.push(((pn + gn) / (pm + gm)) * 1000);
               decs.push(gn / (gm / 1000));
               prefs.push(pn / (pm / 1000));
            } else {
               // Defensive fallback (llama.cpp response missing timings): wall-clock e2e tok/s only.
               const e2e = client.e2eTokPerSec();
               if (Number.isFinite(e2e)) {
                  e2es.push(e2e);
               }
            }
         }
         const k = Math.round(d / 1024);
         if (e2es.length) {
            rows.push({ bench: `e2e-${k}k`, score: median(e2es), tok_s: median(decs), prefill_tps: median(prefs), status: 'ok' });
         }
         if (ttfts.length) {
            rows.push({ bench: `ttft-${k}k`, score: median(ttfts), status: 'ok' });
         }
      }
      return rows;
   },
};
