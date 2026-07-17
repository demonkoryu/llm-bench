/**
 * Remote llama-server lifecycle manager.
 *
 * Orchestrates the llm2 shell scripts over SSH to:
 *   - Detect available backends (vulkan | rocm)
 *   - Start / stop llama-server with a lockfile + VRAM-clear wait
 *   - Probe the maximum usable context via a fixed ctx ladder (128/100/64/32/16k)
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
    * Fixed-ladder probe for the maximum usable context size.
    *
    * Instead of a fine-grained binary search, probe a coarse, predictable ladder
    * of context sizes — 128k, 100k, 64k, 32k, 16k (KiB tokens) — from largest to
    * smallest, and take the largest rung that both LOADS and passes the coherence
    * check. No finer-grained refinement: the reported ceiling is always one of
    * these fixed rungs, so it's stable across runs and easy to reason about (the
    * tradeoff is we may report e.g. 64k for a model whose true VRAM-bound limit is
    * 78k — the next rung up, 100k, didn't fit).
    *
    * The coherence check uses the codebase generator from shared/codebase.mjs:
    * fills ~ctx tokens with synthetic code, plants a needle near the end, asks for it.
    * Records oom_ceiling (largest that loaded) and coherence_ceiling (the chosen rung).
    *
    * @param {object} modelCfg   model entry from models.yaml
    * @returns {{ ctxLoaded, oomCeiling, coherenceCeiling, vramMib }}
    */
   // Coarse ctx ladder (KiB tokens), largest → smallest. The reported max-ctx is
   // always one of these rungs (see ladderSearchCtx). 128k is the top — models with
   // a larger native window are not probed above it.
   const CTX_LADDER = [131072, 102400, 65536, 32768, 16384];

   async function ladderSearchCtx(modelCfg) {
      const { hf_repo, hf_file, native_max_ctx, ctx_cap } = modelCfg;
      const extra_flags = extraFlagsToString(modelCfg.extra_flags);

      // Probe think state: disable thinking on hybrid models so the needle answer
      // lands directly in `content` within a short budget. Always-thinking models
      // (required/reasoning) keep null and rely on the post-trace answer.
      const probeThink = modelCfg.think === 'optional' ? false : null;
      const thinkControl = modelCfg.think_control ?? 'enable_thinking';

      // Cap the ladder by the model's declared limits (native window + optional
      // ctx_cap). A model that only supports 32k must never claim a higher rung.
      const cap = Math.min(native_max_ctx ?? Infinity, ctx_cap ?? Infinity);
      const candidates = CTX_LADDER.filter((c) => c <= cap);

      if (!candidates.length) {
         // The cap is below even the smallest rung — use the cap itself as a floor.
         const floor = roundTo2k(Number.isFinite(cap) ? cap : 16384);
         console.log(`  [maxctx] cap ${cap} below ladder floor — using ${floor}`);
         return { ctxLoaded: floor, oomCeiling: floor, coherenceCeiling: floor, vramMib: null };
      }

      console.log(
         `  [maxctx] ladder probe [${candidates.map((c) => `${c / 1024}k`).join(', ')}] native_max=${native_max_ctx ?? 'unknown'}`,
      );

      // Lazy-import codebase generator (Node-side, no SSH)
      const { makeFillPrompt } = (await import('../shared/codebase.mjs').catch(() => null)) ?? {};

      let oomCeiling = null; // largest rung that loaded (even if later incoherent)
      let lastVram = null;

      for (const ctx of candidates) {
         // 1. Try to load
         await killAll();
         await waitVramClear(30_000);

         try {
            await startServer({ hf_repo, hf_file, ctx, extraFlags: extra_flags });
            // HF download may be needed on first run — give 360s
            await waitHealthy(360_000);
            if (oomCeiling == null) {
               oomCeiling = ctx; // first (largest) load that fits
            }
         } catch {
            const crashed = await hasCrashed();
            console.log(`  [maxctx] ctx=${ctx} — load failed (${crashed ? 'crash/OOM' : 'timeout'})`);
            await killAll();
            continue;
         }

         // 2. Coherence check (if codebase module available)
         let coherent = true;
         if (makeFillPrompt) {
            try {
               coherent = await checkCoherence(ctx, makeFillPrompt, probeThink, thinkControl);
            } catch (e) {
               console.warn(`  [maxctx] coherence check error: ${e.message}`);
               coherent = false;
            }
         }

         lastVram = await snapshotVram();
         await stopServer();
         await waitVramClear(20_000);

         if (coherent) {
            console.log(`  [maxctx] ctx=${ctx} ✓ coherent  vram=${lastVram ?? '?'}MiB`);
            console.log(`  [maxctx] result: ${ctx.toLocaleString()} tokens  (oom_ceiling=${oomCeiling ?? ctx})`);
            return { ctxLoaded: ctx, oomCeiling: oomCeiling ?? ctx, coherenceCeiling: ctx, vramMib: lastVram };
         }
         console.log(`  [maxctx] ctx=${ctx} ✗ incoherent (possible RoPE failure or OOM partial)`);
      }

      // No rung was coherent — fall back to the smallest rung as a floor.
      const floor = candidates[candidates.length - 1];
      console.log(`  [maxctx] no ladder rung coherent — falling back to ${floor.toLocaleString()}`);
      return { ctxLoaded: floor, oomCeiling: oomCeiling ?? floor, coherenceCeiling: floor, vramMib: lastVram };
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
    * Re-validate a known max-ctx ceiling under the current server config WITHOUT a
    * full binary search — the "extreme limits only" probe. Tests AT the seed ceiling
    * first; if it still loads + coheres the ceiling holds and we record fresh VRAM.
    * If it now OOMs / goes incoherent (e.g. a larger ubatch ate the VRAM headroom),
    * step DOWN in fixed increments until it passes or hits a floor. Never probes
    * above the seed (extreme-only). Cheap: a single load when the ceiling holds.
    *
    * On success the server is left RUNNING at the resolved ctx so the caller can
    * reuse it for bench passes (mirrors startForModel). On total failure it kills.
    *
    * @param {object} modelCfg   model entry from models.yaml
    * @param {number} seedCtx    previously-recorded coherence ceiling to re-test
    * @param {object} [opts]
    *   step  {number}  step-down granularity in tokens (default 4096)
    *   floor {number}  lowest ctx worth probing (default 8192)
    * @returns {{ ctxLoaded, oomCeiling, coherenceCeiling, vramMib, held, probes }}
    */
   async function probeCeiling(modelCfg, seedCtx, { step = 4096, floor = 8192 } = {}) {
      const { hf_repo, hf_file } = modelCfg;
      const extra_flags = extraFlagsToString(modelCfg.extra_flags);
      const probeThink = modelCfg.think === 'optional' ? false : null;
      const thinkControl = modelCfg.think_control ?? 'enable_thinking';
      const { makeFillPrompt } = (await import('../shared/codebase.mjs').catch(() => null)) ?? {};

      await killAll();
      await waitVramClear(30_000);

      let ctx = roundTo2k(seedCtx);
      let oomCeiling = null; // largest ctx that LOADED (we only ever descend)
      let probes = 0;
      let held = true; // true only while the very first (seed) probe is the one that passes

      console.log(`  [recheck] seed ceiling=${ctx} step=${step} floor=${floor}`);

      while (ctx >= floor) {
         probes += 1;

         // 1. Load at this ctx
         try {
            await startServer({ hf_repo, hf_file, ctx, extraFlags: extra_flags });
            await waitHealthy(360_000);
            if (oomCeiling === null) {
               oomCeiling = ctx;
            }
         } catch {
            const crashed = await hasCrashed();
            console.log(`  [recheck] ctx=${ctx} — load failed (${crashed ? 'crash/OOM' : 'timeout'})`);
            await killAll();
            await waitVramClear(20_000);
            held = false;
            ctx = roundTo2k(ctx - step);
            continue;
         }

         // 2. Coherence at this ctx
         let coherent = true;
         if (makeFillPrompt) {
            try {
               coherent = await checkCoherence(ctx, makeFillPrompt, probeThink, thinkControl);
            } catch (e) {
               console.warn(`  [recheck] coherence check error: ${e.message}`);
               coherent = false;
            }
         }
         const vramMib = await snapshotVram();

         if (coherent) {
            console.log(
               `  [recheck] ctx=${ctx} ✓ coherent  vram=${vramMib ?? '?'}MiB  ${held ? '(ceiling holds)' : `(stepped down from ${roundTo2k(seedCtx)})`}`,
            );
            // Leave the server running at this ctx for the caller's bench passes.
            return { ctxLoaded: ctx, oomCeiling: oomCeiling ?? ctx, coherenceCeiling: ctx, vramMib, held, probes };
         }

         console.log(`  [recheck] ctx=${ctx} ✗ incoherent — stepping down`);
         await killAll();
         await waitVramClear(20_000);
         held = false;
         ctx = roundTo2k(ctx - step);
      }

      // Nothing passed down to the floor — give up (caller records the failure).
      await killAll();
      return { ctxLoaded: floor, oomCeiling: oomCeiling ?? floor, coherenceCeiling: floor, vramMib: null, held: false, probes };
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

      // Probe the fixed ctx ladder to find max usable ctx
      const ctxResult = await ladderSearchCtx(modelCfg);

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
    * Probe llama.cpp's NATIVE auto-fit context ceiling for a model (fit-ctx.sh →
    * llama-fit-params). This is a fast, memory-fit-only estimate — no coherence
    * check — computed analytically without a full model load. It self-manages the
    * GPU (kills any running server + waits for VRAM to clear) and leaves none running,
    * so it should run alongside the maxctx probe rather than between server-dependent ones.
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

      const args = [
         `--backend ${backend}`,
         `--hf-repo '${modelCfg.hf_repo}'`,
         `--hf-file '${modelCfg.hf_file}'`,
         fitFlags,
      ]
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
      startForModel,
      probeFitCtx,
      probeCeiling,
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
