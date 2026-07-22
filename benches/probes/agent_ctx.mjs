// Probe: multi-agent context fit. Models the real deployment we care about — ONE loaded
// model serving a fleet of agents from a single shared KV cache: 1 planner with a large
// context + N smaller coder agents. llama.cpp realizes this with `--kv-unified` (one shared
// KV pool of `-c T` cells across all `--parallel` slots; each slot may grow up to T, capped
// at the trained window). So a 128k planner + several 64k coders coexist as long as their
// live token usage sums to ≤ T — and crucially T can exceed any single sequence's coherent
// window, because each sequence stays inside its own window while the pool aggregates them.
//
// Verified in the llm2 build (src/llama-context.cpp): kv_unified → n_ctx_seq = n_ctx (full
// pool per sequence) vs non-unified → n_ctx / n_seq_max (uniform split). We pass
// `--kv-unified` explicitly because it is only the default when `-np` is auto.
//
// Per config:
//   1. load a single planner slot, measure VRAM → estimate a starting coder count from the
//      remaining card budget (just a hint; the search is empirical).
//   2. bidirectional boundary search over the coder COUNT with a TIGHT shared pool
//      (`-c planner + k·coder --kv-unified -np 1+k`). The KV is preallocated at load, and amdgpu
//      does NOT OOM on VRAM overflow — it SPILLS into GTT (system RAM). So the deterministic gate
//      is the TOTAL footprint (VRAM + GTT, clean & monotonic) ≤ the card's VRAM, NOT an OOM crash
//      (a fitting model still parks ~1 GB on GTT). Load-only per rung (fast).
//   3. the winning plan is re-run WITH a concurrent fill: each of the planner + k coders gets a
//      distinct code needle, and the coherent-slot count is recorded (coherent_slots).
//
// Supersedes the old single-slot maxctx ladder and feeds the fleet score (analysis/score.mjs)
// with the EMPIRICAL slot count instead of a VRAM formula.

import { extraFlagsToString } from '../../runners/llamacpp-server.mjs';
import { makeFillPrompt } from '../../shared/codebase.mjs';

// Agent profile (mirrors the fleet dials in analysis/scoring-config.mjs: worker_ctx=65536,
// ctx_tier=100000). Both are capped per-config at the model's coherent window.
const PLANNER_TARGET = 131072;
const CODER_TARGET = 65536;

const CARD_TOTAL_MIB = 20464; // RX 7900 XT usable VRAM (mirrors hosts.yaml / scoring-config)
// Reserve for the STARTING estimate only (the empirical GTT-spill gate is the real limit). Leaves
// a little room for the prefill compute buffer so the search starts near the true answer; being
// off just costs a few extra (fast, load-only) search rungs.
const EST_COMPUTE_RESERVE_MIB = 1024;
const MAX_LOADS = 9; // bound the total reloads across the down-then-up boundary search

// KV-cache element size relative to q8_0 (the reference kv_bytes_per_token in models.yaml),
// from GGML type sizes (bytes/32 elems): q8_0=34, q5_0=22, q5_1=24, q4_0=18, q4_1=20, f16=64.
const KV_QUANT_RATIO = { q8_0: 1.0, q5_0: 0.647, q5_1: 0.706, q4_0: 0.529, q4_1: 0.588, f16: 1.882 };

// Flags to strip when self-managing the server: speculative-draft / MTP flags are unsupported
// with -np > 1 (embedded-tensor MTP crashes on multi-slot), and MTP is a decode-speed trick
// that does NOT change the KV footprint we're measuring, so dropping it yields the true
// multi-agent capacity for those configs. `parallel` is set by us.
const STRIP_FLAGS = new Set(['spec-type', 'model-draft', 'spec-draft-n-max', 'parallel']);

const round4k = (n) => Math.max(4096, Math.round(n / 4096) * 4096);
const kib = (tokens, kvBytesPerTok) => (tokens * kvBytesPerTok) / 1024 / 1024; // → MiB

// Per-request timeout. Under N-way concurrency the GPU is SHARED, so each request's wall time
// tracks the AGGREGATE prefill (~total concurrent tokens ÷ throughput), not just its own depth —
// a per-slot-only timeout false-fails half the slots when 6 deep prompts prefill at once (looks
// like incoherence). Scale with the TOTAL concurrent token load at a pessimistic ~200 tok/s
// shared prefill; floor 5 min, cap 45 min so a genuine hang still terminates.
function fillTimeoutMs(totalTokens) {
   const est = Math.round((totalTokens / 200) * 1000);
   return Math.min(2_700_000, Math.max(300_000, est));
}

// Build server extra-flags for the probe: keep KV-quant / no-mmproj / batch sizing, strip
// spec-draft flags, and add the shared-pool multi-slot flags.
//
// `--no-cache-idle-slots` is essential here. By default llama.cpp saves an idle slot to the
// prompt cache and CLEARS its KV from the unified pool once its request finishes — so a
// post-fill VRAM snapshot catches a half-emptied cache (non-monotonic readings that let the
// search over-accept coders). Disabling it keeps every agent's context resident, which (a) is
// the correct model for our scenario — 1 planner + N coders all live at once — and (b) makes
// the post-fill footprint the true peak, so the VRAM boundary is measured honestly.
function probeExtraFlags(model, nSlots) {
   const ef = model.extra_flags && typeof model.extra_flags === 'object' ? { ...model.extra_flags } : {};
   for (const k of STRIP_FLAGS) {
      delete ef[k];
   }
   return `--parallel ${nSlots} --kv-unified --no-cache-idle-slots ${extraFlagsToString(ef)}`.trim();
}

// Fire one code-needle request per slot concurrently; return per-slot {ok, expected, got}.
// Each slot gets a slightly different fill size → a different synthetic codebase + needle,
// so a coherent result proves that slot retrieved ITS OWN answer (not a neighbour's).
async function runSlots(client, sizes, { think, thinkControl }) {
   const timeoutMs = fillTimeoutMs(sizes.reduce((a, b) => a + b, 0)); // scale with TOTAL concurrent load
   const reqs = sizes.map((size, i) => {
      const built = makeFillPrompt(Math.floor(size * (1 - 0.01 * i)));
      const expected = String(built.expectedAnswer).toLowerCase();
      return client
         .chat(built.messages, { think, thinkControl, temperature: 0.0, max_tokens: 256 }, timeoutMs)
         .then((r) => {
            const got = (r.completion?.choices?.[0]?.message?.content ?? '').toLowerCase();
            return { ok: got.includes(expected), expected, got: got.slice(0, 60), err: null };
         })
         .catch((e) => ({ ok: false, expected, got: '', err: (e.message ?? '').slice(0, 80) }));
   });
   return Promise.all(reqs);
}

// Reloads llama-server across a shared-KV-pool sweep and gates on rocm-smi VRAM+GTT spill.
async function runLlamacpp({ srv, client, model, caps }) {
   const think = model.think === 'optional' ? false : null;
   const thinkControl = model.think_control ?? 'enable_thinking';

   // Per-sequence coherent window: reuse the measured ceiling if present, else the yaml
   // caps. Planner/coder targets can never exceed it (RoPE breaks past the trained window).
   const coherentWindow = caps?.coherence_ceiling ?? model.ctx_cap ?? model.native_max_ctx ?? PLANNER_TARGET;
   const plannerCtx = round4k(Math.min(PLANNER_TARGET, coherentWindow));
   const coderCtx = round4k(Math.min(CODER_TARGET, coherentWindow));

   const kvQuant = model.variant?.replace(/^kv/, '') ?? model.extra_flags?.['cache-type-k'] ?? 'q8_0';
   const kvBytesPerTok = (caps?.kv_bytes_per_token ?? model.kv_bytes_per_token ?? 24576) * (KV_QUANT_RATIO[kvQuant] ?? 1.0);

   const fail = (notes) => [
      {
         bench: 'agent_ctx',
         score: 0,
         n_slots: 1,
         n_coders: 0,
         total_ctx: plannerCtx,
         planner_ctx: plannerCtx,
         coder_ctx: coderCtx,
         verified: 0,
         status: 'skip',
         notes,
      },
   ];

   // ── Phase 1a: load a single planner slot, measure the footprint (VRAM + GTT) ──────
   await srv.killAll();
   await srv.waitVramClear(30_000);
   try {
      await srv.startServer({ hf_repo: model.hf_repo, hf_file: model.hf_file, ctx: plannerCtx, extraFlags: probeExtraFlags(model, 1) });
      await srv.waitHealthy(360_000);
   } catch (e) {
      return fail(`planner load failed at ${plannerCtx}: ${(e.message ?? '').slice(0, 60)}`);
   }
   const memPlanner = await srv.snapshotMem();
   const footPlanner = memPlanner.vram != null && memPlanner.gtt != null ? memPlanner.vram + memPlanner.gtt : null;
   // Confirm the planner slot alone coheres at depth (sanity — also the deepest single fill).
   const [plannerProbe] = await runSlots(client, [plannerCtx], { think, thinkControl });
   console.log(
      `  [agent_ctx] planner ${plannerCtx / 1024}k: ${plannerProbe.ok ? '✓' : '✗'} coherent  footprint=${footPlanner ?? '?'}MiB (v=${memPlanner.vram ?? '?'} g=${memPlanner.gtt ?? '?'})`,
   );

   // ── Phase 1b: estimate a STARTING coder count (only a hint; the search below is empirical) ─
   // weights ≈ footprint(planner) − KV(planner); the rest of the card holds more KV pool. Just
   // picks where the search starts — the down/up loop finds the true boundary regardless of
   // estimate error (kv_bytes_per_token is often a rough yaml guess).
   const weightsMib = footPlanner != null ? Math.max(0, footPlanner - kib(plannerCtx, kvBytesPerTok)) : null;
   const kvBudgetMib = CARD_TOTAL_MIB - EST_COMPUTE_RESERVE_MIB - (weightsMib ?? CARD_TOTAL_MIB);
   const poolTokens = weightsMib != null ? Math.floor((kvBudgetMib * 1024 * 1024) / kvBytesPerTok) : plannerCtx;
   const nCodersEst = Math.max(0, Math.floor((poolTokens - plannerCtx) / coderCtx));
   console.log(
      `  [agent_ctx] kv≈${Math.round(kvBytesPerTok)}B/tok (${kvQuant})  weights≈${weightsMib ?? '?'}MiB  → est ${nCodersEst} coders`,
   );

   // loadAndCheck(nCoders, {fill}): load a TIGHT shared pool `-c (planner + nCoders·coder)
   // --kv-unified -np (1+nCoders)`. The KV is PREALLOCATED at load, and critically amdgpu does
   // NOT OOM when it overflows VRAM — it SPILLS the excess into GTT (system RAM). So the "fits in
   // VRAM" signal is the TOTAL footprint (VRAM + GTT) ≤ card, since a fitting model still parks
   // ~1 GB on GTT. A config over that runs partly PCIe-bound on system RAM (still loads/coheres),
   // so without this check the search would over-count coders that don't truly fit.
   const loadAndCheck = async (nCoders, { fill }) => {
      const nSlots = 1 + nCoders;
      const T = plannerCtx + nCoders * coderCtx;
      const sizes = [plannerCtx, ...Array.from({ length: nCoders }, () => coderCtx)];
      const shaped = (extra) => ({
         total_ctx: T,
         planner_ctx: plannerCtx,
         coder_ctx: coderCtx,
         n_coders: nCoders,
         n_slots: nSlots,
         ...extra,
      });

      await srv.killAll();
      await srv.waitVramClear(30_000);
      try {
         await srv.startServer({ hf_repo: model.hf_repo, hf_file: model.hf_file, ctx: T, extraFlags: probeExtraFlags(model, nSlots) });
         await srv.waitHealthy(360_000);
      } catch {
         const crashed = await srv.hasCrashed();
         console.log(
            `  [agent_ctx] ${nCoders} coders (pool ${(T / 1024).toFixed(0)}k, np=${nSlots}) — load failed (${crashed ? 'OOM/crash' : 'timeout'})`,
         );
         return shaped({ servable: false, vram_mib: null, gtt_mib: null, coherent_slots: 0 });
      }

      const mem = await srv.snapshotMem(); // idle: weights + preallocated KV(T) — clean & monotonic
      const total = mem.vram != null && mem.gtt != null ? mem.vram + mem.gtt : null;
      // amdgpu parks a fixed ~1 GB on GTT even for a model that fits, so the gate is the TOTAL
      // footprint (VRAM + GTT) fitting the card's VRAM — NOT gtt≈0. total > card ⇒ the config
      // genuinely exceeds VRAM and the overflow runs PCIe-bound on system RAM. VRAM+GTT is clean
      // and monotonic in the pool size (measured), so this boundary is deterministic.
      const fits = total != null && total <= CARD_TOTAL_MIB;
      let coherent = 0;
      if (fill && fits) {
         const results = await runSlots(client, sizes, { think, thinkControl });
         coherent = results.filter((r) => r.ok).length;
      }
      console.log(
         `  [agent_ctx] 1 planner@${plannerCtx / 1024}k + ${nCoders} coders@${coderCtx / 1024}k (pool ${(T / 1024).toFixed(0)}k)${fill ? `  → ${coherent}/${nSlots} coherent` : ''}  vram+gtt=${total ?? '?'}MiB (v=${mem.vram ?? '?'} g=${mem.gtt ?? '?'})  ${fits ? 'FITS' : 'SPILL→RAM'}`,
      );
      return shaped({ servable: fits, vram_mib: mem.vram, gtt_mib: mem.gtt, coherent_slots: coherent });
   };

   // ── Phase 2: bidirectional boundary search over the coder COUNT (load-only footprint gate) ──
   // Descend from the estimate until a plan FITS (VRAM+GTT ≤ card), then ascend (+1 coder) while
   // it still fits. Load-only (no fill) suffices because the KV is preallocated at load, so the
   // idle footprint is the deterministic gate — each rung is just a fast load.
   let best = null;
   let loads = 0;
   let k = nCodersEst;
   while (k >= 0 && loads < MAX_LOADS) {
      const r = await loadAndCheck(k, { fill: false });
      loads++;
      if (r.servable) {
         best = r;
         break;
      }
      k -= 1; // footprint exceeds VRAM → drop one coder
   }
   while (best && loads < MAX_LOADS) {
      const r = await loadAndCheck(best.n_coders + 1, { fill: false });
      loads++;
      if (!r.servable) {
         break; // one more coder exceeds VRAM → the last fitting plan is the answer
      }
      best = r;
   }

   // ── Phase 3: verify the winning plan WITH a concurrent fill (coherence) ────────────────────
   // The capacity gate is the idle footprint above; this fill just records how many slots
   // actually retrieve their own needle at depth (coherent_slots).
   if (best) {
      const v = await loadAndCheck(best.n_coders, { fill: true });
      loads++;
      if (v.servable) {
         best = v;
      }
   }

   await srv.stopServer().catch(() => {});
   await srv.waitVramClear(20_000).catch(() => {});

   if (!best || !best.servable) {
      return fail(`no VRAM-resident plan ≥ planner ${plannerCtx / 1024}k (spills to system RAM)`);
   }
   const fullyCoherent = best.coherent_slots === best.n_slots;
   console.log(
      `  [agent_ctx] RESULT: 1×${best.planner_ctx / 1024}k planner + ${best.n_coders}×${best.coder_ctx / 1024}k coders  (pool ${(best.total_ctx / 1024).toFixed(0)}k, ${best.coherent_slots}/${best.n_slots} coherent, vram ${best.vram_mib ?? '?'}MiB)`,
   );
   return [
      {
         bench: 'agent_ctx',
         score: best.n_coders, // headline: coder agents supported alongside the planner
         n_slots: best.n_slots,
         n_coders: best.n_coders,
         coherent_slots: best.coherent_slots,
         total_ctx: best.total_ctx,
         planner_ctx: best.planner_ctx,
         coder_ctx: best.coder_ctx,
         vram_mib: best.vram_mib,
         gtt_mib: best.gtt_mib,
         verified: fullyCoherent ? 1 : 0,
         status: 'ok',
         notes: `1x${best.planner_ctx / 1024}k+${best.n_coders}x${best.coder_ctx / 1024}k kvunified ${kvQuant} ${best.coherent_slots}/${best.n_slots}coh`,
      },
   ];
}

export const bench = {
   name: 'agent_ctx',
   kind: 'probe',
   thinkDependent: false,
   selfManagesServer: true,
   run: runLlamacpp,
};
