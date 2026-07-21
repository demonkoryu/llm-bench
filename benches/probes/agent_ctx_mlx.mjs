// Probe: multi-agent context fit — omlx (MLX / Apple Silicon) variant.
//
// The llama.cpp agent_ctx probe (agent_ctx.mjs) reloads llama-server at different
// `-c/--parallel --kv-unified` and gates on rocm-smi VRAM+GTT spill against the RX 7900 XT's
// physical VRAM. NONE of that exists on Apple Silicon + omlx: unified memory has no VRAM/GTT
// split, there is no rocm-smi, and omlx is a persistent daemon that sets context per-model —
// there is no server-reload flag to sweep. So this variant is PURELY CLIENT-DRIVEN (plain HTTP,
// no server reloads, no memory snapshots), reusing the SAME needle-in-haystack fills and the
// SAME "does the slot retrieve ITS OWN needle" coherence gate as the llama.cpp probe.
//
// It emits `bench: 'agent_ctx'` with the identical row shape, so it feeds the existing fleet
// score (analysis/score.mjs) and the `general`-scope path with NO schema/scoring change. The
// gate is coherence + request success (memory pressure surfaces as an omlx error or an
// incoherent slot), not a VRAM formula. Total requests are bounded (~a dozen), mirroring how
// the llama.cpp probe bounds its reloads (MAX_LOADS).

import { makeFillPrompt } from '../../shared/codebase.mjs';

// Agent profile — mirrors the llama.cpp probe (PLANNER_TARGET / CODER_TARGET) and the fleet
// dials in analysis/scoring-config.mjs. Both are capped per-config at the model's coherent window.
const PLANNER_TARGET = 131072;
const CODER_TARGET = 65536;
const FLOOR = 8192; // smallest depth we bother probing
const REQUEST_BUDGET = 18; // hard cap on total inference requests (bounds wall-clock + cost)
const MAX_CODERS = 6; // ceiling on the agent-slot search rungs

const round4k = (n) => Math.max(4096, Math.round(n / 4096) * 4096);

// Per-request timeout scales with the TOTAL concurrent token load: under N-way concurrency the
// device is shared, so each request's wall time tracks the aggregate prefill, not just its own
// depth. Pessimistic ~150 tok/s shared prefill on M1; floor 5 min, cap 45 min so a hang still ends.
function fillTimeoutMs(totalTokens) {
   const est = Math.round((totalTokens / 150) * 1000);
   return Math.min(2_700_000, Math.max(300_000, est));
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

export async function runMlx({ srv, client, model, caps }) {
   const think = model.think === 'optional' ? false : null;
   const thinkControl = model.think_control ?? 'enable_thinking';

   // Per-sequence coherent window: reuse a measured ceiling if present, else the yaml caps.
   // Planner/coder targets can never exceed it (RoPE breaks past the trained window).
   const coherentWindow = caps?.coherence_ceiling ?? model.ctx_cap ?? model.native_max_ctx ?? PLANNER_TARGET;
   const hardCap = round4k(Math.min(model.native_max_ctx ?? PLANNER_TARGET, coherentWindow));
   const startDepth = round4k(Math.min(model.ctx_cap ?? 32768, hardCap));

   let requests = 0;
   const test = async (depth) => {
      const [r] = await runSlots(client, [depth], { think, thinkControl });
      requests++;
      console.log(`  [agent_ctx/mlx] single ${Math.round(depth / 1024)}k: ${r.ok ? '✓ coherent' : `✗ (${r.err ?? 'incoherent'})`}`);
      return r.ok;
   };

   // Select the served model + confirm omlx is reachable (no lifecycle — just sets the request id).
   try {
      await srv.startServer({ hf_repo: model.hf_repo, mlxModel: model.mlx_model });
      await srv.waitHealthy(120_000);
   } catch (e) {
      return fail(model, `omlx not ready: ${(e.message ?? '').slice(0, 80)}`);
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

   const plannerTarget = round4k(Math.min(PLANNER_TARGET, plannerCtx));
   const coderCtx = round4k(Math.min(CODER_TARGET, plannerCtx));

   // ── Phase 2: agent slots — how many concurrent coders cohere ALONGSIDE the planner ──────────
   // Rung k fires (1 planner@planner_ctx + k coders@coder_ctx) concurrently. The largest k where
   // EVERY slot retrieves its own needle (and none error) is n_coders. First rung that breaks
   // (an omlx error = memory pressure, or an incoherent slot) stops the ascent.
   let nCoders = 0;
   let coherentSlots = 1; // planner alone established coherent above
   let lastNotes = 'planner only';
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
         score: nCoders, // headline: coder agents supported alongside the planner
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
