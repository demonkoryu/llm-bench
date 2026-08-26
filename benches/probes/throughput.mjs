// Probe: throughput + TTFT at depth (ported from runners/throughput-ttft.mjs).
// Emits e2e-<k>k (e2e tok/s, decode tok/s, prefill tok/s) + ttft-<k>k (ms).
// Self-manages the server (loads at maxctx so the depths fit); a unique nonce per rep
// busts the KV prefix cache for a true full prefill.
//
// TTFT IS MEASURED WARM, and that takes a second request — so each rep sends the prompt twice:
//   1. COLD (unique nonce, full prefill)   → e2e / decode tok/s / prefill tok/s
//   2. WARM (byte-identical resend, prefix cache hit) → ttft-<k>k
// The two cannot come from one request. Throughput wants the cold prefill (that IS the prefill
// measurement), while TTFT-as-published is a latency figure, and a cold full prefill at depth is
// not the latency anything experiences — it is a cache-miss worst case. At 32k on Qwen3.6-27B the
// gap is 12x (62,328 ms cold vs 5,131 ms warm), so which one the row means is not a detail.
//
// This probe is now the SOLE producer of ttft-<k>k. quality_decay used to emit ttft rows too, from
// prompt_ms on its accuracy requests, and the two collided: same bench name, same dimensions, so
// they were indistinguishable in the store and $LATEST picked by timestamp. Worse, they disagreed
// about what the metric meant — this one was cold, that one incidentally warm (it reused one
// deterministic prompt across 3 reps, so its median landed on a cache hit). The published family was
// incoherent by depth: 2k/8k cold from here, 0k/16k/64k warm from there, 32k a race between them.
// Depth coverage is now this probe's DEPTHS only; 0k/16k/64k are no longer produced.
//
// Not emitted: a cold ttft companion. The cold number is already published as e2e-<k>k's
// prefill_tps (same prompt_ms, expressed as tok/s), and prefix_cache_cold_ms covers cold latency at
// 8k — a third spelling would be a new bench name in tidy-schema for no new information.
//
// Two measurement paths by engine:
//   • llama.cpp — one non-streaming request per rep; the server's `timings` object gives the
//     authoritative prefill/decode split and TTFT = prompt_ms (server-measured).
//   • MLX/OptiQ and NInfer — no server `timings`, so we STREAM (SSE) and clock wall-time to the first
//     emitted token for a real TTFT (≈ prefill + 1 decode; localhost RTT negligible), deriving
//     e2e/decode/prefill from the terminal include_usage chunk. This is the only way to fill ttft
//     on Apple Silicon, and the only way to get a prefill/decode SPLIT out of NInfer at all —
//     ninfer-serve returns a standard `usage` block and nothing else, so the non-streaming path
//     below would silently degrade it to the wall-clock e2e fallback and leave ttft/prefill null.

import { extraFlagsToString, LOAD_TIMEOUT_MS } from '../../runners/llamacpp-server.mjs';
import { makeFillPrompt } from '../../shared/codebase.mjs';

const median = (xs) => {
   const s = xs.filter(Number.isFinite).sort((a, b) => a - b);
   const n = s.length;
   return n ? (n % 2 ? s[(n - 1) / 2] : (s[n / 2 - 1] + s[n / 2]) / 2) : null;
};
// Engines whose server response carries NO llama.cpp `timings` object, so the split has to be
// clocked client-side from an SSE stream. Membership is about the response shape, not the vendor.
const NO_SERVER_TIMINGS = new Set(['optiq', 'rapidmlx', 'ninfer']);
const DEPTHS = [2048, 8192, 32768];
const GEN = 128,
   REPS = 2;
// The warm rep only needs the first token's arrival, so it generates almost nothing. Kept above 1 so
// the streaming path still sees a delta to clock.
const WARM_GEN = 8;

export const bench = {
   name: 'throughput',
   kind: 'probe',
   thinkDependent: false,
   // Self-manages the server (see killAll + startServer below); skip the prestart.
   selfManagesServer: true,
   resumeBench: 'e2e-32k',
   async run({ srv, client, model, maxctx }) {
      const ctx = Math.max(maxctx, 8192);
      const streamForTimings = NO_SERVER_TIMINGS.has(model.engine ?? 'llamacpp');
      await srv.killAll();
      await srv.waitVramClear(30000);
      await srv.startServer({ hf_repo: model.hf_repo, hf_file: model.hf_file, ctx, extraFlags: extraFlagsToString(model.extra_flags) });
      await srv.waitHealthy(LOAD_TIMEOUT_MS);
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
            if (streamForTimings) {
               // No server timings. Stream to clock TTFT (wall-ms to the first token) and derive
               // e2e/decode/prefill from the include_usage token counts. TTFT ≈ prefill + 1 decode;
               // e2e = (prompt+completion)/wall; decode ≈ tokens-after-first ÷ (wall − ttft).
               let s;
               try {
                  s = await client.chatStream(built.messages, { think: null, max_tokens: GEN, temperature: 0.0, ignore_eos: true }, 900000);
               } catch {
                  continue;
               }
               const pt = s.usage?.prompt_tokens,
                  ct = s.usage?.completion_tokens;
               // The COLD ttftMs still drives the prefill/decode split — on these engines it is the
               // only prefill signal there is — but it is no longer what gets published as ttft.
               if (Number.isFinite(s.wallMs) && s.wallMs > 0 && Number.isFinite(pt) && Number.isFinite(ct) && pt + ct > 0) {
                  e2es.push((pt + ct) / (s.wallMs / 1000));
                  if (Number.isFinite(s.ttftMs) && s.wallMs > s.ttftMs && ct > 1) {
                     decs.push((ct - 1) / ((s.wallMs - s.ttftMs) / 1000));
                  }
                  if (Number.isFinite(s.ttftMs) && s.ttftMs > 0 && pt > 0) {
                     prefs.push(pt / (s.ttftMs / 1000));
                  }
               }
               // Warm rep: identical prompt, so the prefix cache serves it and the clock measures
               // real first-token latency rather than a cache miss.
               try {
                  const w = await client.chatStream(
                     built.messages,
                     { think: null, max_tokens: WARM_GEN, temperature: 0.0, ignore_eos: true },
                     900000,
                  );
                  if (Number.isFinite(w.ttftMs)) {
                     ttfts.push(w.ttftMs);
                  }
               } catch {
                  /* warm rep is ttft-only; losing it costs no throughput sample */
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
               // llama.cpp server timings → full prefill/decode split. prompt_ms here is the COLD
               // prefill (the nonce guaranteed a cache miss), which is exactly what prefill_tps
               // wants and exactly what ttft must not be.
               e2es.push(((pn + gn) / (pm + gm)) * 1000);
               decs.push(gn / (gm / 1000));
               prefs.push(pn / (pm / 1000));
               // Warm rep: same messages, so llama.cpp reuses the cached prefix and prompt_ms
               // collapses to the real first-token latency.
               try {
                  const { timings: wt } = await client.chat(
                     built.messages,
                     { think: null, max_tokens: WARM_GEN, temperature: 0.0, ignore_eos: true },
                     900000,
                  );
                  if (Number.isFinite(wt?.prompt_ms)) {
                     ttfts.push(wt.prompt_ms);
                  }
               } catch {
                  /* warm rep is ttft-only; losing it costs no throughput sample */
               }
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
            rows.push({
               bench: `e2e-${k}k`,
               score: median(e2es),
               tok_s: median(decs),
               prefill_tps: median(prefs),
               status: 'ok',
               lane_ctx: ctx,
            });
         }
         if (ttfts.length) {
            rows.push({ bench: `ttft-${k}k`, score: median(ttfts), status: 'ok', lane_ctx: ctx });
         }
      }
      return rows;
   },
};
