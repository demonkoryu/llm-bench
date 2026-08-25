/**
 * NInfer server manager — the third engine, alongside llamacpp-server.mjs and optiq-server.mjs.
 *
 * NInfer (https://github.com/geoffwatts/ninfer-v100) is a from-scratch C++/CUDA inference engine
 * for a closed set of Qwen checkpoints. This is the Tesla V100 / sm_70 port; it serves one
 * pre-converted `.ninfer` artifact over OpenAI Chat Completions, OpenAI Responses, and Anthropic
 * Messages endpoints. The harness talks to it through the OpenAI Chat Completions surface only.
 *
 * Lifecycle sits between the other two engines: unlike OptiQ (a persistent daemon the harness must
 * not touch) NInfer IS launched and stopped per model, like llama.cpp — but unlike llama.cpp it is
 * a deliberately single-GPU engine (`--device N`, and upstream states the Volta build is
 * specialized for one V100 and one CUDA device). So `rose` runs TWO independent instances, one per
 * card, each its own hosts.yaml target with its own port, container and device index. Every
 * host-level operation here is therefore device-scoped; see scripts/llm2/ninfer/ for why that
 * matters (a host-wide VRAM sum would cross-attribute the peer instance's weights).
 *
 * Three engine-specific contracts the shared orchestration code cannot know about:
 *
 *  1. Strict model ids. "The request `model` must equal the public model ID" — the artifact's
 *     `identity.model_id`, or an explicit `--model-id`. A wrong id is a hard error, not a
 *     tolerated label as under OptiQ's single-model mode. startServer() therefore reads the id
 *     back from GET /v1/models and uses whatever the server actually advertises.
 *
 *  2. Frozen startup capabilities. Vision, the speculative backend, and the proposal head are all
 *     resident-memory decisions made at launch: "A later request cannot enable a capability
 *     omitted at startup." A text-only engine REJECTS media (HTTP 400 vision_disabled) rather than
 *     degrading, so `--vision` has to come from the model entry's extra_flags, not a request field.
 *
 *  3. No analytic fit tool. `probeFitCtx` is llama.cpp's `llama-fit-params`; NInfer's equivalent is
 *     `--kv-capacity auto`, which sizes the pool at load time and never reports a ceiling. So
 *     fit_ctx returns null here (the probe guards on it) and the real context ceiling comes from
 *     agent_ctx, which measures it.
 */

import { LOCAL_HOST, runHostCmd } from '../shared/host-exec.mjs';
import { createClient } from '../shared/llm/index.mjs';

const SCRIPTS_DIR = '~/llm-bench/scripts/llm2/ninfer';

// Deep-context prefill on a V100 is slow, and agent_ctx budgets up to 60 min for one fill request.
// The SDK's own per-request timeout races the probe's AbortSignal, so a lower ceiling here would
// silently cap every deep rung and under-report the context ceiling. Match the probe's cap and let
// its per-request signal be the only binding constraint (same reasoning as optiq-server.mjs).
const NINFER_TIMEOUT_MS = 3_600_000;

// NInfer accepts a nonnegative `seed`; pinning it makes generation reproducible across samples,
// which is what a benchmark wants. Unlike OptiQ's seed this is not load-bearing for correctness —
// it does not select a code path — so it is purely a determinism knob.
const NINFER_SEED = Number.parseInt(process.env.NINFER_SEED ?? '0', 10);

/**
 * Create a NInfer server manager bound to one GPU.
 *
 * @param {object} opts
 *   sshHost      {string}  SSH alias for the GPU host
 *   inferenceUrl {string}  base URL of this instance (e.g. http://192.168.1.120:8100)
 *   device       {number}  host CUDA device index this instance owns
 *   artifactDir  {string}  directory of .ninfer artifacts ON the host
 *   image        {string}  docker image tag
 *   debug        {boolean} verbose logging
 *   local        {boolean} run host scripts locally instead of over SSH
 *   timeoutMs    {number}  SDK request-timeout ceiling
 */
export function ninferServer({
   sshHost,
   inferenceUrl = 'http://127.0.0.1:8100',
   device = 0,
   artifactDir = null,
   image = null,
   debug = false,
   local = LOCAL_HOST,
   timeoutMs = NINFER_TIMEOUT_MS,
}) {
   let currentModel = null; // public model id echoed back by GET /v1/models
   let lastLaunch = null; // remembered launch args, for ensureAlive()'s single restart
   const client = createClient(inferenceUrl, { debug, model: () => currentModel, timeout: timeoutMs, seed: NINFER_SEED });

   /** Run one of the ninfer host scripts. Every call is device-scoped. */
   async function runScript(script, args = '', { tolerant = false, timeout = 30_000 } = {}) {
      const cmd = `bash ${SCRIPTS_DIR}/${script} --device ${device} ${args}`;
      if (debug) {
         console.error(`[${local ? 'local' : 'ssh'}] ${cmd}`);
      }
      const r = await runHostCmd(cmd, { local, sshHost, timeout });
      if (!r.ok && !tolerant) {
         throw new Error(`${script} failed: ${r.stderr.slice(0, 300)}`);
      }
      return r.stdout;
   }

   /** GET /v1/models → advertised ids ([] on any failure). */
   async function listModels() {
      try {
         const res = await globalThis.fetch(`${inferenceUrl}/v1/models`, { signal: AbortSignal.timeout(10_000) });
         if (!res.ok) {
            return [];
         }
         return ((await res.json())?.data ?? []).map((m) => m.id).filter(Boolean);
      } catch {
         return [];
      }
   }

   /**
    * Launch ninfer-serve for one artifact on this instance's GPU, then resolve the public model id.
    *
    * `hf_file` carries the artifact filename (e.g. qwen3_8_27b_nvfp4.ninfer) — the same field
    * llama.cpp uses for a GGUF name — and the host script resolves it inside artifactDir. Nothing
    * is downloaded here: NInfer artifacts are staged on the host out of band, because they are
    * single 20 GiB blobs with no llama.cpp-style HF auto-fetch.
    *
    * @param {object} o
    *   hf_file    {string} .ninfer artifact filename on the host
    *   ctx        {number} --max-context
    *   extraFlags {string} additional ninfer-serve flags (vision, spec backend, concurrency…)
    * @returns {string} container id
    */
   async function startServer({ hf_file, ctx, extraFlags = '' }) {
      if (!hf_file) {
         throw new Error('ninfer: no artifact (set hf_file to a .ninfer filename in models.yaml)');
      }
      // Single-quoting is what keeps a filename with shell metacharacters from being reinterpreted
      // on the far side of ssh — but it also defeats `~` expansion, which hosts.yaml uses for
      // artifact_dir. So rewrite a leading `~/` to `$HOME/` and quote with DOUBLE quotes for that
      // one value: $HOME expands, everything else stays literal.
      const hostPath = (p) => `"${String(p).replace(/^~(?=\/|$)/, '$HOME')}"`;
      const args = [
         `--artifact '${hf_file}'`,
         `--ctx ${ctx}`,
         `--port ${new URL(inferenceUrl).port || 8100}`,
         artifactDir ? `--models-dir ${hostPath(artifactDir)}` : '',
         image ? `--image '${image}'` : '',
         extraFlags,
      ]
         .filter(Boolean)
         .join(' ');

      // Loading a 20 GiB artifact and sizing the KV pool takes minutes, not seconds.
      const cid = await runScript('start-server.sh', args, { timeout: 900_000 });
      lastLaunch = { hf_file, ctx, extraFlags };
      console.log(`[ninfer] gpu${device}: started ${String(cid).trim().slice(0, 12)} ctx=${ctx} ${hf_file}`);
      return String(cid).trim();
   }

   /**
    * Wait for /health, then resolve the public model id from GET /v1/models.
    *
    * The id resolution lives here rather than in startServer because the server does not advertise
    * anything until the artifact is resident — and it is the id, not merely a healthy process, that
    * subsequent requests depend on: NInfer requires an exact `model` match and 404s otherwise.
    * Unlike OptiQ there is no single-model tolerance to fall back on, so an empty list is fatal.
    */
   async function waitHealthy(timeout = 900_000) {
      const timeoutS = Math.floor(timeout / 1000);
      const out = await runScript('health.sh', `--url ${inferenceUrl} --timeout ${timeoutS}`, {
         tolerant: true,
         timeout: timeout + 10_000,
      });
      if (!String(out).includes('ready')) {
         const log = await runScript('log-tail.sh', '--lines 30', { tolerant: true }).catch(() => '');
         throw new Error(`ninfer gpu${device}: not ready within ${timeoutS}s at ${inferenceUrl}\n${String(log).slice(-1200)}`);
      }
      const served = await listModels();
      if (!served.length) {
         throw new Error(`ninfer gpu${device}: /health is up but GET /v1/models is empty at ${inferenceUrl}`);
      }
      if (served.length > 1) {
         // One resident artifact per process, so this should be impossible; if the contract ever
         // changes, fail loudly rather than silently benchmarking whichever id happens to sort first.
         console.warn(`[ninfer] gpu${device}: expected one model id, got [${served.join(', ')}] — using the first`);
      }
      currentModel = served[0];
      console.log(`[ninfer] gpu${device}: serving model id '${currentModel}'`);
      return true;
   }

   /**
    * The shared Main Text KV pool this instance actually resolved, in tokens.
    *
    * This is the load-bearing capacity number on NInfer, and unlike llama.cpp it cannot be inferred
    * from a VRAM reading: `--kv-capacity auto` deliberately consumes all memory left after the
    * weights (minus a 1 GiB headroom), so the idle footprint is essentially constant no matter how
    * many lanes are configured. The engine instead REPORTS the resolved pool at startup:
    *
    *   ninfer-serve: KV capacity auto resolved=32768 tokens pages=512/512 runtime=4.78 GiB ...
    *
    * Returns null if the line is not in the retained log window, which callers must treat as
    * "unknown", never as zero.
    */
   async function kvCapacity() {
      const out = await runScript('log-tail.sh', '--lines 400', { tolerant: true });
      const m = String(out).match(/KV capacity\s+\S+\s+resolved=(\d+)\s+tokens/);
      return m ? Number.parseInt(m[1], 10) : null;
   }

   async function stopServer() {
      await runScript('stop-server.sh', '', { tolerant: true, timeout: 30_000 });
      currentModel = null;
   }

   async function killAll() {
      await runScript('kill-all.sh', '', { tolerant: true, timeout: 30_000 });
      currentModel = null;
   }

   /** VRAM used in MiB on THIS instance's GPU only. */
   async function snapshotVram() {
      const out = await runScript('vram.sh', '', { tolerant: true });
      const n = Number.parseInt(String(out).trim(), 10);
      return Number.isNaN(n) ? null : n;
   }

   /** { vram, gtt } for this GPU. gtt is always 0 — NVIDIA has no transparent host-RAM spill. */
   async function snapshotMem() {
      const out = await runScript('meminfo.sh', '', { tolerant: true });
      const [v, g] = String(out)
         .trim()
         .split(/\s+/)
         .map((x) => Number.parseInt(x, 10));
      return { vram: Number.isNaN(v) ? null : v, gtt: Number.isNaN(g) ? null : g };
   }

   async function hasCrashed() {
      const r = await runHostCmd(`bash ${SCRIPTS_DIR}/log-tail.sh --device ${device} --lines 30`, {
         local,
         sshHost,
         timeout: 15_000,
      });
      return r.exitCode === 2;
   }

   /** Poll this GPU's VRAM until the instance's allocations are released. */
   async function waitVramClear(timeout = 90_000) {
      const deadline = Date.now() + timeout;
      while (Date.now() < deadline) {
         const mib = await snapshotVram();
         if (mib === null || mib < 512) {
            return;
         }
         if (debug) {
            console.log(`[ninfer] gpu${device}: waiting VRAM clear — ${mib} MiB...`);
         }
         await new Promise((r) => setTimeout(r, 2_000));
      }
      console.warn(`[ninfer] gpu${device}: VRAM did not clear within timeout — proceeding anyway`);
   }

   /**
    * No analytic memory-fit tool exists for NInfer (see the header). Returning null makes fit_ctx
    * skip cleanly, exactly as it does on the OptiQ path, rather than fabricating a ceiling from
    * `--kv-capacity auto`, which reports nothing back.
    */
   async function probeFitCtx() {
      return { fitCtx: null, fitRaw: null };
   }

   /**
    * Engine version for the `engine_version` dim. NInfer exposes no version endpoint and no
    * `system_fingerprint`, so the honest source is the source commit that build.sh stamps onto the
    * image as the `ninfer.source.commit` label. Read from the IMAGE, not the container: bench-run
    * fills this in once up front, before any model has been launched, and the floating `:latest`
    * tag would otherwise leave the row unable to say which build produced it.
    * Best-effort — engine_version is nullable and must never fail a benchmark.
    */
   async function engineVersion() {
      const label = async (ref) => {
         const r = await runHostCmd(`docker inspect -f '{{index .Config.Labels "ninfer.source.commit"}}' ${ref} 2>/dev/null || true`, {
            local,
            sshHost,
            timeout: 15_000,
         });
         const v = String(r.stdout ?? '').trim();
         return v && v !== '<no value>' ? v : null;
      };
      try {
         const commit = (image ? await label(image) : null) ?? (await label(`ninfer-d${device}`));
         return commit ? `ninfer-v100 ${commit} (sm_70, CUDA 12.8)` : null;
      } catch {
         return null;
      }
   }

   /** Check liveness; restart once from the remembered launch args if the instance died. */
   async function ensureAlive() {
      const alive = await globalThis
         .fetch(`${inferenceUrl}/health`, { signal: AbortSignal.timeout(5_000) })
         .then((r) => r.ok)
         .catch(() => false);
      if (alive) {
         return { alive: true };
      }
      const crashed = await hasCrashed();
      console.warn(`  [warn] ninfer gpu${device} ${crashed ? 'crashed' : 'died'}, restarting...`);
      if (!lastLaunch) {
         return { alive: false };
      }
      try {
         await killAll();
         await waitVramClear();
         await startServer(lastLaunch);
         await waitHealthy(600_000);
         return { alive: true, restarted: true };
      } catch (e) {
         console.error(`  [error] ninfer restart failed: ${e.message}`);
         return { alive: false };
      }
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
      ensureAlive,
      listModels,
      engineVersion,
      kvCapacity,
   };
}
