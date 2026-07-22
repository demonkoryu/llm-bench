/**
 * OptiQ server manager — the HTTP-only sibling of llamacpp-server.mjs (replaces rapidmlx-server.mjs).
 *
 * OptiQ (mlx-optiq, https://mlx-optiq.com) is an OpenAI-compatible MLX inference server for Apple
 * Silicon (the M1 Mac, `llm1`). `optiq serve` wraps mlx_lm.server with OptiQ's mixed-precision /
 * fused KV-cache path. Like the RapidMLX path it replaces, the harness does NOT manage its lifecycle:
 * OptiQ runs as a persistent `optiq serve` daemon started out-of-band (scripts/llm1/serve.sh) that
 * serves one loaded model. So there is no per-model reload, no SSH launch, and no VRAM/GTT tooling —
 * Apple Silicon has unified memory (no VRAM/GTT split, no rocm-smi).
 *
 * This factory exposes the same method surface `bench-run.mjs` calls on `llamacppServer`, but the
 * lifecycle methods are no-ops and `startServer` only *selects* the served model (setting the request
 * `model` id) and verifies OptiQ is already serving — it never downloads or launches anything.
 *
 * OptiQ serves in **single-model mode** by default (`--single-model`): the request `model` field is a
 * label and every request is served the one loaded `--model`, so a missing/renamed/wrong id is served
 * the model instead of 404ing. That makes id resolution here tolerant — unlike RapidMLX, no strict
 * alias match is needed — but we still resolve to the actually-served id from GET /v1/models so the
 * echoed `model` in responses is truthful and a genuinely-unreachable daemon fails fast and clearly.
 *
 * Operational contract: the daemon must already be serving with the intended flags —
 * `--kv-bits 4` (uniform int4 KV), `--max-concurrent 1` (single client), and **`--no-auth`** (the
 * OpenAI SDK sends `Authorization: Bearer EMPTY`, which OptiQ's default auth REJECTS as a malformed
 * token — only a *missing* header is tolerated). See scripts/llm1/serve.sh and the runbook.
 */

import { createClient } from '../shared/llm/index.mjs';

/** Leaf of an HF repo id — the fallback served id when no explicit mlx_model is given. */
export function leafModelId(hf_repo = '') {
   return String(hf_repo).split('/').filter(Boolean).pop() ?? '';
}

// Deep-context prefill on the M1 (slowest fleet member, 27B-4bit) is SLOW — the agent_ctx probe
// budgets up to 60 min per request (fillTimeoutMs) so a slow-but-fine 64k–128k fill is not
// false-failed. The openai SDK applies its OWN per-request timeout (createClient default 10 min)
// that RACES the probe's AbortSignal, so a 10-min SDK ceiling would silently cap every deep rung and
// under-report the max-context ceiling (the #1-priority metric). Match the SDK ceiling to the probe's
// cap, letting the probe's per-request signal be the sole binding constraint. Fast benches unaffected.
const OPTIQ_TIMEOUT_MS = 3_600_000; // 60 min — matches agent_ctx fillTimeoutMs cap

// Every request MUST carry a `seed` so mlx_lm.server routes it to the single-stream path instead of
// its continuous-batching path. mlx_lm.server decides via `_is_batchable = model.is_batchable and
// args.seed is None` (server.py:686): this hybrid IS batchable (its ArraysCache + KVCache both define
// merge), so a seed-less request goes to BatchGenerator — which NEVER quantizes the KV cache (KV-quant
// on the batched path is unimplemented upstream, open PR ml-explore/mlx-lm#1584). That keeps KV in
// fp16 (~4× int4) and OOM-crashes the 28GB M1 at the first decode step on deep context. OptiQ's int4
// KV-quant only patches the single-stream `stream_generate`, reached via `_serve_single` only when a
// seed is present. A fixed seed also makes generation deterministic (good for a benchmark). Override
// with OPTIQ_SEED if a specific value is ever needed; batching buys nothing at --max-concurrent 1.
const OPTIQ_SEED = Number.parseInt(process.env.OPTIQ_SEED ?? '0', 10);

/**
 * Create an OptiQ server manager for one OpenAI-compatible endpoint.
 *
 * @param {object} opts
 *   inferenceUrl {string}   OptiQ base URL (e.g. http://127.0.0.1:8080)
 *   debug        {boolean}  verbose logging
 *   timeoutMs    {number}   SDK request-timeout ceiling (default 60 min)
 */
export function optiqServer({ inferenceUrl = 'http://127.0.0.1:8080', debug = false, timeoutMs = OPTIQ_TIMEOUT_MS }) {
   let currentModel = null; // the id sent in every chat request; set by startServer()
   const client = createClient(inferenceUrl, { debug, model: () => currentModel, timeout: timeoutMs, seed: OPTIQ_SEED });

   /** GET /v1/models → array of served ids ([] on any failure). */
   async function listModels() {
      try {
         const res = await globalThis.fetch(`${inferenceUrl}/v1/models`, { signal: AbortSignal.timeout(10_000) });
         if (!res.ok) {
            return [];
         }
         const body = await res.json();
         return (body?.data ?? []).map((m) => m.id).filter(Boolean);
      } catch {
         return [];
      }
   }

   /**
    * Select the served model for subsequent requests. Does NOT launch or download — OptiQ is already
    * serving from `optiq serve`. In single-model mode any request `model` is served the loaded model,
    * so this resolves leniently: a case-insensitive match to the wanted/repo/leaf id, else — when the
    * daemon advertises exactly one model — that one served id. Only a genuinely unreachable/empty
    * daemon (or an ambiguous multi-model list with no match) is an error.
    *
    * @param {object} o
    *   hf_repo  {string}  HF repo id (its leaf folder is the fallback served id)
    *   mlxModel {string}  explicit request id (overrides the leaf; from models.yaml `mlx_model`)
    */
   async function startServer({ hf_repo, mlxModel }) {
      const wanted = mlxModel ?? leafModelId(hf_repo);
      if (!wanted) {
         throw new Error('optiq: no model id (set mlx_model or hf_repo in models.yaml)');
      }
      const served = await listModels();
      if (!served.length) {
         throw new Error(`optiq: not reachable at ${inferenceUrl} (GET /v1/models empty — is 'optiq serve' up?)`);
      }
      const lc = (s) => String(s).toLowerCase();
      const wantLeaf = lc(leafModelId(wanted));
      const match = served.find((id) => lc(id) === lc(wanted) || lc(id) === lc(hf_repo) || lc(leafModelId(id)) === wantLeaf);
      // Single-model tolerance: if nothing matched but the daemon serves exactly one model, that IS the
      // model (OptiQ serves --model for any label). Only a multi-model list with no match is ambiguous.
      const resolved = match ?? (served.length === 1 ? served[0] : null);
      if (!resolved) {
         throw new Error(
            `optiq: model '${wanted}' not served at ${inferenceUrl}. Served: [${served.join(', ')}]. ` +
               `Serve it (scripts/llm1/serve.sh) or pass its id via models.yaml mlx_model.`,
         );
      }
      currentModel = resolved;
      console.log(`[optiq] serving model=${currentModel} @ ${inferenceUrl}`);
      return currentModel; // no PID — mirrors the llamacpp return contract loosely
   }

   /**
    * Wait until OptiQ is reachable AND a model is listed. `startServer` should have set the model;
    * if it hasn't (defensive), just wait for reachability.
    */
   async function waitHealthy(timeoutMs = 120_000) {
      const start = Date.now();
      const deadline = start + timeoutMs;
      let lastLog = start;
      while (Date.now() < deadline) {
         const served = await listModels();
         if (
            served.length &&
            (!currentModel || served.includes(currentModel) || served.some((id) => leafModelId(id) === leafModelId(currentModel)))
         ) {
            return true;
         }
         const now = Date.now();
         if (now - lastLog >= 10_000) {
            console.log(`[optiq] waiting for endpoint/model... ${Math.round((now - start) / 1000)}s`);
            lastLog = now;
         }
         await new Promise((r) => setTimeout(r, 2_000));
      }
      throw new Error(`optiq not ready within ${Math.round(timeoutMs / 1000)}s at ${inferenceUrl}`);
   }

   // ── Lifecycle no-ops ────────────────────────────────────────────────────────────
   // OptiQ is a persistent daemon we never stop or reload; there is no VRAM to clear.
   // These resolve immediately so shared orchestration/probe code runs unchanged.
   async function stopServer() {}
   async function killAll() {}
   async function waitVramClear() {}
   async function hasCrashed() {
      return false;
   }

   // Unified memory — no VRAM/GTT split, no rocm-smi. Return nulls so any stray VRAM-based probe
   // (kv_per_tok) short-circuits cleanly instead of crashing; the MLX agent_ctx probe is
   // coherence-gated and never calls these.
   async function snapshotVram() {
      return null;
   }
   async function snapshotMem() {
      return { vram: null, gtt: null };
   }
   // No analytic fit tool on MLX (llama-fit-params is llama.cpp-only). fit_ctx guards on this.
   async function probeFitCtx() {
      return { fitCtx: null };
   }

   return {
      client,
      startServer,
      stopServer,
      killAll,
      waitHealthy,
      waitVramClear,
      snapshotVram,
      snapshotMem,
      hasCrashed,
      probeFitCtx,
      listModels,
   };
}
