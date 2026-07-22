// Probe: max coherent context — MLX (OptiQ / Apple Silicon) variant, single-client.
//
// The llama.cpp agent_ctx probe (agent_ctx.mjs) reloads llama-server across a shared-KV-pool
// sweep and gates on rocm-smi VRAM+GTT spill against the RX 7900 XT's physical VRAM. NONE of that
// exists on Apple Silicon + MLX: unified memory has no VRAM/GTT split, there is no rocm-smi,
// and the OptiQ daemon is persistent with no server-reload context flag to sweep. So this
// variant is PURELY CLIENT-DRIVEN (plain HTTP, no reloads, no memory snapshots), reusing the SAME
// needle-in-haystack fills and the SAME "does the slot retrieve ITS OWN needle" coherence gate.
//
// SINGLE-CLIENT constraint: this deployment serves at most ONE concurrent request (the daemon runs
// `--max-concurrent 1`; no coder sub-agents). So `MAX_CODERS = 0` — the probe measures the deepest
// coherent SINGLE-sequence context and stops. That single-slot ceiling IS a real coherence ceiling
// (unlike the llama.cpp shared-pool total), so we write it to the caps cache via `upsertCap` so the
// downstream depth probes (quality_decay / throughput / speed) load at the MEASURED depth instead
// of the seeded ctx_cap. This is why the plan runs agent_ctx FIRST.
//
// It emits `bench: 'agent_ctx'` with the identical row shape, so it feeds the existing fleet score
// (analysis/score.mjs) with NO schema/scoring change. The gate is coherence + request success
// (memory pressure surfaces as an OptiQ error or an incoherent slot), not a VRAM formula. Total
// requests are bounded (REQUEST_BUDGET), mirroring how the llama.cpp probe bounds its reloads.

import { makeFillPrompt } from '../../shared/codebase.mjs';

// Agent profile — mirrors the llama.cpp probe (PLANNER_TARGET / CODER_TARGET) and the fleet dials
// in analysis/scoring-config.mjs. Capped per-config at the model's coherent window. PLANNER_TARGET
// is set to the deepest single-sequence context we'd ever report; for this single-client, max-context
// deployment that is the native trained window (262144) so a full-depth result is not under-reported.
const PLANNER_TARGET = 262144;
const CODER_TARGET = 65536;
const FLOOR = 8192; // smallest depth we bother probing
const REQUEST_BUDGET = 12; // hard cap on total inference requests (bounds wall-clock)
const MAX_CODERS = 0; // SINGLE-CLIENT: no coder sub-agents (daemon serves --max-num-seqs 1)

const round4k = (n) => Math.max(4096, Math.round(n / 4096) * 4096);

// Per-request timeout for a SINGLE sequence (no concurrency — only one request is ever in flight,
// so we can afford a long ceiling). The M1 (original, 32 GB) prefills a 27B-4bit slowly, and once
// KV nears the wired-memory ceiling the MLX runtime throttles prefill hard — measured tens of tok/s.
// So the estimate is deliberately pessimistic (~25 tok/s) with a 15-min floor and a 60-min cap:
// under-timing here aborts a slow-but-fine request mid-prefill (surfaces as a fetch error) and
// false-fails the depth. A genuine over-capacity request either errors from OptiQ or hits the cap.
function fillTimeoutMs(totalTokens) {
   const est = Math.round((totalTokens / 25) * 1000);
   return Math.min(3_600_000, Math.max(900_000, est));
}

// Fire one code-needle request per slot concurrently; return per-slot {ok, err}. Each slot gets a
// slightly different fill size → a different synthetic codebase + needle, so a coherent result
// proves that slot retrieved ITS OWN answer (not a neighbour's). Identical to the llama.cpp probe.
async function runSlots(client, sizes, { think, thinkControl }) {
   const timeoutMs = fillTimeoutMs(sizes.reduce((a, b) => a + b, 0));
   const reqs = sizes.map((size, i) => {
      const built = makeFillPrompt(Math.floor(size * (1 - 0.01 * i)));
      const expected = String(built.expectedAnswer).toLowerCase();
      return client
         .chat(built.messages, { think, thinkControl, temperature: 0.0, max_tokens: 256 }, timeoutMs)
         .then((r) => {
            const got = (r.completion?.choices?.[0]?.message?.content ?? '').toLowerCase();
            return { ok: got.includes(expected), err: null };
         })
         .catch((e) => ({ ok: false, err: (e.message ?? '').slice(0, 80) }));
   });
   return Promise.all(reqs);
}

export async function runMlx({ srv, client, model, caps, upsertCap }) {
   const think = model.think === 'optional' ? false : null;
   const thinkControl = model.think_control ?? 'enable_thinking';

   // Hard ceiling = the trained window (native_max_ctx; RoPE breaks past it), or a previously
   // MEASURED coherence_ceiling if we've probed before. ctx_cap is NOT the ceiling — it is only the
   // climb START (a conservative seed). The whole point of this probe is to discover the real ceiling
   // ABOVE that seed, so the climb must be free to reach native_max_ctx.
   const coherentWindow = caps?.coherence_ceiling ?? model.native_max_ctx ?? model.ctx_cap ?? PLANNER_TARGET;
   // `probe_max_ctx` (optional) caps how deep this probe is allowed to CLIMB, independent of the
   // model's real trained window (native_max_ctx, kept factually correct for the rest of the fleet).
   // The M1/OptiQ config sets it to 131072 per the operator's "128k is enough — don't check 256k"
   // instruction: the climb tests up to 128k and records that as the ceiling without a 256k prefill.
   const probeCeiling = model.probe_max_ctx ?? model.native_max_ctx ?? PLANNER_TARGET;
   const hardCap = round4k(Math.min(probeCeiling, coherentWindow));
   const startDepth = round4k(Math.min(model.ctx_cap ?? 32768, hardCap));

   let requests = 0;
   const test = async (depth) => {
      const [r] = await runSlots(client, [depth], { think, thinkControl });
      requests++;
      console.log(`  [agent_ctx/mlx] single ${Math.round(depth / 1024)}k: ${r.ok ? '✓ coherent' : `✗ (${r.err ?? 'incoherent'})`}`);
      return r.ok;
   };

   // Select the served model + confirm the MLX daemon is reachable (no lifecycle — just sets the request id).
   try {
      await srv.startServer({ hf_repo: model.hf_repo, mlxModel: model.mlx_model });
      await srv.waitHealthy(120_000);
   } catch (e) {
      return fail(model, `optiq not ready: ${(e.message ?? '').slice(0, 80)}`);
   }

   // ── Phase 1: deepest single-sequence coherent context (planner_ctx) ─────────────────────────
   // Start at the yaml ctx_cap; if it coheres, climb ×2 toward native_max_ctx until it fails; if
   // it does NOT, descend ÷2 until it coheres or hits the floor. Monotonic-coherence assumption,
   // bounded to a handful of requests.
   let plannerCtx = 0;
   if (await test(startDepth)) {
      plannerCtx = startDepth;
      let d = startDepth;
      while (d * 2 <= hardCap && requests < REQUEST_BUDGET) {
         d = round4k(d * 2);
         if (await test(d)) {
            plannerCtx = d;
         } else {
            break;
         }
      }
   } else {
      let d = startDepth;
      while (d > FLOOR && requests < REQUEST_BUDGET) {
         d = round4k(d / 2);
         if (await test(d)) {
            plannerCtx = d;
            break;
         }
      }
   }

   if (!plannerCtx) {
      return fail(model, `no coherent single-sequence context ≥ ${Math.round(FLOOR / 1024)}k`);
   }

   // Persist the measured single-slot ceiling so the depth probes (quality_decay/throughput/speed)
   // load at THIS depth instead of the seeded ctx_cap. Safe: only widens/narrows this config's caps.
   upsertCap?.({ coherence_ceiling: plannerCtx });

   const plannerTarget = round4k(Math.min(PLANNER_TARGET, plannerCtx));
   const coderCtx = round4k(Math.min(CODER_TARGET, plannerCtx));

   // ── Phase 2: agent slots — how many concurrent coders cohere ALONGSIDE the planner ──────────
   // DISABLED for the single-client deployment (MAX_CODERS = 0): this loop does not execute, so
   // n_coders stays 0 and the headline metric is the single-session max context above. Retained
   // (guarded) so a future multi-client MLX host can re-enable coder search by raising MAX_CODERS.
   let nCoders = 0;
   let coherentSlots = 1; // planner alone established coherent above
   let lastNotes = 'planner only (single-client)';
   for (let k = 1; k <= MAX_CODERS && requests + (1 + k) <= REQUEST_BUDGET; k++) {
      const sizes = [plannerTarget, ...Array.from({ length: k }, () => coderCtx)];
      const results = await runSlots(client, sizes, { think, thinkControl });
      requests += sizes.length;
      const coherent = results.filter((r) => r.ok).length;
      const errored = results.some((r) => r.err);
      const allOk = coherent === sizes.length && !errored;
      console.log(
         `  [agent_ctx/mlx] 1 planner@${plannerTarget / 1024}k + ${k} coders@${coderCtx / 1024}k → ${coherent}/${sizes.length} coherent${errored ? ' (error)' : ''} ${allOk ? 'OK' : 'STOP'}`,
      );
      if (allOk) {
         nCoders = k;
         coherentSlots = coherent;
         lastNotes = `1x${plannerTarget / 1024}k+${k}x${coderCtx / 1024}k`;
      } else {
         break;
      }
   }

   const nSlots = 1 + nCoders;
   const totalCtx = plannerTarget + nCoders * coderCtx;
   const fullyCoherent = coherentSlots === nSlots;
   console.log(
      `  [agent_ctx/mlx] RESULT: 1×${plannerTarget / 1024}k planner + ${nCoders}×${coderCtx / 1024}k coders (pool ${(totalCtx / 1024).toFixed(0)}k, ${coherentSlots}/${nSlots} coherent, ${requests} reqs)`,
   );

   return [
      {
         bench: 'agent_ctx',
         score: nCoders, // headline for the multi-agent axis (0 here by single-client design)
         n_slots: nSlots,
         n_coders: nCoders,
         coherent_slots: coherentSlots,
         total_ctx: totalCtx,
         planner_ctx: plannerTarget,
         coder_ctx: coderCtx,
         verified: fullyCoherent ? 1 : 0,
         status: 'ok',
         notes: `${lastNotes} client-driven ${coherentSlots}/${nSlots}coh`,
      },
   ];
}

function fail(model, notes) {
   const plannerCtx = round4k(Math.min(PLANNER_TARGET, model.ctx_cap ?? model.native_max_ctx ?? PLANNER_TARGET));
   const coderCtx = round4k(Math.min(CODER_TARGET, model.ctx_cap ?? model.native_max_ctx ?? CODER_TARGET));
   return [
      {
         bench: 'agent_ctx',
         score: 0,
         n_slots: 1,
         n_coders: 0,
         coherent_slots: 0,
         total_ctx: plannerCtx,
         planner_ctx: plannerCtx,
         coder_ctx: coderCtx,
         verified: 0,
         status: 'skip',
         notes,
      },
   ];
}
