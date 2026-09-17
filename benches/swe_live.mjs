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
// The ACTIVE pin. Bumping this is a deliberate act with a cost attached: results measured against
// an older version stay valid for the instances the new one carries forward, and every configuration
// has to roll out the instances the bump added before its published rate is over the new
// denominator. See build-subset.py for how a version carries its predecessor forward.
const MANIFEST = join(ROOT, 'benchmarks', 'swe-bench-live', 'subset-v2.json');

// Where the harness, its venv and the pinned local dataset live. Outside the repo on purpose: it is
// a multi-GB working area (venv, cloned harness, per-instance logs and trajectories), machine-local
// and reproducible from the manifest, so it has no business in git.
const WORK = process.env.SWE_LIVE_WORK ?? '/home/demonkoryu/.local/state/swe-live';
const PY = join(WORK, 'venv', 'bin', 'python');
const HARNESS = join(WORK, 'SWE-bench-Live');
const DATASET = join(WORK, 'subset.jsonl');

// Exported so anything that has to SHOW the pin (the dashboard's build-time copy) reads the same
// file the bench scores against, rather than naming a version of its own. The page documenting one
// subset while the numbers came from another is a failure that looks like success.
export { MANIFEST as MANIFEST_PATH };
export const loadManifest = () => JSON.parse(readFileSync(MANIFEST, 'utf8'));

/** Instances that count: pinned AND confirmed resolvable here by the gold pass. */
export function scoredInstances(manifest) {
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
export function trajectoryStats(outDir, only = null) {
   const tok = (s) => Math.round(String(s ?? '').length / 4);
   const per = [];
   let calls = 0;
   let generated = 0;
   let total = 0;
   for (const inst of existsSync(outDir) ? readdirSync(outDir, { withFileTypes: true }) : []) {
      if (!inst.isDirectory()) {
         continue;
      }
      // `only` is the SCORED set. A trajectory directory outlives the pin that created it — an
      // instance dropped for a gold failure leaves its rollout on disk — and counting it would put
      // context the denominator knows nothing about into ctx tokens per resolve.
      if (only && !only.has(inst.name)) {
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

/**
 * Per-configuration ROLLOUT LEDGER: what this config has already attempted, and what it cost.
 *
 * Why it exists. Extending the pin (v1's 12 instances to v2's 16) must not mean re-rolling the 12 a
 * configuration already did — that is six configurations x 12 instances x 15 minutes of GPU to
 * reproduce results that are already on disk. The trajectories themselves carry the patch and the
 * exit status, so the only thing a re-run would recover is the WALL CLOCK each rollout took, and
 * that is precisely what this file records.
 *
 * It is a cost record, not a verdict. Nothing here decides whether an instance resolved; the
 * evaluation harness does, and its per-instance reports persist in eval/ independently.
 *
 * CARRIED is a bucket, not a per-instance figure. The twelve v1 rollouts predate the ledger, so
 * their individual durations are unrecoverable and only their total was stored. Recording the
 * instance list alongside the total lets a later read notice if the pin drifts out from under the
 * bucket (an instance it covers dropping out of the scored set), which would otherwise silently
 * overstate the rollout time.
 */
const LEDGER_SCHEMA = 'llm-bench.swe-bench-live.rollouts';

/** The pinned parameters that make two rollouts comparable. A change to any of them invalidates reuse. */
const budgetOf = (params) => ({
   rollout_timeout_s: params.rollout_timeout_s,
   step_limit: params.step_limit,
   ctx: params.ctx,
   agent: params.agent,
   agent_overlay: params.agent_overlay ?? null,
});

export function loadLedger(outDir, params) {
   const f = join(outDir, 'rollouts.json');
   const empty = { schema: LEDGER_SCHEMA, budget: budgetOf(params), instances: {} };
   if (!existsSync(f)) {
      return empty;
   }
   let d;
   try {
      d = JSON.parse(readFileSync(f, 'utf8'));
   } catch {
      console.error('  [swe_live] rollouts.json is unreadable — treating every instance as unattempted');
      return empty;
   }
   // A rollout taken under a different budget is not the same measurement. Discarding the ledger
   // makes the next run re-roll everything, which is expensive and correct; reusing it would
   // publish a rate mixing 10-minute and 15-minute attempts as if they were one run.
   if (JSON.stringify(d.budget) !== JSON.stringify(budgetOf(params))) {
      console.error(
         `  [swe_live] rollouts.json was recorded under a different budget (${JSON.stringify(d.budget)}); ` +
            'ignoring it and re-rolling every instance',
      );
      return empty;
   }
   return { ...empty, ...d, instances: d.instances ?? {} };
}

const saveLedger = (outDir, ledger) => writeFileSync(join(outDir, 'rollouts.json'), `${JSON.stringify(ledger, null, 2)}\n`);

/** Whether this config's rollout for `instanceId` is already done and recoverable from disk. */
function alreadyRolledOut(ledger, outDir, instanceId) {
   // Both conditions, because they answer different questions: the ledger says the rollout was
   // accounted for, the trajectory is where the patch and the exit status actually live. A ledger
   // entry without a trajectory would reuse a patch we cannot read, i.e. score an empty one.
   const accounted = ledger.instances[instanceId] != null || (ledger.carried?.instances ?? []).includes(instanceId);
   return accounted && existsSync(join(outDir, instanceId, `${instanceId}.traj.json`));
}

/** Patch and exit status for an instance, read back from its trajectory. */
function trajectoryOutcome(outDir, instanceId) {
   const f = join(outDir, instanceId, `${instanceId}.traj.json`);
   try {
      const t = JSON.parse(readFileSync(f, 'utf8'));
      return { patch: t?.info?.submission ?? '', exitStatus: t?.info?.exit_status ?? 'Unknown' };
   } catch {
      return { patch: '', exitStatus: 'Unknown' };
   }
}

/**
 * Exit statuses that mean "ran out of wall clock", for the timeouts metric.
 *
 * BOTH spellings, and that is the whole point. The agent enforces the pinned wall clock itself and
 * stops cleanly with `TimeExceeded`; only a rollout that ignored its own limit and had to be killed
 * from outside reports `Timeout`. Counting just the latter — which is what this did until
 * 2026-09-17 — published `timeouts: 0` for every configuration while Muse-Glimmer and Tiel-Coder
 * were each timing out on half their rollouts. The number was not merely imprecise, it said the
 * opposite of what happened, and it said it about exactly the models the wall clock binds hardest.
 */
const TIMEOUT_STATUSES = new Set(['Timeout', 'TimeExceeded']);

/**
 * Wall clock spent rolling out the whole scored set: per-instance entries plus the carried bucket.
 *
 * The bucket is all-or-nothing by construction, so it is only added when every instance it covers is
 * still scored. If the pin has moved out from under it — an instance it covers dropped for a gold
 * failure, say — adding it would charge the configuration for work on an instance no longer in the
 * denominator, and every derived cost (GPU-h per resolve, seconds per step) would be quietly high.
 * Dropping it instead makes the number visibly LOW and says so, which is the failure that gets
 * noticed rather than believed.
 */
function totalRolloutSeconds(ledger, instances) {
   const scored = new Set(instances.map((i) => i.instance_id));
   let seconds = 0;
   for (const id of scored) {
      seconds += ledger.instances[id]?.seconds ?? 0;
   }
   const carriedIds = ledger.carried?.instances ?? [];
   if (carriedIds.length === 0) {
      return seconds;
   }
   const orphans = carriedIds.filter((id) => !scored.has(id));
   if (orphans.length > 0) {
      console.error(
         `  [swe_live] WARNING: the carried rollout bucket covers ${orphans.length} instance(s) no longer ` +
            `scored (${orphans.join(', ')}); omitting the whole bucket, so swe_rollout_s understates the cost`,
      );
      return seconds;
   }
   return seconds + (ledger.carried.seconds ?? 0);
}

/**
 * Every swe_live metric, from the evidence on disk plus a verdict set.
 *
 * ONE function, called by both the bench and analysis/backfill-swe-live.mjs, because the two used
 * to compute this separately and drifted: the backfill emitted context and step-cost metrics the
 * bench did not, so those numbers reached the dashboard only when someone remembered to run the
 * backfill. Two implementations of one formula is one implementation and one bug waiting.
 *
 * `resolved` is passed in rather than read here: the bench reads it from the evaluation it just ran,
 * the backfill from evaluation output already on disk, and that is the only difference between them.
 */
export function sweMetrics({ outDir, instances, resolved, ledger, evalSeconds = null }) {
   const scored = new Set(instances.map((i) => i.instance_id));
   const outcome = Object.fromEntries(instances.map((i) => [i.instance_id, trajectoryOutcome(outDir, i.instance_id)]));
   const byLang = {};
   for (const i of instances) {
      byLang[i.language] ??= { n: 0, k: 0 };
      byLang[i.language].n += 1;
      if (resolved.has(i.instance_id)) {
         byLang[i.language].k += 1;
      }
   }
   const n = instances.length;
   const k = instances.filter((i) => resolved.has(i.instance_id)).length;
   const rolloutSeconds = totalRolloutSeconds(ledger, instances);
   const stats = trajectoryStats(outDir, scored);
   return {
      swe_resolved: k,
      swe_total: n,
      // Rate as a fraction. The dashboard pairs it with a Wilson interval computed from (k, n) — at
      // n=16 the interval is still wide, and this bench carries 66% of the coding group, so the
      // uncertainty has to travel with the number rather than be recoverable only by someone who
      // remembers n.
      swe_rate: n ? k / n : null,
      ...(rolloutSeconds ? { swe_rollout_s: rolloutSeconds } : {}),
      ...(evalSeconds != null ? { swe_eval_s: evalSeconds } : {}),
      // Over ALL scored instances, carried rollouts included — these describe the configuration's
      // result on the pinned set, not on whichever slice of it one process happened to run.
      swe_timeouts: instances.filter((i) => TIMEOUT_STATUSES.has(outcome[i.instance_id]?.exitStatus)).length,
      swe_no_patch: instances.filter((i) => !outcome[i.instance_id]?.patch).length,
      // Costs PER RESOLVE are omitted, not zero, when nothing resolved: the cost of a resolution is
      // undefined then, and 0 would read as "free".
      ...(k && rolloutSeconds ? { swe_gpu_h_per_resolve: rolloutSeconds / 3600 / k } : {}),
      ...(stats
         ? {
              ...(k ? { swe_ctx_per_resolve: Math.round(stats.ctxTotal / k) } : {}),
              swe_ctx_median: stats.ctxMedian,
              swe_ctx_max: stats.ctxMax,
              swe_calls: stats.calls,
              ...(stats.calls && rolloutSeconds ? { swe_s_per_call: rolloutSeconds / stats.calls } : {}),
              ...(rolloutSeconds ? { swe_gen_tok_s: stats.generated / rolloutSeconds } : {}),
           }
         : {}),
      ...Object.fromEntries(Object.entries(byLang).map(([l, v]) => [`swe_lang_${l}`, v.n ? v.k / v.n : null])),
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
      //
      // INCREMENTAL. An instance this configuration has already rolled out under the same budget is
      // not rolled out again; its patch and exit status are read back from the trajectory. That is
      // what makes extending the pin cost only the instances the extension added — the alternative
      // is spending the whole fleet's GPU time reproducing results already sitting on disk.
      const evalDir = join(outDir, 'eval');
      mkdirSync(evalDir, { recursive: true });
      const ledger = loadLedger(outDir, params);
      const outcome = {};            // instance_id -> { patch, exitStatus }
      const toEvaluate = {};         // predictions for this evaluation pass only
      const failures = [];
      let fresh = 0;
      for (const inst of instances) {
         const id = inst.instance_id;
         let line;
         const carried = alreadyRolledOut(ledger, outDir, id);
         if (carried) {
            outcome[id] = trajectoryOutcome(outDir, id);
            const secs = ledger.instances[id]?.seconds;
            line = `${secs != null ? `${String(secs).padStart(4)}s` : '   —'} carried`;
         } else {
            const r = await rollout({ instance: inst, model, modelId, inferenceUrl, params, outDir });
            outcome[id] = { patch: r.patch, exitStatus: r.exitStatus };
            if (r.failed) {
               failures.push(id);
            }
            fresh += 1;
            // Recorded even when the rollout produced nothing: a rollout that ends empty still
            // consumed its budget, and leaving it out of the ledger would both understate the cost
            // and make the next run repeat it.
            ledger.instances[id] = {
               seconds: r.seconds,
               exit_status: r.exitStatus,
               patch_bytes: r.patch.length,
               at: new Date().toISOString(),
            };
            // Written per instance rather than at the end: a sweep interrupted after nine rollouts
            // should keep nine rollouts, not none.
            saveLedger(outDir, ledger);
            line = `${String(r.seconds).padStart(4)}s`;
         }
         // A fresh rollout always: its patch is new, so the verdict sitting in eval/ (if any) is
         // about a different patch. A carried one only when its verdict is missing — a rollout that
         // was never judged, say because an evaluation was interrupted, must not be silently
         // counted unresolved.
         if (!carried || !existsSync(join(evalDir, id, 'report.json'))) {
            toEvaluate[id] = { model_patch: outcome[id].patch, model_name_or_path: tag };
         }
         console.error(
            `  [swe_live] ${inst.language.padEnd(4)} ${id.padEnd(42)} ${line} ` +
               `${outcome[id].patch ? `${outcome[id].patch.length}B patch` : 'no patch'} (${outcome[id].exitStatus})`,
         );
      }
      if (fresh > 0 && failures.length === fresh) {
         throw new Error(
            'swe_live: every rollout attempted this run failed for harness reasons (not one reached ' +
               'the model). Refusing to score this — fix the harness and re-run.',
         );
      }
      console.error(`  [swe_live] ${fresh} rolled out this run, ${instances.length - fresh} carried from earlier runs`);
      const predFile = join(outDir, 'predictions.json');
      writeFileSync(predFile, JSON.stringify(toEvaluate, null, 2));

      // ── evaluation: run each patch's test suite ──────────────────────────────────────────────
      // workers=1 because a peer lane is doing the same thing on the other card and the quoted
      // requirement is 16 GB per instance against 47 GB of host RAM, most of which the two model
      // servers have already pinned.
      const evalStart = Date.now();
      // Skipped entirely when nothing new needs judging: --overwrite on an empty prediction set
      // does no work, and the verdicts already in eval/ are what readResolved reads anyway.
      await (Object.keys(toEvaluate).length === 0 ? Promise.resolve() : execP(
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
      )
      ).catch((e) => {
         // A harness crash must not discard the rollouts, which cost real GPU time. Report zero
         // resolved for what could not be judged rather than failing the whole bench.
         console.error(`  [swe_live] evaluation error: ${String(e.message).slice(0, 300)}`);
      });
      const evalSeconds = Math.round((Date.now() - evalStart) / 1000);

      // An ARRAY: bench-run treats a probe's return as a list of sub-bench rows (rawRows.flatMap).
      // Returning the bare object throws "rawRows.flatMap is not a function" after every rollout
      // has already been paid for.
      return [
         {
            bench: 'swe_live',
            ...sweMetrics({ outDir, instances, resolved: readResolved(evalDir), ledger, evalSeconds }),
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
   // results.json describes the LAST evaluation pass only, and with incremental rollouts that pass
   // may cover just the instances a pin bump added — so it being smaller than the per-instance
   // reports is the normal case, not a disagreement. What would be a real disagreement is
   // results.json naming an instance resolved that has no report saying so, which means the two
   // sources are describing different runs.
   const unreported = [...fromResults].filter((id) => !fromReports.has(id));
   if (sawResultsFile && sawReports && unreported.length > 0) {
      console.error(
         `  [swe_live] WARNING: results.json calls ${unreported.length} instance(s) resolved that no ` +
            `per-instance report confirms (${unreported.join(', ')}). Using the union and flagging it.`,
      );
   }
   return new Set([...fromResults, ...fromReports]);
}
