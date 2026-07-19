/**
 * Remote llama-server lifecycle manager.
 *
 * Orchestrates the llm2 shell scripts over SSH to:
 *   - Detect available backends (vulkan | rocm)
 *   - Start / stop llama-server with a lockfile + VRAM-clear wait
 *   - Estimate the analytic memory-fit context via llama-fit-params (probeFitCtx)
 *
 * All system-level operations (process start/stop, VRAM query, health probe)
 * run as shell scripts on llm2 — Node stays on the dev host.
 *
 * Shell scripts live at: llm2:~/llm-bench/scripts/llm2/
 * Deploy path:           ~/llm-bench   (set via REMOTE_BENCH_DIR)
 */

import { LOCAL_HOST, runHostCmd } from '../shared/host-exec.mjs';
import { createClient } from '../shared/llm/index.mjs';

/**
 * Convert an extra_flags value from models.yaml to a CLI argument string.
 *
 * Accepts either:
 *   - an object map  { temp: 0.7, 'top-k': 20, 'spec-type': 'draft-mtp' }
 *     → "--temp 0.7 --top-k 20 --spec-type draft-mtp"
 *   - a plain string (legacy, pass through unchanged)
 *   - null / undefined / empty object → empty string
 *
 * Boolean values:  true  → "--flag"   false → omit
 * Numeric/string:  value → "--flag value"
 */
export function extraFlagsToString(flags) {
   if (!flags) {
      return '';
   }
   if (typeof flags === 'string') {
      return flags;
   }
   return Object.entries(flags)
      .map(([k, v]) => {
         if (v === false || v === null || v === undefined) {
            return '';
         }
         if (v === true) {
            return `--${k}`;
         }
         return `--${k} ${v}`;
      })
      .filter(Boolean)
      .join(' ');
}

const SCRIPTS_DIR = '~/llm-bench/scripts/llm2';
const DEFAULT_PORT = 8090;

/**
 * Create a server manager for a specific SSH host + LLAMA_URL pair.
 *
 * @param {object} opts
 *   sshHost   {string}   SSH alias for llm2 (e.g. 'llm2')
 *   llamaUrl  {string}   HTTP endpoint for the OpenAI-compat API
 *   backend   {string}   'vulkan' | 'rocm' (default: 'vulkan')
 *   port      {number}   llama-server port (default: 8090)
 *   debug     {boolean}  verbose logging
 *   local     {boolean}  run the llm2 scripts locally (Node is ON the test host)
 *                        instead of over SSH; defaults to env BENCH_LOCAL=1.
 */
export function llamacppServer({
   sshHost,
   llamaUrl = 'http://192.168.1.120:8090',
   backend = 'vulkan',
   port = DEFAULT_PORT,
   debug = false,
   local = LOCAL_HOST,
}) {
   const client = createClient(llamaUrl, { debug });

   /** Run a script on the host (locally or over SSH). Throws on failure unless tolerant=true. */
   async function runScript(script, args = '', { tolerant = false, timeout = 30_000 } = {}) {
      const cmd = `bash ${SCRIPTS_DIR}/${script} ${args}`;
      if (debug) {
         console.error(`[${local ? 'local' : 'ssh'}] ${cmd}`);
      }
      const r = await runHostCmd(cmd, { local, sshHost, timeout });
      if (!r.ok && !tolerant) {
         throw new Error(`${script} failed: ${r.stderr.slice(0, 200)}`);
      }
      return r.stdout;
   }

   /**
    * Detect available backends on the remote host.
    * Returns array of { backend, path } objects.
    */
   async function detectBackends() {
      const out = await runScript('backends.sh', '', { tolerant: true });
      return out
         .split('\n')
         .filter(Boolean)
         .map((line) => {
            const [name, path] = line.trim().split(/\s+/);
            return { backend: name, path };
         });
   }

   /**
    * Start the server for a model config.
    *
    * @param {object} opts
    *   hf_repo    {string}   HF repo id
    *   hf_file    {string}   GGUF filename
    *   ctx        {number}   Context size (tokens)
    *   extraFlags {string}   Additional llama-server flags (e.g. MTP, chat-template)
    * @returns {string} PID of the launched server
    */
   async function startServer({ hf_repo, hf_file, ctx, extraFlags = '' }) {
      const args = [
         `--backend ${backend}`,
         `--ctx ${ctx}`,
         `--port ${port}`,
         `--hf-repo '${hf_repo}'`,
         `--hf-file '${hf_file}'`,
         extraFlags,
      ]
         .filter(Boolean)
         .join(' ');

      // HF downloads can take a while on first run — give 600s
      const pid = await runScript('start-server.sh', args, { timeout: 600_000 });
      console.log(`[llamacpp] started PID=${pid} backend=${backend} ctx=${ctx} ${hf_file}`);
      return pid;
   }

   /**
    * Wait until the server is ready for inference (503-aware, model-load wait).
    * Falls back to the shell health.sh if direct HTTP fails (cross-machine firewall).
    */
   async function waitHealthy(timeoutMs = 300_000) {
      // Try direct HTTP first (faster; works when the dev host can reach llm2 directly)
      const ready = await client
         .waitHealthy(timeoutMs)
         .then(() => true)
         .catch(() => false);
      if (ready) {
         return true;
      }
      // Fallback: run health.sh on llm2 (handles firewall/NAT cases)
      const timeoutS = Math.floor(timeoutMs / 1000);
      const r = await runScript('health.sh', `--url ${llamaUrl} --timeout ${timeoutS}`, { tolerant: true, timeout: timeoutMs + 5_000 });
      if (r.includes('ready')) {
         return true;
      }
      throw new Error(`Server not ready within ${timeoutS}s`);
   }

   /** Stop the tracked server and clean up. */
   async function stopServer() {
      await runScript('stop-server.sh', `--port ${port}`, { tolerant: true, timeout: 15_000 });
   }

   /** Aggressive kill — use on SIGINT/SIGTERM and before each probe. */
   async function killAll() {
      await runScript('kill-all.sh', `--port ${port}`, { tolerant: true, timeout: 30_000 });
   }

   /** VRAM used in MiB (reads rocm-smi on llm2). */
   async function snapshotVram() {
      const out = await runScript('vram.sh', '', { tolerant: true, timeout: 30_000 });
      const n = parseInt(out, 10);
      return Number.isNaN(n) ? null : n;
   }

   /**
    * GPU memory used in MiB as { vram, gtt } (reads rocm-smi on llm2).
    * GTT = system RAM the amdgpu driver mapped for the GPU. amdgpu spills allocations that don't
    * fit VRAM into GTT transparently (no OOM), so a large GTT means the model/KV is running partly
    * on slow system RAM — i.e. it does NOT truly fit in VRAM. Returns nulls on parse failure.
    */
   async function snapshotMem() {
      const out = await runScript('meminfo.sh', '', { tolerant: true, timeout: 30_000 });
      const [v, g] = String(out)
         .trim()
         .split(/\s+/)
         .map((x) => parseInt(x, 10));
      return { vram: Number.isNaN(v) ? null : v, gtt: Number.isNaN(g) ? null : g };
   }

   /** Check for crash patterns in the server log. Returns true if crashed. */
   async function hasCrashed() {
      const r = await runHostCmd(`bash ${SCRIPTS_DIR}/log-tail.sh --lines 20`, { local, sshHost, timeout: 10_000 });
      return r.exitCode === 2;
   }

   /**
    * Poll VRAM until it drops below 512 MiB (server + allocations have released).
    * Prevents OOM from leftover allocations before the next model starts.
    */
   async function waitVramClear(timeoutMs = 60_000) {
      const deadline = Date.now() + timeoutMs;
      while (Date.now() < deadline) {
         const mib = await snapshotVram();
         if (mib === null || mib < 512) {
            return;
         }
         if (debug) {
            console.log(`[llamacpp] waiting VRAM clear — ${mib} MiB...`);
         }
         await new Promise((r) => setTimeout(r, 2_000));
      }
      console.warn('[llamacpp] VRAM did not clear within timeout — proceeding anyway');
   }

   /**
    * Probe llama.cpp's NATIVE auto-fit context ceiling for a model (fit-ctx.sh →
    * llama-fit-params). This is a fast, memory-fit-only estimate — no coherence
    * check — computed analytically without a full model load. It self-manages the
    * GPU (kills any running server + waits for VRAM to clear) and leaves none running,
    * so it should run alongside the agent_ctx probe rather than between server-dependent ones.
    *
    * The helper prints the fitted `-c N` (or `-c 0` when the model fits at its native
    * window). We resolve 0 → native_max_ctx so the row always carries a real ceiling.
    *
    * @param {object} modelCfg  model entry from models.yaml
    * @returns {{ fitCtx: number|null, fitRaw: number|null }}
    */
   async function probeFitCtx(modelCfg) {
      // llama-fit-params only accepts a subset of serving flags — it rejects
      // server-only ones (--no-mmproj, --spec-type, --model-draft, …). Pass ONLY the
      // flags that both (a) it accepts and (b) affect the memory fit: KV-cache quant
      // (the big lever) and batch sizing. NOTE: this deliberately ignores a speculative
      // draft model's VRAM, so for MTP configs fit_ctx slightly over-estimates the
      // headroom the production server actually has. Object extra_flags only; a legacy
      // string extra_flags opts out of the KV match (falls back to fit-ctx.sh's q8_0).
      const FIT_FLAG_KEYS = ['cache-type-k', 'cache-type-v', 'batch-size', 'ubatch-size'];
      const ef = modelCfg.extra_flags;
      let fitFlags = '';
      if (ef && typeof ef === 'object') {
         const picked = {};
         for (const k of FIT_FLAG_KEYS) {
            if (ef[k] != null) {
               picked[k] = ef[k];
            }
         }
         fitFlags = extraFlagsToString(picked);
      } else if (typeof ef === 'string') {
         console.warn('  [fit_ctx] string extra_flags — KV quant not forwarded to fit-params (using its q8_0 default)');
      }

      const args = [`--backend ${backend}`, `--hf-repo '${modelCfg.hf_repo}'`, `--hf-file '${modelCfg.hf_file}'`, fitFlags]
         .filter(Boolean)
         .join(' ');

      const out = await runScript('fit-ctx.sh', args, { tolerant: true, timeout: 180_000 });
      const raw = Number.parseInt(String(out).trim(), 10);
      if (Number.isNaN(raw)) {
         console.warn(`  [fit_ctx] no fitted ctx parsed from fit-ctx.sh output: ${String(out).slice(0, 120)}`);
         return { fitCtx: null, fitRaw: null };
      }
      // -c 0 → fits at native window (no VRAM reduction needed).
      const fitCtx = raw === 0 ? (modelCfg.native_max_ctx ?? null) : raw;
      console.log(`  [fit_ctx] fitted=${raw}${raw === 0 ? ` (native ${modelCfg.native_max_ctx ?? '?'})` : ''}`);
      return { fitCtx, fitRaw: raw };
   }

   /**
    * Check if the server is still alive. Restart once if dead.
    * Returns false only if restart also fails.
    */
   async function ensureAlive(modelCfg) {
      const alive = await client
         .waitHealthy(5_000)
         .then(() => true)
         .catch(() => false);
      if (alive) {
         return { alive: true };
      }

      // Check for crash before restarting
      const crashed = await hasCrashed();
      console.warn(`  [warn] server ${crashed ? 'crashed' : 'died'}, restarting...`);

      try {
         await killAll();
         await startServer({
            hf_repo: modelCfg.hf_repo,
            hf_file: modelCfg.hf_file,
            ctx: modelCfg._ctxLoaded ?? 8192,
            extraFlags: extraFlagsToString(modelCfg.extra_flags),
         });
         await waitHealthy(120_000);
         return { alive: true, restarted: true };
      } catch (e) {
         console.error(`  [error] restart failed: ${e.message}`);
         return { alive: false };
      }
   }

   return {
      client,
      detectBackends,
      probeFitCtx,
      startServer,
      stopServer,
      killAll,
      waitHealthy,
      snapshotVram,
      snapshotMem,
      waitVramClear,
      hasCrashed,
      ensureAlive,
   };
}
