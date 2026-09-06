/**
 * Remote llama-server lifecycle manager.
 *
 * Orchestrates the llm2 shell scripts over SSH to:
 *   - Detect available backends (cuda)
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
// Health-check allowance for a server that may still be downloading its GGUF. It must match the
// 600s startServer gives runScript below: when a health timeout is SHORTER than the download
// allowance, an uncached model times out mid-download, the probe returns zero rows, and bench-run
// still exits 0 — so the run reads as complete. gemma-4-26B-A4B-it-qat lost a whole run that way on
// 2026-08-26 and was nearly written up as a VRAM ceiling. Exported so call sites cannot drift from
// the download budget again; six of them had already settled on an inconsistent 360s.
export const LOAD_TIMEOUT_MS = 600_000;

// For a RELOAD of a model this run has already served — the GGUF is on disk by definition, so no
// download allowance is warranted and waiting the full LOAD_TIMEOUT_MS just makes failure slow.
// This matters where a probe deliberately loads until it fails: agent_ctx steps a slot-count ladder
// down until a rung serves, and rungs that fail by health timeout rather than crash pay this in
// full on every attempt.
//
// Since alive.sh landed, a rung whose server actually exits is detected within ~10s regardless of
// this budget, so what remains here bounds only the genuinely-hung case: a container still running
// but never becoming ready.
export const RELOAD_TIMEOUT_MS = 360_000;

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
 *   backend   {string}   'cuda' (default: 'cuda')
 *   port      {number}   llama-server port (default: 8090)
 *   device    {number}   host CUDA device index this instance owns (default: 0). Every
 *                        host-side operation is scoped to it — container name, lockfile,
 *                        VRAM readout — so the two V100s can serve two models at once
 *                        without one run evicting the other or reading its memory. Same
 *                        contract as the ninfer engine's `device`; see scripts/llm2/start-server.sh.
 *   debug     {boolean}  verbose logging
 *   local     {boolean}  run the llm2 scripts locally (Node is ON the test host)
 *                        instead of over SSH; defaults to env BENCH_LOCAL=1.
 */
/**
 * The `--hf-repo/--hf-file | --model` choice, made once so startServer, probeFitCtx and the
 * restart path cannot disagree about where a model's weights come from.
 *
 * `model_path` exists for a GGUF that is NOT a published HF artifact — a locally produced
 * quant, the same way the speculative drafters already live under ~/models (which
 * start-server.sh bind-mounts read-only at the identical path inside the container). It has to
 * be a separate route rather than a clever cache-directory placement: the image is built with
 * LLAMA_CURL=ON, so --hf-repo resolves the file against the repo manifest on huggingface.co
 * and a filename that exists only on this disk fails there before the cache is ever consulted.
 * `hf_file` stays populated for such a model — it is the identity/label the store keys on — it
 * simply is not what the server is pointed at.
 */
/**
 * The serving-source fields, as one spreadable object: `...modelSource(model)`.
 *
 * Exists because every self-managing probe used to enumerate `{ hf_repo, hf_file }` by hand at its
 * own startServer call, so adding a third source field silently missed all eight of them — the
 * server launched with an --hf-repo whose file was never staged and died with exit code 1 ten
 * seconds into the load, at every context size, which reads like an OOM and is not one. Spread this
 * instead of listing fields, and a future source field reaches every call site by construction.
 */
export function modelSource(model = {}) {
   return { hf_repo: model.hf_repo, hf_file: model.hf_file, model_path: model.model_path };
}

/**
 * Request options that pin a generation to exactly `max_tokens` tokens.
 *
 * `ignore_eos: true` alone no longer does this. In this llama.cpp, common_sampler_init merges
 * `params.logit_bias` plus the vocab's suppress-tokens and NOTHING ELSE — `ignore_eos` is declared
 * in common.h and consumed nowhere in the sampling path. Older llama.cpp implemented it by pushing
 * {eos, -INFINITY} into logit_bias; that code is gone. So today the flag only stops the SERVER from
 * treating EOG as a stop condition: the model still samples EOS, llama.cpp renders it into the text
 * as an unprintable byte, and generation runs on into a second reply.
 *
 * On a model whose EOS does not render as valid UTF-8 that output then fails to parse and the
 * request 500s — not just on /v1/chat/completions but on /v1/completions and the native /completion
 * too, with "Content-only format", the parser that should accept anything. Measured on
 * K2-Horizon-MoVA-36B-A4B, deterministic 4/4; it is why that model banked no throughput or
 * parallel_gen rows. Whether a given model trips it is luck — the dense K2-Horizon-32B carries the
 * same vocab quirk and survived only because it never sampled EOS inside its 128 forced tokens.
 *
 * So a model that declares `eog_tokens` gets those ids biased to -100, which is what ignore_eos
 * used to do for every model. This RESTORES the probes' original semantics rather than changing
 * them: the generation is the same length it was always meant to be, and the output stays valid.
 * `ignore_eos` is kept alongside as the belt to the bias's braces. A model with no `eog_tokens`
 * behaves exactly as before, so no existing fleet row changes meaning.
 */
export function fixedLengthOpts(model = {}) {
   const eog = model.eog_tokens;
   if (!Array.isArray(eog) || eog.length === 0) {
      return { ignore_eos: true };
   }
   return { ignore_eos: true, logit_bias: Object.fromEntries(eog.map((id) => [String(id), -100])) };
}

function modelSourceArgs({ hf_repo, hf_file, model_path }) {
   if (model_path) {
      return `--model '${model_path}'`;
   }
   return `--hf-repo '${hf_repo}' --hf-file '${hf_file}'`;
}

export function llamacppServer({
   sshHost,
   llamaUrl = 'http://192.168.1.120:8090',
   backend = 'cuda',
   port = DEFAULT_PORT,
   device = 0,
   debug = false,
   local = LOCAL_HOST,
}) {
   // Appended to every host script that owns or inspects the per-card container. NOT appended to
   // health.sh (it addresses the URL, not the card) — and never blindly to all of them, because
   // start-server.sh/fit-ctx.sh funnel unrecognised argv into the llama-server flag string.
   const dev = `--device ${device}`;
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
    *   model_path {string}   Absolute path to a GGUF on the host — used INSTEAD of the
    *                         hf_repo/hf_file pair for a locally produced quant (see
    *                         modelSourceArgs)
    *   ctx        {number}   Context size (tokens)
    *   extraFlags {string}   Additional llama-server flags (e.g. MTP, chat-template)
    * @returns {string} PID of the launched server
    */
   async function startServer({ hf_repo, hf_file, model_path, ctx, extraFlags = '' }) {
      const args = [
         `--backend ${backend}`,
         `--ctx ${ctx}`,
         `--port ${port}`,
         dev,
         modelSourceArgs({ hf_repo, hf_file, model_path }),
         extraFlags,
      ]
         .filter(Boolean)
         .join(' ');

      // HF downloads can take a while on first run — give 600s
      const pid = await runScript('start-server.sh', args, { timeout: 600_000 });
      console.log(`[llamacpp] started PID=${pid} gpu${device} backend=${backend} ctx=${ctx} ${hf_file ?? model_path}`);
      return pid;
   }

   /**
    * Wait until the server is ready for inference (503-aware, model-load wait).
    * Falls back to the shell health.sh if direct HTTP fails (cross-machine firewall).
    */
   async function waitHealthy(timeoutMs = 300_000) {
      // Try direct HTTP first (faster; works when the dev host can reach llm2 directly)
      let dead = null;
      const ready = await client
         .waitHealthy(timeoutMs, { abortIf: deadReason })
         .then(() => true)
         .catch((e) => {
            if (e.serverDead) {
               dead = e;
            }
            return false;
         });
      if (ready) {
         return true;
      }
      // The server is gone, not merely unreachable — health.sh would spend the whole budget over
      // again polling the same dead port, which is precisely the wait we just cut short.
      if (dead) {
         throw dead;
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
      await runScript('stop-server.sh', `--port ${port} ${dev}`, { tolerant: true, timeout: 15_000 });
   }

   /** Aggressive kill — use on SIGINT/SIGTERM and before each probe. */
   async function killAll() {
      await runScript('kill-all.sh', `--port ${port} ${dev}`, { tolerant: true, timeout: 30_000 });
   }

   /** VRAM used in MiB on this instance's GPU (reads nvidia-smi on llm2, scoped by `device`). */
   async function snapshotVram() {
      const out = await runScript('vram.sh', dev, { tolerant: true, timeout: 30_000 });
      const n = parseInt(out, 10);
      return Number.isNaN(n) ? null : n;
   }

   /**
    * GPU memory used in MiB as { vram, gtt } (reads nvidia-smi on llm2).
    * vram = used on this instance's GPU. gtt = always 0 on NVIDIA (no transparent
    * spill to system RAM — CUDA OOM is a hard failure, unlike amdgpu/GTT).
    * Returns nulls on parse failure.
    */
   async function snapshotMem() {
      const out = await runScript('meminfo.sh', dev, { tolerant: true, timeout: 30_000 });
      const [v, g] = String(out)
         .trim()
         .split(/\s+/)
         .map((x) => parseInt(x, 10));
      return { vram: Number.isNaN(v) ? null : v, gtt: Number.isNaN(g) ? null : g };
   }

   /**
    * Why the server process is gone, or null if it is running or we cannot tell.
    *
    * alive.sh is three-valued (0 running / 1 exited / 2 unknown) and only exit 1 counts as dead:
    * an SSH hiccup or a missing container must not abort a load that is simply slow. The log-tail
    * check is a second call, but it only runs once we already know the thing is dead, and the
    * distinction it draws — crashed vs exited cleanly — is the first thing anyone reading the
    * failure wants.
    */
   async function deadReason() {
      const r = await runHostCmd(`bash ${SCRIPTS_DIR}/alive.sh ${dev}`, { local, sshHost, timeout: 10_000 });
      if (r.exitCode !== 1) {
         return null;
      }
      const code = r.stdout.trim() || '?';
      const crashed = await hasCrashed().catch(() => false);
      return `container exited (code ${code})${crashed ? ', crash pattern in log' : ''}`;
   }

   /** Check for crash patterns in the server log. Returns true if crashed. */
   async function hasCrashed() {
      const r = await runHostCmd(`bash ${SCRIPTS_DIR}/log-tail.sh --lines 20 ${dev}`, { local, sshHost, timeout: 10_000 });
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

      const args = [`--backend ${backend}`, dev, `--port ${port}`, modelSourceArgs(modelCfg), fitFlags].filter(Boolean).join(' ');

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
            model_path: modelCfg.model_path,
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
      deadReason,
      ensureAlive,
   };
}
