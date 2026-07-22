/**
 * RapidMLX server manager — the HTTP-only sibling of llamacpp-server.mjs.
 *
 * RapidMLX (rapidmlx.com) is an OpenAI-compatible MLX inference server for Apple Silicon
 * (the M1 Mac, `llm1`). Unlike the llama.cpp path, the harness does NOT manage its lifecycle:
 * RapidMLX runs as a persistent `rapid-mlx serve` daemon started out-of-band (scripts/llm1/serve.sh)
 * that serves one loaded model. So there is no per-model reload, no SSH launch, and no VRAM/GTT
 * tooling — Apple Silicon has unified memory (no VRAM/GTT split, no rocm-smi).
 *
 * This factory exposes the same method surface `bench-run.mjs` calls on `llamacppServer`, but the
 * lifecycle methods are no-ops and `startServer` only *selects* the served model (by setting the
 * request `model` id) and verifies RapidMLX is already serving it — it never downloads or launches
 * anything. A missing/wrong model → a clear, actionable error rather than a silent 422 later.
 *
 * Operational contract: the model must already be pulled (`rapid-mlx pull <alias>`) and the daemon
 * (re)started serving it with the intended flags (`--kv-cache-dtype int4`, `--pflash off`,
 * cloud-fallback disabled, `--max-num-seqs 1`) — see scripts/llm1/serve.sh and the runbook.
 */

import { createClient } from '../shared/llm/index.mjs';

/** Leaf of an HF repo id — the fallback served id when no explicit mlx_model is given. */
export function leafModelId(hf_repo = '') {
   return String(hf_repo).split('/').filter(Boolean).pop() ?? '';
}

/**
 * Create a RapidMLX server manager for one OpenAI-compatible endpoint.
 *
 * @param {object} opts
 *   inferenceUrl {string}   RapidMLX base URL (e.g. http://llm1:8000)
 *   debug        {boolean}  verbose logging
 *   timeoutMs    {number}   SDK request-timeout ceiling (default 60 min)
 */
// Deep-context prefill on the M1 (slowest fleet member, 27B-4bit) is SLOW — the agent_ctx probe
// budgets up to 60 min per request (fillTimeoutMs) precisely so a slow-but-fine 64k–128k fill is
// not false-failed. The openai SDK applies its OWN per-request timeout (createClient default 10 min)
// that RACES the probe's AbortSignal — whichever fires first wins — so a 10-min SDK ceiling would
// silently cap every deep rung and under-report the max-context ceiling (the #1-priority metric).
// Match the SDK ceiling to the probe's cap AND the daemon's `--timeout 3600`, letting the probe's
// per-request signal be the sole binding constraint. Normal (fast) benches are unaffected.
const RAPIDMLX_TIMEOUT_MS = 3_600_000; // 60 min — matches agent_ctx fillTimeoutMs cap + serve.sh --timeout
export function rapidmlxServer({ inferenceUrl = 'http://127.0.0.1:8000', debug = false, timeoutMs = RAPIDMLX_TIMEOUT_MS }) {
   let currentModel = null; // the id sent in every chat request; set by startServer()
   const client = createClient(inferenceUrl, { debug, model: () => currentModel, timeout: timeoutMs });

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
    * Select the served model for subsequent requests. Does NOT launch or download —
    * RapidMLX is already serving from `rapid-mlx serve`. Verifies the target id is served
    * and throws an actionable error if not.
    *
    * @param {object} o
    *   hf_repo  {string}  HF repo id (its leaf folder is RapidMLX's default served id)
    *   mlxModel {string}  explicit RapidMLX request id (overrides the leaf; from models.yaml `mlx_model`)
    */
   async function startServer({ hf_repo, mlxModel }) {
      const wanted = mlxModel ?? leafModelId(hf_repo);
      if (!wanted) {
         throw new Error('rapidmlx: no model id (set mlx_model or hf_repo in models.yaml)');
      }
      const served = await listModels();
      if (!served.length) {
         throw new Error(`rapidmlx: not reachable at ${inferenceUrl} (GET /v1/models empty — is 'rapid-mlx serve' up?)`);
      }
      // Resolve to the ACTUAL served id, case-insensitively. RapidMLX serves under
      // `--served-model-name` (typically a lowercased alias, e.g. `qwen3.6-27b-4bit`), while probes
      // that don't pass `mlxModel` fall back to the HF leaf (`Qwen3.6-27B-4bit`) — same model, only
      // differing in case. Match the alias, the org-prefixed repo id, or the leaf, ignoring case, then
      // send the CANONICAL served id in every request: a wrong-case id would 422 at completion time
      // even though the model exists. (Only the four self-managing depth probes hit this path.)
      const lc = (s) => String(s).toLowerCase();
      const wantLeaf = lc(leafModelId(wanted));
      const resolved = served.find((id) => lc(id) === lc(wanted) || lc(id) === lc(hf_repo) || lc(leafModelId(id)) === wantLeaf);
      if (!resolved) {
         throw new Error(
            `rapidmlx: model '${wanted}' not served at ${inferenceUrl}. Served: [${served.join(', ')}]. ` +
               `Pull it (rapid-mlx pull ${wanted}) and (re)start the daemon (scripts/llm1/serve.sh ${wanted}).`,
         );
      }
      currentModel = resolved;
      console.log(`[rapidmlx] serving model=${currentModel} @ ${inferenceUrl}`);
      return currentModel; // no PID — mirrors the llamacpp return contract loosely
   }

   /**
    * Wait until RapidMLX is reachable AND the selected model is listed. `startServer` must
    * have set the model; if it hasn't (defensive), just wait for reachability.
    */
   async function waitHealthy(timeoutMs = 120_000) {
      const start = Date.now();
      const deadline = start + timeoutMs;
      let lastLog = start;
      while (Date.now() < deadline) {
         const served = await listModels();
         if (served.length && (!currentModel || served.includes(currentModel) || served.some((id) => leafModelId(id) === currentModel))) {
            return true;
         }
         const now = Date.now();
         if (now - lastLog >= 10_000) {
            console.log(`[rapidmlx] waiting for endpoint/model... ${Math.round((now - start) / 1000)}s`);
            lastLog = now;
         }
         await new Promise((r) => setTimeout(r, 2_000));
      }
      throw new Error(`rapidmlx not ready within ${Math.round(timeoutMs / 1000)}s at ${inferenceUrl}`);
   }

   // ── Lifecycle no-ops ────────────────────────────────────────────────────────────
   // RapidMLX is a persistent daemon we never stop or reload; there is no VRAM to clear.
   // These resolve immediately so shared orchestration/probe code runs unchanged.
   async function stopServer() {}
   async function killAll() {}
   async function waitVramClear() {}
   async function hasCrashed() {
      return false;
   }

   // Unified memory — no VRAM/GTT split, no rocm-smi. Return nulls so any stray VRAM-based
   // probe (kv_per_tok) short-circuits cleanly instead of crashing; the MLX agent_ctx probe is
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
