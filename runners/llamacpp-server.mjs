/**
 * Remote llama-server lifecycle manager.
 *
 * Orchestrates the llm2 shell scripts over SSH to:
 *   - Detect available backends (vulkan | rocm)
 *   - Start / stop llama-server with a lockfile + VRAM-clear wait
 *   - Probe the maximum usable context via binary search
 *
 * All system-level operations (process start/stop, VRAM query, health probe)
 * run as shell scripts on llm2 — Node stays on the dev host.
 *
 * Shell scripts live at: llm2:~/llm-bench/scripts/llm2/
 * Deploy path:           ~/llm-bench   (set via REMOTE_BENCH_DIR)
 */

import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { createClient } from '../shared/llm/index.mjs';

const execP = promisify(execFile);

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

async function ssh(host, cmd, { timeout = 30_000 } = {}) {
   try {
      const { stdout, stderr } = await execP('ssh', ['-o', 'BatchMode=yes', '-o', 'ConnectTimeout=10', host, cmd], { timeout });
      return { stdout: stdout.trim(), stderr: stderr.trim(), ok: true };
   } catch (e) {
      return { stdout: '', stderr: e.message, ok: false, exitCode: e.code };
   }
}

/**
 * Create a server manager for a specific SSH host + LLAMA_URL pair.
 *
 * @param {object} opts
 *   sshHost   {string}   SSH alias for llm2 (e.g. 'llm2')
 *   llamaUrl  {string}   HTTP endpoint for the OpenAI-compat API
 *   backend   {string}   'vulkan' | 'rocm' (default: 'vulkan')
 *   port      {number}   llama-server port (default: 8090)
 *   debug     {boolean}  verbose logging
 */
export function llamacppServer({
   sshHost,
   llamaUrl = 'http://192.168.1.120:8090',
   backend = 'vulkan',
   port = DEFAULT_PORT,
   debug = false,
}) {
   const client = createClient(llamaUrl, { debug });

   /** Run a script on llm2, return stdout. Throws on failure unless tolerant=true. */
   async function runScript(script, args = '', { tolerant = false, timeout = 30_000 } = {}) {
      const cmd = `bash ${SCRIPTS_DIR}/${script} ${args}`;
      if (debug) {
         console.error(`[ssh] ${cmd}`);
      }
      const r = await ssh(sshHost, cmd, { timeout });
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
      await runScript('kill-all.sh', `--port ${port}`, { tolerant: true, timeout: 10_000 });
   }

   /** VRAM used in MiB (reads rocm-smi on llm2). */
   async function snapshotVram() {
      const out = await runScript('vram.sh', '', { tolerant: true, timeout: 10_000 });
      const n = parseInt(out, 10);
      return Number.isNaN(n) ? null : n;
   }

   /** Check for crash patterns in the server log. Returns true if crashed. */
   async function hasCrashed() {
      const r = await ssh(sshHost, `bash ${SCRIPTS_DIR}/log-tail.sh --lines 20`, { timeout: 10_000 });
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
    * Binary-search for the maximum context size that loads AND passes a coherence check.
    *
    * The coherence check uses the codebase generator from shared/codebase.mjs:
    * fills ~ctx tokens with synthetic code, plants a needle near the end, asks for it.
    * Records oom_ceiling (largest that loaded) and coherence_ceiling (largest correct).
    *
    * @param {object} modelCfg   model entry from models.yaml
    * @param {number} freeVram   VRAM free in MiB (used to estimate hi bound)
    * @returns {{ ctxLoaded, oomCeiling, coherenceCeiling, vramMib }}
    */
   async function binarySearchCtx(modelCfg) {
      const { hf_repo, hf_file, native_max_ctx, ctx_cap, kv_bytes_per_token = 32768 } = modelCfg;
      const extra_flags = extraFlagsToString(modelCfg.extra_flags);

      // Probe think state: disable thinking on hybrid models so the needle answer
      // lands directly in `content` within a short budget. Always-thinking models
      // (required/reasoning) keep null and rely on the post-trace answer.
      const probeThink = modelCfg.think === 'optional' ? false : null;
      const thinkControl = modelCfg.think_control ?? 'enable_thinking';

      // Estimate hi from VRAM — seed only, not authoritative
      const vramFree = await snapshotVram().then((mib) => (mib !== null ? 20480 - mib : 16384));
      const vramEstimate = Math.floor((vramFree * 1024 * 1024) / kv_bytes_per_token);

      // Upper bound: documented native window (128k default when unknown), an
      // optional ctx_cap override, and the VRAM estimate — whichever is smallest.
      // No arbitrary absolute cap: 200k+ models (GLM-4.7-Flash, Gemma4-12B) must
      // not be silently clipped to 128k. The empirical search still finds the real
      // coherent ceiling, which on a 20 GiB card is usually VRAM-bound well below native.
      let hi = Math.min(native_max_ctx ?? 131072, ctx_cap ?? Infinity, roundTo2k(vramEstimate));
      let lo = 4096;

      if (hi <= lo) {
         console.log(`  [maxctx] hi=${hi} ≤ lo=${lo}, skipping search — using ${lo}`);
         return { ctxLoaded: lo, oomCeiling: lo, coherenceCeiling: lo, vramMib: null };
      }

      console.log(`  [maxctx] binary search lo=${lo} hi=${hi} native_max=${native_max_ctx ?? 'unknown'}`);

      let oomCeiling = lo;
      let coherenceCeiling = lo;
      let lastVram = null;

      // Lazy-import codebase generator (Node-side, no SSH)
      const { makeFillPrompt } = (await import('../shared/codebase.mjs').catch(() => null)) ?? {};

      while (hi - lo > 2048) {
         const mid = roundTo2k(Math.floor((lo + hi) / 2));

         // 1. Try to load
         await killAll();
         await waitVramClear(30_000);

         try {
            await startServer({ hf_repo, hf_file, ctx: mid, extraFlags: extra_flags });
            // HF download may be needed on first run — give 360s
            await waitHealthy(360_000);
            oomCeiling = mid;
         } catch {
            // Tailed log for crash patterns
            const crashed = await hasCrashed();
            console.log(`  [maxctx] ctx=${mid} — load failed (${crashed ? 'crash/OOM' : 'timeout'})`);
            hi = mid - 2048;
            await killAll();
            continue;
         }

         // 2. Coherence check (if codebase module available)
         let coherent = true;
         if (makeFillPrompt) {
            try {
               coherent = await checkCoherence(mid, makeFillPrompt, probeThink, thinkControl);
            } catch (e) {
               console.warn(`  [maxctx] coherence check error: ${e.message}`);
               coherent = false;
            }
         }

         lastVram = await snapshotVram();
         await stopServer();
         await waitVramClear(20_000);

         if (coherent) {
            console.log(`  [maxctx] ctx=${mid} ✓ coherent  vram=${lastVram ?? '?'}MiB`);
            coherenceCeiling = mid;
            lo = mid;
         } else {
            console.log(`  [maxctx] ctx=${mid} ✗ incoherent (possible RoPE failure or OOM partial)`);
            hi = mid - 2048;
         }
      }

      const ctxLoaded = coherenceCeiling > lo ? coherenceCeiling : lo;
      console.log(
         `  [maxctx] result: ${ctxLoaded.toLocaleString()} tokens  (oom_ceiling=${oomCeiling}, coherence_ceiling=${coherenceCeiling})`,
      );
      return { ctxLoaded, oomCeiling, coherenceCeiling, vramMib: lastVram };
   }

   /**
    * Scale the per-request timeout with context size. Prompt prefill is ~O(n²)
    * in the token count, so a fixed timeout silently caps the *measurable* window
    * at the prefill-time wall rather than the model's real coherence limit (the
    * old fixed 120s mis-marked ~43k as "incoherent" on a slow 12B that actually
    * loads and retrieves at 128k). Baseline ~120s at 32k, quadratic growth,
    * capped at 30 min so a genuine hang still terminates.
    */
   function coherenceTimeoutMs(ctxSize) {
      const est = Math.round((ctxSize / 32_000) ** 2 * 120_000);
      return Math.min(1_800_000, Math.max(180_000, est));
   }

   /**
    * Coherence check: feed a large synthetic codebase prompt, ask for a deep
    * needle, return true if the model retrieves it. Uses up to 2 independent
    * needle samples (a perturbed fill size yields a different needle), so one
    * unlucky single-shot miss doesn't collapse the whole context size — the
    * binary search then measures context length, not needle luck.
    */
   async function checkCoherence(ctxSize, makeFillPrompt, think = null, thinkControl = 'enable_thinking') {
      // Reserve room for the answer tokens; the char→token estimate in
      // makeFillPrompt is approximate, so retry smaller if the server rejects
      // the prompt for exceeding the window (tokenizer-density mismatch).
      const ANSWER_BUDGET = 384;
      const timeoutMs = coherenceTimeoutMs(ctxSize);

      for (let sample = 0; sample < 2; sample++) {
         // Sample 1 fills to the window; sample 2 backs off 4% → a different
         // synthetic codebase + needle, an independent retrieval attempt.
         let fillTarget = Math.floor((ctxSize - ANSWER_BUDGET) * (sample === 0 ? 1 : 0.96));
         let resp;
         let expectedAnswer;

         for (let attempt = 0; attempt < 3; attempt++) {
            const built = makeFillPrompt(fillTarget);
            expectedAnswer = built.expectedAnswer;

            if (built.fillRate < 0.6) {
               console.warn(`  [maxctx] fill_rate=${built.fillRate.toFixed(2)} < 0.60 — skipping coherence (unexpected ctx)`);
               return false;
            }

            try {
               resp = await client.chat(built.messages, { think, thinkControl, temperature: 0.0, max_tokens: 256 }, timeoutMs);
               break;
            } catch (e) {
               // Parse "request (N tokens) exceeds the available context size (M tokens)"
               const m = /request \((\d+) tokens\) exceeds.*?\((\d+) tokens\)/.exec(e.message);
               if (m && attempt < 2) {
                  const actual = Number(m[1]);
                  const avail = Number(m[2]);
                  const scale = ((avail - ANSWER_BUDGET) / actual) * 0.97;
                  const next = Math.floor(fillTarget * scale);
                  if (process.env.BENCH_DEBUG) {
                     console.error(`  [coherence] overflow ${actual}>${avail}, rescaling fill ${fillTarget}→${next}`);
                  }
                  fillTarget = next;
                  continue;
               }
               // A non-overflow error — incl. a timeout past the scaled budget —
               // means the model can't usefully serve this ctx: genuinely unusable.
               if (process.env.BENCH_DEBUG) {
                  console.error(`  [coherence] chat error: ${e.message}`);
               }
               return false;
            }
         }
         if (!resp) {
            return false;
         }

         const content = (resp.completion?.choices?.[0]?.message?.content ?? '').toLowerCase();
         const answer = String(expectedAnswer).toLowerCase();
         if (process.env.BENCH_DEBUG) {
            console.error(`  [coherence sample ${sample}] expected="${answer}" got="${content.slice(0, 80)}"`);
         }
         if (content.includes(answer)) {
            return true; // first correct sample → coherent, no need for the second
         }
      }
      return false; // missed both independent samples → treat as incoherent
   }

   function roundTo2k(n) {
      return Math.max(4096, Math.round(n / 2048) * 2048);
   }

   /**
    * Full start sequence: kill orphans → binary-search max-ctx → start real server.
    * Used by run-suite.mjs before each model's bench pass.
    *
    * @param {object} modelCfg  model entry from models.yaml
    * @returns {{ ctxLoaded, oomCeiling, coherenceCeiling, vramMib }}
    */
   async function startForModel(modelCfg) {
      await killAll();
      await waitVramClear(30_000);

      // Run binary search to find max usable ctx
      const ctxResult = await binarySearchCtx(modelCfg);

      // Now start the real server at discovered ctx
      await startServer({
         hf_repo: modelCfg.hf_repo,
         hf_file: modelCfg.hf_file,
         ctx: ctxResult.ctxLoaded,
         extraFlags: extraFlagsToString(modelCfg.extra_flags),
      });
      await waitHealthy(360_000);

      const vramMib = await snapshotVram();
      console.log(`[llamacpp] ready  ctx=${ctxResult.ctxLoaded}  vram=${vramMib ?? '?'}MiB`);
      return { ...ctxResult, vramMib };
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
      startForModel,
      startServer,
      stopServer,
      killAll,
      waitHealthy,
      snapshotVram,
      waitVramClear,
      hasCrashed,
      ensureAlive,
   };
}
