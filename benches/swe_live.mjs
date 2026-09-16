// Bench module: swe_live — SWE-bench-Live/MultiLang on a PINNED subset.
//
// Unlike every other bench here, this one does not talk to the model through our client. It shells
// out to mini-swe-agent, which drives a real repository inside the instance's own Docker container
// and produces a git diff; the SWE-bench-Live harness then runs that repo's test suite to decide
// whether the patch resolved the issue. Our role is to point the agent at the endpoint serving the
// config under test and to turn the harness's verdict into measurement rows.
//
// WHY IT IS A PROBE. It emits one row per config (think_mode 'n/a') rather than a think/no_think
// pair. That is a budget decision, not a claim that thinking is irrelevant to coding: a second pass
// would double the most expensive bench in the suite, and the run has a fixed 8-hour envelope. The
// think state used is whatever bench-run's server is already serving.
//
// WHAT IS PINNED, AND WHY ALL OF IT HAS TO BE. benchmarks/swe-bench-live/subset-v1.json fixes the
// dataset revision, the instance list, AND the run parameters (rollout timeout, step limit, ctx,
// agent version). A SWE-bench score is only comparable against another score taken with the same
// instances *and* the same budget — a model given 10 minutes per instance is not competing with one
// given 5. Changing any of it means a new subset version, not a silent re-run.
//
// THE DENOMINATOR IS THE GOLD-VALIDATED SET, NOT THE PINNED SET. The SWE-bench-Live maintainers are
// explicit that tests rot and Docker does not fully isolate, so a reported rate must be over
// "instances that passed with the gold patch on this machine". Our own first gold pass proved the
// point by failing NVIDIA__OpenShell-695, which no model could have resolved. Scoring against it
// would not be conservative, it would be wrong — and at the 66% weight this bench carries in the
// coding group, a wrong denominator moves the whole leaderboard.
import { execFile } from 'node:child_process';
import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import { capabilityClass, thinkStates } from '../shared/llm/index.mjs';

const execP = promisify(execFile);
const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const MANIFEST = join(ROOT, 'benchmarks', 'swe-bench-live', 'subset-v1.json');

// Where the harness, its venv and the pinned local dataset live. Outside the repo on purpose: it is
// a multi-GB working area (venv, cloned harness, per-instance logs and trajectories), machine-local
// and reproducible from the manifest, so it has no business in git.
const WORK = process.env.SWE_LIVE_WORK ?? '/home/demonkoryu/.local/state/swe-live';
const PY = join(WORK, 'venv', 'bin', 'python');
const HARNESS = join(WORK, 'SWE-bench-Live');
const DATASET = join(WORK, 'subset.jsonl');

const loadManifest = () => JSON.parse(readFileSync(MANIFEST, 'utf8'));

/** Instances that count: pinned AND confirmed resolvable here by the gold pass. */
function scoredInstances(manifest) {
   const valid = manifest.gold_validated?.resolvable;
   if (!Array.isArray(valid) || valid.length === 0) {
      throw new Error(
         'swe_live: subset-v1.json carries no gold_validated.resolvable list. Run the gold pass ' +
            '(benchmarks/swe-bench-live/README.md) and record its result before benchmarking — ' +
            'without it the denominator would include instances no model can resolve.',
      );
   }
   const validSet = new Set(valid);
   return manifest.instances.filter((i) => validSet.has(i.instance_id));
}

/**
 * The model id the endpoint actually advertises.
 *
 * Asked rather than assumed: NInfer requires an EXACT match on the `model` field and 404s otherwise
 * (the id comes from the artifact's own identity, not from our label), while llama.cpp is relaxed
 * about it. One code path that works on both beats two that each work on one.
 */
async function servedModelId(inferenceUrl) {
   const res = await globalThis.fetch(`${inferenceUrl}/v1/models`, { signal: AbortSignal.timeout(15_000) });
   const body = await res.json();
   const id = body?.data?.[0]?.id;
   if (!id) {
      throw new Error(`swe_live: ${inferenceUrl}/v1/models advertised no model`);
   }
   return id;
}

/**
 * One agent rollout. Returns the patch it produced (possibly empty) plus how it ended.
 *
 * The wall-clock cap is enforced HERE rather than left to the agent's own limits. mini-swe-agent
 * bounds steps and dollar cost; against a local model cost is always zero, so the only thing that
 * would stop a slow model looping to its step limit is time, and the whole budget depends on it.
 * A timed-out rollout is a real outcome (no patch), not an error — it is recorded and scored as
 * unresolved, exactly as the benchmark intends for an agent that ran out of budget.
 */
/**
 * The agent's own packaged SWE-bench config.
 *
 * Resolved from the installed package rather than hardcoded: the manifest pins the agent VERSION
 * (mini-swe-agent==2.4.6) and this is that version's config, which is also the SWE-agent-style
 * prompt SWE-bench-Live's README names as protocol-compliant. Passing `-c` REPLACES the default
 * config entirely, so a path that does not resolve does not fall back -- it produces an agent with
 * no prompt at all, which fails in about a second and looks exactly like a model that declined to
 * produce a patch. That is precisely how it failed the first time.
 */
let cachedCfg = null;
async function agentConfig() {
   if (cachedCfg) {
      return cachedCfg;
   }
   // MSWEA_SILENT_STARTUP because importing minisweagent prints a three-line version banner to
   // STDOUT, which would otherwise be captured as part of the path. Last line as well, belt and
   // braces: a future banner that ignores the flag still leaves the path as the final line.
   const { stdout } = await execP(
      PY,
      ['-c', "import minisweagent,pathlib;print(pathlib.Path(minisweagent.__file__).parent/'config'/'benchmarks'/'swebench.yaml')"],
      { env: { ...process.env, MSWEA_SILENT_STARTUP: '1' } },
   );
   cachedCfg = stdout.trim().split('\n').pop().trim();
   if (!existsSync(cachedCfg)) {
      throw new Error(`swe_live: agent config not found at ${cachedCfg}`);
   }
   return cachedCfg;
}

/**
 * Per-model overlay carrying the THINK TOGGLE into the agent's requests.
 *
 * This is not a tuning knob, it is a correctness fix. swe_live is `thinkDependent: false`, so
 * bench-run resolves it to the single non-thinking state for hybrids exactly as it does for every
 * other n/a-scope bench. But mini-swe-agent does not use our client — it talks to the endpoint
 * through litellm — so `think_control` never reached the server and the chat template's default
 * (thinking ON) applied instead.
 *
 * MEASURED COST of that gap, on the first real rollout: 44 calls, ~344 generated tokens each, of
 * which 95% were reasoning_content — 14,348 reasoning tokens against 811 tokens of actual answer.
 * The model spent ~11s of every 21s step thinking, to emit a one-line shell command, and then ran
 * out of wall clock two thirds of the way through the issue.
 *
 * The two spellings mirror shared/llm/think.mjs: nested chat_template_kwargs for llama.cpp, and
 * TOP-LEVEL enable_thinking for NInfer, which 400s the nested form. An always-reasoning model
 * (reasoning_only, e.g. Muse-Glimmer) has no toggle, so it gets no overlay — sending one would be
 * a lie about what the model is doing.
 */
function thinkOverlay(model) {
   const state = thinkStates(capabilityClass(model))[0] ?? null;
   if (state === null) {
      return null; // no toggle to set
   }
   const body =
      (model.think_control ?? 'enable_thinking') === 'enable_thinking_top'
         ? { enable_thinking: state }
         : { chat_template_kwargs: { enable_thinking: state } };
   return `model:\n  model_kwargs:\n    extra_body: ${JSON.stringify(body)}\n`;
}

async function rollout({ instance, model, modelId, inferenceUrl, params, outDir }) {
   const cfg = await agentConfig();
   const overlay = thinkOverlay(model);
   let thinkCfg = null;
   if (overlay) {
      thinkCfg = join(outDir, 'think-overlay.yaml');
      writeFileSync(thinkCfg, overlay);
   }
   const args = [
      '-m',
      'minisweagent.run.benchmarks.swebench',
      // The AGENT reads the dataset from the hub; only the EVALUATION harness reads our local
      // subset.jsonl (its own loader handles a file path fine). mini-swe-agent calls
      // load_dataset(path, split=split), and datasets 5.x no longer accepts a bare file path there
      // -- it requires load_dataset('json', data_files=...) -- so a local file fails with a
      // "Couldn't find any data file" error pointing at a file that is present and valid.
      //
      // Pinning is unaffected: --filter below fixes the exact instance id, and the manifest records
      // the dataset revision. The residual exposure is that a rollout reads the CURRENT
      // problem_statement rather than the revision we pinned; build-subset.py regeneration is what
      // would surface such a change, since it would no longer reproduce subset-v1.json.
      '--subset',
      'SWE-bench-Live/MultiLang',
      '--split',
      instance.language,
      '--filter',
      `^${instance.instance_id.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}$`,
      '-m',
      `openai/${modelId}`,
      '-c',
      cfg,
      // Merged on top of the packaged config: tightens observation truncation only. See
      // benchmarks/swe-bench-live/agent-overlay.yaml for why the stock 10k-char observations make
      // the trajectory unfittable at any served context.
      '-c',
      join(ROOT, 'benchmarks', 'swe-bench-live', 'agent-overlay.yaml'),
      ...(thinkCfg ? ['-c', thinkCfg] : []),
      '-c',
      `agent.step_limit=${params.step_limit}`,
      '-c',
      'agent.cost_limit=0',
      // The agent enforces its own wall clock and then STOPS CLEANLY, writing its trajectory --
      // which is how a timed-out rollout still yields whatever patch it had produced. Killing the
      // process from outside at the same deadline (the original design) discards the trajectory
      // entirely, so every slow model's work vanished and read as "no patch": the cap would have
      // silently zeroed precisely the models it was meant to bound.
      '-c',
      `agent.wall_time_limit_seconds=${params.rollout_timeout_s}`,
      '-o',
      outDir,
      '-w',
      '1',
      '--environment-class',
      'docker',
      '--redo-existing',
   ];
   const env = {
      ...process.env,
      OPENAI_API_BASE: `${inferenceUrl}/v1`,
      OPENAI_API_KEY: 'EMPTY',
      MSWEA_SILENT_STARTUP: '1',
      // Local models are not in litellm's price table, and its cost tracker treats that as fatal.
      MSWEA_COST_TRACKING: 'ignore_errors',
   };
   const started = Date.now();
   let timedOut = false;
   let failed = false;
   try {
      await execP(PY, args, {
         cwd: HARNESS,
         env,
         // Backstop only, well past the agent's own limit: if the agent honours its wall clock we
         // never reach this, and if it hangs somewhere outside its own loop we still bound the run.
         timeout: (params.rollout_timeout_s + 120) * 1000,
         killSignal: 'SIGKILL',
         maxBuffer: 32 * 1024 * 1024,
      });
   } catch (e) {
      timedOut = e.killed === true || e.signal === 'SIGKILL';
      if (!timedOut) {
         // A non-timeout failure is a HARNESS problem, not a model result. Reporting it as an empty
         // patch would quietly score the model zero for our own bug — which is what happened when
         // the config path was wrong: twelve instances "produced no patch" in one second each.
         const detail = `${e.stderr ?? ''}${e.stdout ?? ''}`.trim().slice(-600) || e.message;
         console.error(`  [swe_live] HARNESS FAILURE on ${instance.instance_id}: ${detail}`);
         failed = true;
      }
   }
   const traj = join(outDir, instance.instance_id, `${instance.instance_id}.traj.json`);
   let patch = '';
   let exitStatus = timedOut ? 'Timeout' : 'Unknown';
   if (existsSync(traj)) {
      try {
         const t = JSON.parse(readFileSync(traj, 'utf8'));
         patch = t?.info?.submission ?? '';
         if (!timedOut) {
            exitStatus = t?.info?.exit_status ?? 'Unknown';
         }
      } catch {
         // A trajectory truncated by the SIGKILL is expected on a timeout; treat it as no patch.
      }
   }
   if (failed && !patch) {
      exitStatus = 'HarnessError';
   }
   return { patch, exitStatus, failed, seconds: Math.round((Date.now() - started) / 1000) };
}


/**
 * Context and step cost, read back from the trajectories the agent just wrote.
 *
 * Recorded because they answer the two questions the resolve rate cannot: how much context an
 * agentic rollout actually consumes on real repositories, and what a step costs on this hardware.
 * The first decides whether a served context is adequate or merely generous — this run peaked at
 * 103,818 tokens against a 131,072 window, so 64k would have truncated the longest trajectories
 * rather than merely inconveniencing them. The second is the difference between a model that is
 * slow and one that is incapable, which the rate alone conflates.
 *
 * Derived from the trajectory rather than from the server: the agent's own history IS the context,
 * and no per-request telemetry reconstructs it as directly.
 */
export function trajectoryStats(outDir) {
   const tok = (s) => Math.round(String(s ?? '').length / 4);
   const per = [];
   let calls = 0;
   let generated = 0;
   let total = 0;
   for (const inst of existsSync(outDir) ? readdirSync(outDir, { withFileTypes: true }) : []) {
      if (!inst.isDirectory()) {
         continue;
      }
      const f = join(outDir, inst.name, `${inst.name}.traj.json`);
      if (!existsSync(f)) {
         continue;
      }
      try {
         const d = JSON.parse(readFileSync(f, 'utf8'));
         const msgs = d.messages ?? [];
         const ctx = msgs.reduce((a, m) => a + tok(m.content) + tok(m.reasoning_content), 0);
         const gen = msgs
            .filter((m) => m.role === 'assistant')
            .reduce((a, m) => a + tok(m.content) + tok(m.reasoning_content), 0);
         per.push(ctx);
         total += ctx;
         generated += gen;
         calls += d.info?.model_stats?.api_calls ?? 0;
      } catch {
         // one unreadable trajectory should not lose the rest
      }
   }
   if (!per.length) {
      return null;
   }
   const sorted = [...per].sort((a, b) => a - b);
   return {
      ctxMedian: sorted[Math.floor(sorted.length / 2)],
      ctxMax: sorted[sorted.length - 1],
      calls,
      generated,
      // Summed across rollouts: the denominator for "context processed per issue resolved".
      ctxTotal: total,
   };
}

export const bench = {
   name: 'swe_live',
   kind: 'probe',
   thinkDependent: false,
   async run({ model, inferenceUrl }) {
      const manifest = loadManifest();
      const params = manifest.run_params;
      const instances = scoredInstances(manifest);
      const modelId = await servedModelId(inferenceUrl);
      const tag = (model.hf_file ?? model.label ?? 'model').replace(/[^\w.-]+/g, '_');
      const outDir = join(WORK, 'runs', tag);
      mkdirSync(outDir, { recursive: true });

      // ── rollouts: sequential, one container at a time ────────────────────────────────────────
      // Not parallel even though the box has 32 cores: two lanes already run concurrently on the
      // two GPUs, and each rollout's container plus the harness's own memory would multiply against
      // the 16 GB/instance the maintainers quote. The GPU is the bottleneck anyway — a second
      // concurrent rollout against the same server halves both their token rates.
      const predictions = {};
      const outcomes = {};
      let rolloutSeconds = 0;
      for (const inst of instances) {
         const r = await rollout({ instance: inst, model, modelId, inferenceUrl, params, outDir });
         predictions[inst.instance_id] = { model_patch: r.patch, model_name_or_path: tag };
         outcomes[r.exitStatus] = (outcomes[r.exitStatus] ?? 0) + 1;
         rolloutSeconds += r.seconds;
         console.error(
            `  [swe_live] ${inst.language.padEnd(4)} ${inst.instance_id.padEnd(42)} ${String(r.seconds).padStart(4)}s ` +
               `${r.patch ? `${r.patch.length}B patch` : 'no patch'} (${r.exitStatus})`,
         );
      }
      if (outcomes.HarnessError === instances.length) {
         throw new Error(
            'swe_live: every rollout failed for harness reasons (not one reached the model). ' +
               'Refusing to score this as 0/N — fix the harness and re-run.',
         );
      }
      const predFile = join(outDir, 'predictions.json');
      writeFileSync(predFile, JSON.stringify(predictions, null, 2));

      // ── evaluation: run each patch's test suite ──────────────────────────────────────────────
      // workers=1 because a peer lane is doing the same thing on the other card and the quoted
      // requirement is 16 GB per instance against 47 GB of host RAM, most of which the two model
      // servers have already pinned.
      const evalDir = join(outDir, 'eval');
      mkdirSync(evalDir, { recursive: true });
      const evalStart = Date.now();
      await execP(
         PY,
         [
            '-m',
            'evaluation.evaluation',
            '--dataset',
            DATASET,
            '--patch_dir',
            predFile,
            '--platform',
            'linux',
            '--workers',
            '1',
            '--output_dir',
            evalDir,
            '--overwrite',
            '1',
         ],
         { cwd: HARNESS, timeout: 3 * 3600_000, maxBuffer: 64 * 1024 * 1024 },
      ).catch((e) => {
         // A harness crash must not discard the rollouts, which cost real GPU time. Report zero
         // resolved for what could not be judged rather than failing the whole bench.
         console.error(`  [swe_live] evaluation error: ${String(e.message).slice(0, 300)}`);
      });
      const evalSeconds = Math.round((Date.now() - evalStart) / 1000);

      const resolved = readResolved(evalDir);
      const byLang = {};
      for (const inst of instances) {
         byLang[inst.language] ??= { n: 0, resolved: 0 };
         byLang[inst.language].n += 1;
         if (resolved.has(inst.instance_id)) {
            byLang[inst.language].resolved += 1;
         }
      }

      const n = instances.length;
      const k = instances.filter((i) => resolved.has(i.instance_id)).length;
      const stats = trajectoryStats(outDir);
      // An ARRAY: bench-run treats a probe's return as a list of sub-bench rows (rawRows.flatMap).
      // Returning the bare object throws "rawRows.flatMap is not a function" after every rollout
      // has already been paid for.
      return [
         {
            bench: 'swe_live',
            swe_resolved: k,
            swe_total: n,
            // Rate as a fraction. The dashboard pairs it with a Wilson interval computed from
            // (k, n) — at n=12 the interval is wide, and this bench carries 66% of the coding
            // group, so the uncertainty has to travel with the number rather than be recoverable
            // only by someone who remembers n.
            swe_rate: n ? k / n : null,
            swe_rollout_s: rolloutSeconds,
            swe_eval_s: evalSeconds,
            swe_timeouts: outcomes.Timeout ?? 0,
            swe_no_patch: Object.entries(predictions).filter(([, p]) => !p.model_patch).length,
            ...Object.fromEntries(Object.entries(byLang).map(([l, v]) => [`swe_lang_${l}`, v.n ? v.resolved / v.n : null])),
            status: 'ok',
         },
      ];
   },
};

/**
 * Instance ids the harness judged resolved.
 *
 * The SWE-bench-Live harness writes results.json with `success_ids` (plus failure_ids, error_ids
 * and empty_patch_ids). An earlier version of this function guessed at `resolved`/`resolved_ids`,
 * found neither, and returned an EMPTY SET — which is not an error, it is a plausible-looking 0/12
 * for a configuration that had actually resolved 8. A parser that cannot find its field must say so
 * rather than report zero, so this cross-checks two independent sources and refuses to guess.
 */
function readResolved(evalDir) {
   const fromResults = new Set();
   const resultsFile = join(evalDir, 'results.json');
   let sawResultsFile = false;
   if (existsSync(resultsFile)) {
      try {
         const j = JSON.parse(readFileSync(resultsFile, 'utf8'));
         const ids = j.success_ids ?? j.resolved_ids ?? j.resolved;
         if (Array.isArray(ids)) {
            sawResultsFile = true;
            for (const id of ids) {
               fromResults.add(id);
            }
         }
      } catch {
         // fall through to the per-instance reports
      }
   }

   // Independent source: each instance directory carries its own report.json with `resolved`.
   const fromReports = new Set();
   let sawReports = false;
   for (const entry of readdirSync(evalDir, { withFileTypes: true })) {
      if (!entry.isDirectory()) {
         continue;
      }
      const rf = join(evalDir, entry.name, 'report.json');
      if (!existsSync(rf)) {
         continue;
      }
      try {
         const r = JSON.parse(readFileSync(rf, 'utf8'));
         sawReports = true;
         if (r.resolved === true) {
            fromReports.add(r.instance_id ?? entry.name);
         }
      } catch {
         // ignore one unreadable report rather than lose the rest
      }
   }

   if (!sawResultsFile && !sawReports) {
      throw new Error(
         `swe_live: could not read any verdict from ${evalDir} — neither results.json nor any ` +
            'per-instance report.json was parseable. Refusing to report 0 resolved for an ' +
            'evaluation that may well have succeeded.',
      );
   }
   if (sawResultsFile && sawReports && fromResults.size !== fromReports.size) {
      console.error(
         `  [swe_live] WARNING: results.json says ${fromResults.size} resolved, per-instance ` +
            `reports say ${fromReports.size}. Using the union and flagging the disagreement.`,
      );
   }
   return new Set([...fromResults, ...fromReports]);
}
