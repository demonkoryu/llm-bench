/**
 * omlx (MLX) server manager — the HTTP-only sibling of llamacpp-server.mjs.
 *
 * omlx (github.com/jundot/omlx) is an OpenAI-compatible MLX inference server that runs
 * on Apple Silicon (the M1 Mac, `llm1`). Unlike the llama.cpp path, the harness does NOT
 * manage its lifecycle: omlx runs as a persistent LaunchDaemon that discovers every model
 * under `--model-dir` at startup and serves whichever id the request names. So there is no
 * per-model reload, no SSH, no VRAM/GTT tooling (unified memory — no split, no rocm-smi).
 *
 * This factory exposes the same method surface `bench-run.mjs` calls on `llamacppServer`,
 * but the lifecycle methods are no-ops and `startServer` only *selects* the served model
 * (by setting the request `model` id) and verifies omlx is already serving it — it never
 * downloads or launches anything. Missing model → a clear, actionable error.
 *
 * The one operational contract: the model must already be downloaded into omlx's model-dir
 * and omlx (re)started, and — for the fixed Qwen chat template — the froggeric
 * `chat_template.jinja` dropped into the model directory (see docs/plans + the llm1 runbook).
 */

import { createClient } from '../shared/llm/index.mjs';

/** Leaf folder name of an HF repo id — the id omlx serves by default (e.g. `Qwen3.6-27B-5bit`). */
export function leafModelId(hf_repo = '') {
   return String(hf_repo).split('/').filter(Boolean).pop() ?? '';
}

/**
 * Create an omlx server manager for one OpenAI-compatible endpoint.
 *
 * @param {object} opts
 *   inferenceUrl {string}   omlx base URL (e.g. http://127.0.0.1:8000)
 *   debug        {boolean}  verbose logging
 */
export function omlxServer({ inferenceUrl = 'http://127.0.0.1:8000', debug = false }) {
   let currentModel = null; // the id sent in every chat request; set by startServer()
   const client = createClient(inferenceUrl, { debug, model: () => currentModel });

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
    * omlx is already serving from its model-dir. Verifies the target id is served and
    * throws an actionable error if not.
    *
    * @param {object} o
    *   hf_repo  {string}  HF repo id (its leaf folder is omlx's default served id)
    *   mlxModel {string}  explicit omlx request id (overrides the leaf; from models.yaml `mlx_model`)
    */
   async function startServer({ hf_repo, mlxModel }) {
      const wanted = mlxModel ?? leafModelId(hf_repo);
      if (!wanted) {
         throw new Error('omlx: no model id (set mlx_model or hf_repo in models.yaml)');
      }
      const served = await listModels();
      if (!served.length) {
         throw new Error(`omlx: not reachable at ${inferenceUrl} (GET /v1/models empty — is the daemon up?)`);
      }
      // omlx resolves both the leaf id and the org-prefixed id; accept either.
      const ok = served.includes(wanted) || served.includes(hf_repo) || served.some((id) => leafModelId(id) === wanted);
      if (!ok) {
         throw new Error(
            `omlx: model '${wanted}' not served at ${inferenceUrl}. Served: [${served.join(', ')}]. ` +
               `Download it (hf download ${hf_repo} --local-dir ~/models/${hf_repo}) and restart omlx ` +
               `(sudo launchctl kickstart -k system/com.omlx.server).`,
         );
      }
      currentModel = wanted;
      console.log(`[omlx] serving model=${currentModel} @ ${inferenceUrl}`);
      return currentModel; // no PID — mirrors the llamacpp return contract loosely
   }

   /**
    * Wait until omlx is reachable AND the selected model is listed. `startServer` must
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
            console.log(`[omlx] waiting for endpoint/model... ${Math.round((now - start) / 1000)}s`);
            lastLog = now;
         }
         await new Promise((r) => setTimeout(r, 2_000));
      }
      throw new Error(`omlx not ready within ${Math.round(timeoutMs / 1000)}s at ${inferenceUrl}`);
   }

   // ── Lifecycle no-ops ────────────────────────────────────────────────────────────
   // omlx is a persistent daemon we never stop or reload; there is no VRAM to clear.
   // These resolve immediately so shared orchestration/probe code runs unchanged.
   async function stopServer() {}
   async function killAll() {}
   async function waitVramClear() {}
   async function hasCrashed() {
      return false;
   }

   // Unified memory — no VRAM/GTT split, no rocm-smi. Return nulls so any stray probe
   // snapshot can't crash (the MLX agent_ctx probe is coherence-gated and never calls these).
   async function snapshotVram() {
      return null;
   }
   async function snapshotMem() {
      return { vram: null, gtt: null };
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
      listModels,
   };
}
