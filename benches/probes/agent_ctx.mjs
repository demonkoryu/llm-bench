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

import { extraFlagsToString, LOAD_TIMEOUT_MS } from '../../runners/llamacpp-server.mjs';
import { makeFillPrompt } from '../../shared/codebase.mjs';
import { runMlx } from './agent_ctx_mlx.mjs';

// Agent profile (mirrors the fleet dials in analysis/scoring-config.mjs: worker_ctx=65536,
// ctx_tier=100000). Both are capped per-config at the model's coherent window.
const PLANNER_TARGET = 131072;
const CODER_TARGET = 65536;

// No card-size literal here: the usable VRAM total is a per-HOST fact that rots the moment the
// probe runs on a different GPU (it was hardcoded to the RX 7900 XT's 20464 MiB, which silently
// rejected every rung on a 65536 MiB 2xV100 host). It is threaded in from config/hosts.yaml
// (`vram_total_mib` -> host.vramTotalMib -> probe ctx.vramTotalMib) by runners/bench-run.mjs.
// Reserve for the STARTING estimate only (the empirical GTT-spill gate is the real limit). Leaves
// a little room for the prefill compute buffer so the search starts near the true answer; being
// off just costs a few extra (fast, load-only) search rungs.
const EST_COMPUTE_RESERVE_MIB = 1024;
const MAX_LOADS = 9; // bound the total reloads across the down-then-up boundary search

// Phase-3 coherence fill budget, in TOTAL concurrent prompt tokens. The fill prefills every slot
// at once, so its wall time scales with the whole pool — on a big-VRAM host the fitting plan can be
// a multi-million-token pool, whose fill would exceed fillTimeoutMs()'s 45-minute cap and report a
// spurious 0/N incoherent. Capacity (the load-only footprint gate) is the measurement that feeds
// scoring; coherent_slots/verified are advisory, so above this budget the fill is skipped and left
// unrecorded rather than measured wrong. 540k ≈ the 45-minute cap at the same pessimistic
// ~200 tok/s shared-prefill rate fillTimeoutMs() assumes.
const MAX_FILL_TOKENS = 540_672; // 528k, 4k-aligned

// NInfer's `--max-concurrency` is a startup-fixed 1..8 (docs/serving.md: "one resident Engine with
// a startup-fixed capacity of 1..8 active generation requests"). So on that engine the fleet is
// hard-capped at 8 lanes = 1 planner + 7 coders NO MATTER how much KV pool fits — a ceiling the
// llama.cpp path does not have, and the reason a ninfer row can read "7 coders" while the pool
// would hold more.
const NINFER_MAX_LANES = 8;

// Lane widths the ninfer fleet sweep evaluates, one row (case_id `lane_<W>`) each. 64k is the
// working-agent width the fleet dials assume (scoring-config worker_ctx); 128k asks the separate
// question of whether a smaller fleet of DEEP agents is servable on the same card. Two deployments,
// not two guesses at one number, so both are reported rather than one being picked.
const NINFER_LANE_WIDTHS = [65536, 131072];

// KV-cache element size relative to q8_0 (the reference kv_bytes_per_token in models.yaml),
// from GGML type sizes (bytes/32 elems): q8_0=34, q5_0=22, q5_1=24, q4_0=18, q4_1=20, f16=64.
const KV_QUANT_RATIO = { q8_0: 1.0, q5_0: 0.647, q5_1: 0.706, q4_0: 0.529, q4_1: 0.588, f16: 1.882 };

// Flags to strip when self-managing the server. `parallel` is set by us (the whole point of the
// probe is to sweep it), so it can never come from the model config.
//
// MTP/speculative flags are NOT stripped. The previous comment here claimed they were "unsupported
// with -np > 1 (embedded-tensor MTP crashes on multi-slot)" and that MTP "does NOT change the KV
// footprint we're measuring". Both were tested against build 0.2.0-dev (f280b2698) on 2026-08-25
// and both are false for it:
//   - `--parallel 4 --spec-type draft-mtp` starts (n_slots = 4 with the MTP draft context live) and
//     all four slots speculate concurrently (draft acceptance 0.54-0.64, mean len ~2.9).
//   - The draft context costs ~4794 MiB at a 65536-token unified pool (31452 vs 26658 MiB) — i.e.
//     MTP materially reduces multi-agent capacity.
// Stripping it therefore reported a pool/VRAM the production config can never actually reach, while
// kv_per_tok (which keeps MTP) reported an MTP-inclusive KiB/tok — one dashboard row, two machines.
const STRIP_FLAGS = new Set(['parallel']);

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

// llama.cpp implementation — reloads llama-server across a shared-KV-pool sweep and
// gates on nvidia-smi VRAM usage. Selected for llama.cpp hosts (engine unset/llamacpp).
async function runLlamacpp({ srv, client, model, caps, vramTotalMib }) {
   const cardTotalMib = vramTotalMib ?? null;
   if (cardTotalMib == null) {
      return [
         {
            bench: 'agent_ctx',
            status: 'skip',
            notes: 'no vram_total_mib for this host — cannot gate the shared-pool footprint',
         },
      ];
   }
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
      await srv.waitHealthy(LOAD_TIMEOUT_MS);
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
   const kvBudgetMib = cardTotalMib - EST_COMPUTE_RESERVE_MIB - (weightsMib ?? cardTotalMib);
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
         await srv.waitHealthy(LOAD_TIMEOUT_MS);
      } catch {
         const crashed = await srv.hasCrashed();
         console.log(
            `  [agent_ctx] ${nCoders} coders (pool ${(T / 1024).toFixed(0)}k, np=${nSlots}) — load failed (${crashed ? 'OOM/crash' : 'timeout'})`,
         );
         return shaped({ servable: false, vram_mib: null, gtt_mib: null, coherent_slots: 0 });
      }

      const mem = await srv.snapshotMem(); // idle: weights + preallocated KV(T) — clean & monotonic
      const total = mem.vram != null && mem.gtt != null ? mem.vram + mem.gtt : null;
      // On NVIDIA there is no GTT spill (meminfo.sh reports gtt=0), so this reduces to vram ≤ card
      // and the gate is simply "does the preallocated pool fit the board".
      // amdgpu parks a fixed ~1 GB on GTT even for a model that fits, so the gate is the TOTAL
      // footprint (VRAM + GTT) fitting the card's VRAM — NOT gtt≈0. total > card ⇒ the config
      // genuinely exceeds VRAM and the overflow runs PCIe-bound on system RAM. VRAM+GTT is clean
      // and monotonic in the pool size (measured), so this boundary is deterministic.
      const fits = total != null && total <= cardTotalMib;
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
   const fillSkipped = best != null && best.total_ctx > MAX_FILL_TOKENS;
   if (best && !fillSkipped) {
      const v = await loadAndCheck(best.n_coders, { fill: true });
      loads++;
      if (v.servable) {
         best = v;
      }
   } else if (fillSkipped) {
      console.log(
         `  [agent_ctx] coherence fill SKIPPED — pool ${(best.total_ctx / 1024).toFixed(0)}k > ${(MAX_FILL_TOKENS / 1024).toFixed(0)}k budget (would exceed the fill timeout); capacity stands, coherent_slots not measured`,
      );
   }

   await srv.stopServer().catch(() => {});
   await srv.waitVramClear(20_000).catch(() => {});

   if (!best || !best.servable) {
      return fail(`no VRAM-resident plan ≥ planner ${plannerCtx / 1024}k (spills to system RAM)`);
   }
   // coherent_slots is 0 both when the fill genuinely failed and when it never ran — so when it was
   // skipped, emit NO coherence leaf at all (numOrNull drops nulls) instead of a 0 that reads as
   // "measured, incoherent".
   const fullyCoherent = !fillSkipped && best.coherent_slots === best.n_slots;
   console.log(
      `  [agent_ctx] RESULT: 1×${best.planner_ctx / 1024}k planner + ${best.n_coders}×${best.coder_ctx / 1024}k coders  (pool ${(best.total_ctx / 1024).toFixed(0)}k, ${best.coherent_slots}/${best.n_slots} coherent, vram ${best.vram_mib ?? '?'}MiB)`,
   );
   return [
      {
         bench: 'agent_ctx',
         score: best.n_coders, // headline: coder agents supported alongside the planner
         n_slots: best.n_slots,
         n_coders: best.n_coders,
         coherent_slots: fillSkipped ? null : best.coherent_slots,
         total_ctx: best.total_ctx,
         planner_ctx: best.planner_ctx,
         coder_ctx: best.coder_ctx,
         vram_mib: best.vram_mib,
         gtt_mib: best.gtt_mib,
         verified: fillSkipped ? null : fullyCoherent ? 1 : 0,
         status: 'ok',
         notes: `1x${best.planner_ctx / 1024}k+${best.n_coders}x${best.coder_ctx / 1024}k kvunified ${kvQuant} ${fillSkipped ? 'fill-skipped (pool over budget)' : `${best.coherent_slots}/${best.n_slots}coh`}`,
      },
   ];
}

// NInfer implementation — a UNIFORM agent fleet at each lane width, one row (case_id) per width:
// how many W-token agents does this card serve at once. Reloads ninfer-serve per rung and gates on
// the pool capacity the ENGINE ITSELF REPORTS rather than on a VRAM reading.
//
// Uniform is not a simplification of the llama.cpp shape above, it is the only shape this engine
// has. That path's 1 big planner + N smaller coders works because `--kv-unified` lets each sequence
// grow to its own window inside one shared pool. NInfer has no per-lane window: `--max-context` is
// a single per-sequence ceiling applied to every lane, so a wide planner beside narrow coders is
// not a configuration it can be given. What it can be asked is "how many lanes of width W".
//
// Why the llama.cpp gate cannot be reused. That path searches for the largest `-c T` whose
// preallocated KV still fits the card, reading the boundary off nvidia-smi. On NInfer the
// equivalent pool is sized by `--kv-capacity auto`, which by definition "chooses the largest legal
// capacity that fits the memory remaining after weights are loaded while keeping 1 GiB of sizing
// headroom" — so the idle footprint is ~constant across every lane count and carries no boundary
// to find. Worse, a fill cannot substitute: admission "reserves the full prompt-plus-effective-
// output page entitlement" and an unsatisfiable request "waits in FIFO order", so an
// over-subscribed fleet does not fail, it silently SERIALIZES — which would look like success.
//
// What is measurable is the resolved pool: ninfer-serve reports `resolved=N tokens` at startup, and
// admission is entitlement-based, so n lanes genuinely coexist iff the pool covers n whole lanes.
// That is the gate. The concurrent fill still runs, but as verification of coherence (each lane
// retrieves its OWN needle), not as the capacity test.
async function runNinfer({ srv, client, model, caps }) {
   const think = model.think === 'optional' ? false : null;
   const thinkControl = model.think_control ?? 'enable_thinking';

   // Bounded by the ARCHITECTURAL window, not the coherence ceiling: a lane width is a serving
   // choice, and whether 128k lanes fit is a fair question even on a model whose measured coherence
   // tops out lower. Where a width exceeds that ceiling the row says so, and the coherence fill is
   // what settles whether the tokens are usable as well as resident.
   const archMax = model.native_max_ctx ?? PLANNER_TARGET;
   const coherentWindow = caps?.coherence_ceiling ?? model.ctx_cap ?? archMax;

   const rows = [];
   for (const laneCtx of NINFER_LANE_WIDTHS.filter((w) => w <= archMax).map(round4k)) {
      rows.push(await sweepNinferFleet({ srv, client, model, think, thinkControl, laneCtx, coherentWindow }));
   }
   return rows;
}

// One lane width: the widest fleet of `laneCtx`-token lanes the engine admits, verified by a
// concurrent fill. Returns a single agent_ctx row.
async function sweepNinferFleet({ srv, client, model, think, thinkControl, laneCtx, coherentWindow }) {
   const label = `${laneCtx / 1024}k`;
   // Admission reserves prompt PLUS the request's effective output limit. Those output pages come
   // OUT OF the lane's window, not on top of it: `--max-context` is the per-sequence ceiling, so a
   // request at depth laneCtx asking for 256 more tokens is refused on the ceiling alone, pool or
   // no pool. Which is also why the entitlement must NOT add the output on top — `--kv-capacity
   // auto` is itself capped at lanes x --max-context, so n*(laneCtx + 256) would exceed the largest
   // pool the engine can ever resolve and would reject EVERY rung, reporting 0 lanes on a healthy
   // card. So: a lane is laneCtx tokens in total, and the fill prompts leave room to answer.
   const OUT_ENTITLEMENT = 256; // must match runSlots' max_tokens
   const entitlement = (nSlots) => nSlots * laneCtx;
   const beyondCoherent = laneCtx > coherentWindow;

   const row = (extra) => ({
      bench: 'agent_ctx',
      case_id: `lane_${label}`,
      lane_ctx: laneCtx,
      // Equal by construction on this engine — a flat fleet, not a planner/coder split. Kept under
      // the existing names so the dashboard's fleet columns still populate.
      planner_ctx: laneCtx,
      coder_ctx: laneCtx,
      ...extra,
   });

   // Strip the harness's llama.cpp-only extra_flags: on this engine they are not merely ignored,
   // ninfer-serve rejects unknown flags at startup. A ninfer model entry carries ninfer flags, so
   // the only thing to add here is the lane count and the per-sequence ceiling, both of ours.
   let resident = null; // lane count currently serving, so phase 2 knows whether it must reload
   const launch = async (nSlots) => {
      const ef = extraFlagsToString(model.extra_flags);
      // `--max-concurrency` is ours to sweep, so it can never come from the model config; likewise
      // `--kv-capacity`, since auto-sizing IS the measurement.
      const cleaned = ef
         .replace(/--max-concurrency\s+\S+/g, '')
         .replace(/--kv-capacity\s+\S+/g, '')
         .replace(/\s+/g, ' ')
         .trim();
      await srv.killAll();
      await srv.waitVramClear(60_000);
      // `--pending-timeout-ms` defaults to 30 s and covers the "preparation-plus-admission wait".
      // That is far below what a fleet of deep prompts needs: prefill is serialized, so the last
      // lane of a 7 x 64k fill waits behind ~450k tokens of it and the engine 503s the request with
      // `request_queue_timeout`. Left at the default, the coherence fill measures that timeout
      // instead of coherence (observed: 1/7 lanes, six 503s, on a fleet whose pool fit exactly).
      // Scale it with the aggregate load on the same pessimistic ~200 tok/s basis fillTimeoutMs()
      // uses. A value in the model config wins — it would be a deliberate statement about the
      // deployment's tolerance, which is not ours to overwrite.
      const pending = /--pending-timeout-ms/.test(cleaned) ? '' : `--pending-timeout-ms ${fillTimeoutMs(nSlots * laneCtx)}`;
      await srv.startServer({
         hf_file: model.hf_file,
         ctx: laneCtx,
         extraFlags: `--max-concurrency ${nSlots} --kv-capacity auto ${pending} ${cleaned}`.replace(/\s+/g, ' ').trim(),
      });
      await srv.waitHealthy(LOAD_TIMEOUT_MS);
      resident = nSlots;
   };

   // One load per rung: configure nSlots lanes, read the pool the engine resolved, compare against
   // the fleet's entitlement. Capacity only — the coherence fill runs once, on the winner, so no
   // rung pays for a fill it is about to be rejected for.
   const loadAndCheck = async (nSlots) => {
      try {
         await launch(nSlots);
      } catch (e) {
         resident = null;
         const crashed = await srv.hasCrashed();
         console.log(
            `  [agent_ctx] ${label}: ${nSlots} lanes — load failed (${crashed ? 'crash' : 'timeout'}): ${(e.message ?? '').slice(0, 60)}`,
         );
         return { n_slots: nSlots, servable: false, capacity: null, vram_mib: null, gtt_mib: null };
      }
      const capacity = await srv.kvCapacity();
      const mem = await srv.snapshotMem();
      // capacity === null means the startup line scrolled out of the log window — genuinely unknown,
      // so refuse the rung rather than reading it as a zero-token pool (which would fail every rung
      // and report "0 lanes" from a logging accident).
      const fits = capacity != null && capacity >= entitlement(nSlots);
      console.log(
         `  [agent_ctx] ${label}: ${nSlots} lanes → pool ${capacity ?? '?'} tok vs entitlement ${entitlement(nSlots)}  vram=${mem.vram ?? '?'}MiB  ${fits ? 'FITS' : 'OVER'}`,
      );
      return { n_slots: nSlots, servable: fits, capacity, vram_mib: mem.vram, gtt_mib: mem.gtt };
   };

   // ── Phase 1: binary search for the widest fleet the pool covers ──────────────────────────────
   // The predicate is monotone: a rung that fails rules out every wider rung, because more lanes
   // means a bigger entitlement AND a smaller pool (each lane's runtime reservation comes out of
   // the same memory `--kv-capacity auto` sizes from). So the boundary is found in ceil(log2(8)) = 3
   // loads instead of up to 8, and a load is a multi-GB artifact load — worth the halving.
   //
   // What is NOT used is the reported capacity as a starting estimate. It is read with nSlots lanes
   // already configured, so floor(capacity / laneCtx) is a LOWER bound on what fits at fewer lanes
   // and can name a rung below the true answer (measured: 438528 at 8x128k implies 3, but 4 fit).
   // Monotonicity is the only thing the search leans on.
   let best = null;
   for (let lo = 1, hi = NINFER_MAX_LANES; lo <= hi; ) {
      const mid = Math.floor((lo + hi) / 2);
      const r = await loadAndCheck(mid);
      if (r.servable) {
         best = r;
         lo = mid + 1;
      } else {
         hi = mid - 1;
      }
   }
   if (!best) {
      await srv.stopServer().catch(() => {});
      return row({
         score: 0,
         n_slots: 0,
         total_ctx: 0,
         verified: 0,
         status: 'skip',
         notes: `not even one ${label} lane serves (needs ${laneCtx} tok)`,
      });
   }

   // ── Phase 2: verify the winning fleet with a concurrent fill ─────────────────────────────────
   // Unlike a descent, a binary search does not necessarily end on the winner — the last probe is
   // usually a rung that did NOT fit. Filling that would be worse than filling nothing: an
   // over-subscribed engine queues rather than refuses, so the fill would stall out and report the
   // winner as incoherent. Reload the winner when the search moved past it.
   const totalCtx = best.n_slots * laneCtx;
   let fillSkipped = totalCtx > MAX_FILL_TOKENS;
   if (!fillSkipped && resident !== best.n_slots) {
      try {
         await launch(best.n_slots);
      } catch (e) {
         // It loaded once already, so a failure here is a flake, not a verdict on the capacity
         // result — which stands on its own. Skip the fill rather than voiding the row.
         fillSkipped = true;
         console.log(
            `  [agent_ctx] ${label}: could not reload the winning ${best.n_slots}-lane fleet (${(e.message ?? '').slice(0, 60)}) — capacity stands, coherence not measured`,
         );
      }
   }
   let coherent = 0;
   if (fillSkipped) {
      console.log(
         `  [agent_ctx] ${label}: coherence fill SKIPPED — fleet ${(totalCtx / 1024).toFixed(0)}k > ${(MAX_FILL_TOKENS / 1024).toFixed(0)}k budget; capacity stands, coherent_slots not measured`,
      );
   } else {
      // Depth is the lane window MINUS the answer budget — see OUT_ENTITLEMENT above. Filling to
      // the full window would be refused on --max-context and misread as an incoherence failure.
      const results = await runSlots(
         client,
         Array.from({ length: best.n_slots }, () => laneCtx - OUT_ENTITLEMENT),
         { think, thinkControl },
      );
      coherent = results.filter((r) => r.ok).length;
      const failed = results.filter((r) => !r.ok);
      console.log(
         `  [agent_ctx] ${label}: coherence fill ${coherent}/${best.n_slots} lanes retrieved their own needle${failed.length ? ` — first failure: ${failed[0].err ?? `wanted ${failed[0].expected}, got "${failed[0].got}"`}` : ''}`,
      );
   }

   await srv.stopServer().catch(() => {});
   await srv.waitVramClear(30_000).catch(() => {});

   const laneCapped = best.n_slots === NINFER_MAX_LANES;
   console.log(
      `  [agent_ctx] ${label} RESULT: ${best.n_slots} x ${label} lanes (pool ${best.capacity} tok, ${coherent}/${best.n_slots} coherent, vram ${best.vram_mib ?? '?'}MiB)${laneCapped ? ' — AT THE 8-LANE ENGINE CAP' : ''}`,
   );
   return row({
      // score stays "agents beside the first" so a ninfer row reads on the same axis as the
      // llama.cpp fleet rows, even though every lane here is the same width.
      score: best.n_slots - 1,
      n_slots: best.n_slots,
      n_coders: best.n_slots - 1,
      coherent_slots: fillSkipped ? null : coherent,
      total_ctx: totalCtx,
      vram_mib: best.vram_mib,
      gtt_mib: best.gtt_mib,
      verified: fillSkipped ? null : coherent === best.n_slots ? 1 : 0,
      status: 'ok',
      // laneCapped is the difference between "this is what the GPU holds" and "this is what the
      // engine admits"; without it a reader would take 8 for a memory result.
      notes: `${best.n_slots}x${label} pool=${best.capacity}tok kv=${model.extra_flags?.['kv-dtype'] ?? 'int8'} ${
         laneCapped ? 'AT 8-lane engine cap (--max-concurrency 1..8): pool may hold more' : 'pool-bound'
      } ${fillSkipped ? 'fill-skipped' : `${coherent}/${best.n_slots}coh`}${beyondCoherent ? ` lane>coherence_ceiling(${coherentWindow})` : ''}`,
   });
}

// Single registry entry, dispatched by host engine: an MLX host (engine: optiq) gets the client-driven
// probe (agent_ctx_mlx.mjs), every other host keeps the exact llama.cpp behavior. Same `agent_ctx`
// name + row shape, so scoring/dashboard are unchanged. selfManagesServer stays true: the MLX path
// needs no lifecycle (it just selects the served model + GET /v1/models at its start).
const MLX_ENGINES = new Set(['optiq', 'rapidmlx']); // rapidmlx archived, kept here so old rows still route
export const bench = {
   name: 'agent_ctx',
   kind: 'probe',
   thinkDependent: false,
   selfManagesServer: true,
   run(ctx) {
      if (MLX_ENGINES.has(ctx.model.engine)) {
         return runMlx(ctx);
      }
      if (ctx.model.engine === 'ninfer') {
         return runNinfer(ctx);
      }
      return runLlamacpp(ctx);
   },
};
