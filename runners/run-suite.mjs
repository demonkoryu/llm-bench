#!/usr/bin/env node

/**
 * Serial benchmark orchestrator — runs all benchmarks for all models on llm2.
 *
 * Architecture:
 *   - Node (this process, dev host) — orchestrator, benches, graders, client, judge.
 *   - llm2 shell scripts — system concerns only (start/stop server, VRAM, health).
 *
 * Loop: for model → binary-search max-ctx → start server → smoke gate → run axes → stop.
 *   Strictly serial: only one llama-server runs at a time (enforced by shell lockfile).
 *
 * Options:
 *   --target <name>        Host target from config/hosts.yaml (default: rose)
 *   --backend <vulkan|rocm> Backend to use (default: vulkan)
 *   --models <tag,...>     Restrict to models (substring match on label/hf_file)
 *   --benches <name,...>   Restrict bench names
 *   --skip-maxctx          Skip the ctx-ladder probe (use ctx_cap or 8192)
 *   --dry-run              Print matrix and exit
 *   --resume               Skip combos already present (from --resume-from, else latest run)
 *   --resume-from <run_id> Seed --resume done-keys from a specific prior run
 *   --debug                Enable LLM request/response logging (BENCH_DEBUG=1)
 *
 * Each invocation writes an immutable run directory: results/runs/<run_id>/run.json
 * — a single self-describing object holding provenance (host/gpu/backend/config),
 * lifecycle (started/finished/status: complete | partial | aborted), and this run's
 * result rows (each stamped with a ts). Runs are never appended to after they finish
 * — a catch-up run is its own directory, and build-report merges runs
 * deterministically by ts/status. The status is set to 'aborted' if the process is
 * killed mid-run, so partial runs are never mistaken for complete ones.
 */

import { execFile } from 'node:child_process';
import { closeSync, existsSync, mkdirSync, openSync, readFileSync, unlinkSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseArgs, promisify } from 'node:util';
import { loadHostConfig } from '../shared/hosts-config.mjs';
import { loadModelsConfig, modelBaseId } from '../shared/models-config.mjs';
import { createRun, latestRun, listRuns, readRun } from '../shared/results-store.mjs';
import { buildEnvironment, environmentDiff } from '../shared/run-fingerprint.mjs';

const __dir = dirname(fileURLToPath(import.meta.url));
const ROOT = join(__dir, '..');
const execP = promisify(execFile);

// ── CLI ────────────────────────────────────────────────────────────────────────
const { values: flags } = parseArgs({
   options: {
      target: { type: 'string', default: 'rose' },
      backend: { type: 'string', default: 'vulkan' },
      models: { type: 'string', default: '' },
      benches: { type: 'string', default: '' },
      'skip-maxctx': { type: 'boolean', default: false },
      full: { type: 'boolean', default: false }, // after the core suite, chain ALL secondary runners (kv-probe, struct-output, throughput-ttft, speed-decay, quality-decay) and rebuild every chart. A "full run" is not full without these — the depth/perf + struct/kv benches feed the fleet chart and the e2e/ttft/retention sections.
      'skip-think': { type: 'boolean', default: false }, // drop the think=true pass (no_think only) — fast partial run; do the full think-inclusive pass separately
      depths: { type: 'string' }, // with --full: forward to the depth secondaries (speed-decay, quality-decay) to cap the sweep, e.g. --depths 16384,32768 to drop the slow 64k/96k tail
      'maxctx-recheck': { type: 'boolean', default: false }, // re-validate prior ceiling at current config (extreme-only, no full search)
      'recheck-from': { type: 'string' }, // CSV to seed prior ceilings from (default: latest results file)
      ctx: { type: 'string' }, // with --skip-maxctx: start server at this fixed ctx (skip the search)
      'dry-run': { type: 'boolean', default: false },
      resume: { type: 'boolean', default: false },
      'resume-from': { type: 'string' }, // run id to seed --resume done-keys from (default: latest run)
      debug: { type: 'boolean', default: false },
   },
});

const DRY_RUN = flags['dry-run'];
const TARGET = flags.target;
const BACKEND = flags.backend;
const FILTER_MODELS = flags.models ? flags.models.split(',').map((s) => s.trim()) : [];
const FILTER_BENCHES = flags.benches ? flags.benches.split(',').map((s) => s.trim()) : [];
const SKIP_MAXCTX = flags['skip-maxctx'];
const FULL = flags.full;
const SKIP_THINK = flags['skip-think'];
const MAXCTX_RECHECK = flags['maxctx-recheck'];
const DEBUG = flags.debug || !!process.env.BENCH_DEBUG;

if (DEBUG) {
   process.env.BENCH_DEBUG = '1';
}

// ── Concurrency lock ────────────────────────────────────────────────────────────
// Prevents multiple run-suite instances from running simultaneously — concurrent
// llama-server usage on the same GPU causes data corruption (race on port, VRAM,
// and benchmark timing). The lockfile holds the PID of the running process so
// stale locks (process killed mid-run) are detected and cleared automatically.
//
// Skipped for --dry-run: read-only, no server interaction.
const LOCK_FILE = join(ROOT, '.bench.lock');

function acquireLock() {
   if (existsSync(LOCK_FILE)) {
      const raw = readFileSync(LOCK_FILE, 'utf8').trim();
      const pid = parseInt(raw, 10);
      if (!isNaN(pid) && pid !== process.pid) {
         let alive = false;
         try {
            process.kill(pid, 0); // signal 0 = existence check only
            alive = true;
         } catch (e) {
            if (e.code !== 'ESRCH') {
               alive = true; // EPERM = alive but owned by different user
            }
         }
         if (alive) {
            console.error(`[run-suite] ERROR: another bench is already running (PID ${pid}).`);
            console.error(`[run-suite]        Refusing to start — concurrent runs corrupt GPU data.`);
            console.error(`[run-suite]        If that process is dead, remove: ${LOCK_FILE}`);
            process.exit(1);
         }
         console.warn(`[run-suite] Stale lock from dead PID ${pid} — clearing.`);
         unlinkSync(LOCK_FILE);
      }
   }
   // Atomic exclusive create (throws EEXIST if another process wins the race).
   try {
      const fd = openSync(LOCK_FILE, 'wx'); // O_CREAT | O_EXCL
      closeSync(fd);
      writeFileSync(LOCK_FILE, String(process.pid));
   } catch (e) {
      if (e.code === 'EEXIST') {
         // Lost race to another process starting at the same millisecond; re-check.
         acquireLock();
      } else {
         throw e;
      }
   }
}

function releaseLock() {
   try {
      const raw = readFileSync(LOCK_FILE, 'utf8').trim();
      if (parseInt(raw, 10) === process.pid) {
         unlinkSync(LOCK_FILE);
      }
   } catch {
      // Already removed or never written — no action needed.
   }
}

if (!DRY_RUN) {
   acquireLock();
   process.on('exit', releaseLock);
   // SIGINT / SIGTERM: set a non-zero exit code so the run is marked aborted,
   // then fall through to the 'exit' handler which calls releaseLock().
   process.on('SIGINT', () => process.exit(130));
   process.on('SIGTERM', () => process.exit(143));
}

// ── Config ─────────────────────────────────────────────────────────────────────
const modelsConfig = loadModelsConfig(join(ROOT, 'config/models.yaml'));
const { llamaUrl: LLAMA_URL, sshHost: SSH_HOST, gpu: GPU } = loadHostConfig(join(ROOT, 'config/hosts.yaml'), TARGET, { backend: BACKEND });
const SAMPLING_MATRIX = modelsConfig.sampling_matrix ?? {};

// ── Shared LLM imports ──────────────────────────────────────────────────────────
const { stripThink, extractJson, capabilityClass, thinkStates, resolveSampling } = await import('../shared/llm/index.mjs');

// ── Grader imports ─────────────────────────────────────────────────────────────
const { gradeOne: triageGradeOne, computeScore: triageComputeScore } = await import('../shared/triage-rubric.mjs');
const { GOLDEN } = await import('../shared/triage-golden.mjs');
const { TRIAGE_SCHEMA, TRIAGE_STATIC_PROMPT } = await import('../shared/triage-prompt.mjs');
const triageGrader = (await import('../benchmarks/triage/grader.mjs')).default;
const { CASES: REASON_CASES } = await import('../benchmarks/reasoning/cases.mjs');
const reasoningGrader = (await import('../benchmarks/reasoning/grader.mjs')).default;
const { CASES: TOOL_CASES, TOOLS_POOL } = await import('../benchmarks/toolcalling/toolcases.mjs');
const toolGrader = (await import('../benchmarks/toolcalling/grader.mjs')).default;
const summGrader = (await import('../benchmarks/summarization/grader.mjs')).default;
const { SUMM_ITEMS } = await import('../benchmarks/summarization/summcases.mjs');
const { gradeAll: docqaGradeAll } = await import('../benchmarks/docqa/grader.mjs');
const { CASES: CODING_MULTIPL_CASES } = await import('../benchmarks/coding/cases-multipl.mjs');
const { gradeCase: codingGradeCase } = await import('../benchmarks/coding/grader.mjs');
const { makeFillPrompt } = await import('../shared/codebase.mjs');
const docqaCases = JSON.parse(readFileSync(join(ROOT, 'benchmarks/docqa/cases.json'), 'utf8'));

// ── Model helpers ──────────────────────────────────────────────────────────────
const allModels = modelsConfig.models ?? [];

/**
 * Stable ID derived from the GGUF filename + think state.
 * thinkState null → base name (non-hybrid models); true/false → appends --think/--nothi.
 * Used as TSV row key and judge bundle key.
 */
function modelId(m, thinkState) {
   // base already carries the KV-variant tag (`--kv<quant>`) when present; the think
   // suffix is appended LAST so baseModel()'s trailing `--(nothi|think)$` strip recovers
   // the variant-scoped base id. Order: <gguf>[--kv<quant>][--think|--nothi].
   const base = modelBaseId(m);
   if (thinkState === true) {
      return `${base}--think`;
   }
   if (thinkState === false) {
      return `${base}--nothi`;
   }
   return base;
}

function filterModels() {
   return allModels.filter((m) => {
      // `disabled: true` in models.yaml keeps the entry in config but excludes it
      // from runs (reversible — remove the flag to re-enable). An explicit --models
      // filter overrides this, so you can still target a disabled model by name.
      if (m.disabled && !FILTER_MODELS.length) {
         return false;
      }
      if (FILTER_MODELS.length && !FILTER_MODELS.some((f) => modelId(m, null).includes(f) || (m.label ?? '').includes(f))) {
         return false;
      }
      return true;
   });
}

/** Get the think states to run for a model (from capability class). */
function getThinkModes(model) {
   return thinkStates(capabilityClass(model));
}

// Think-mode bench gating is inline at each bench dispatch (thinkState !== true
// checks). For reference, the benches that do NOT run in think mode are:
// toolcalling_decay (run once, KV-independent) and maxctx (think-independent —
// probed once in the no_think / null pass). toolcalling DOES run in think mode:
// Qwen3/GLM/Gemma4 support tool use while thinking.

// ── Token budgets ──────────────────────────────────────────────────────────────
const MAX_TOKENS = {
   reasoning: 2048, // no_think reasoning bench — model stuffs CoT into answer string; 1024 was too tight
   think: 32768, // think block + answer; Qwen3/DeepSeek-R1 official recommendation
   tool: 512, // single tool call response
   instruct: 1024, // non-thinking instruct models
   docqa: 1280, // multi-hop doc-QA with citations
   coding_multipl: 16384, // imported MultiPL-E (HumanEval-JS) function tasks — the sole coding source.
   //                       Function-level, so most finish well under it; the ceiling only guards verbose models.
   coding_multipl_think: 20480, // capped think budget for the think pass: verbose reasoners
   //                            (e.g. Gemma4-26B) can spend >12k tokens thinking; at 12288 they truncated
   //                            mid-thought → empty code → false 0%. 20480 fits reasoning + code and
   //                            still completes under the 600s timeout (~394s at the slowest ~52 tok/s).
   longctx: 4096, // long-context comprehension answer
   speed: 150, // speed bench — just want tokens generated
};

/** Resolve sampling params for a given model + bench + think state. */
function sampleOpts(model, thinkState, bench) {
   return resolveSampling(model, thinkState, bench, SAMPLING_MATRIX);
}

/**
 * Warn when a model hit max_tokens instead of natural stop token.
 * Returns true if runaway was detected.
 */
function warnRunaway(bench, id, completion) {
   const reason = completion?.choices?.[0]?.finish_reason;
   if (reason === 'length') {
      console.warn(`    [RUNAWAY] ${bench}/${id}: hit max_tokens ceiling — model did not converge`);
      return true;
   }
   return false;
}

/**
 * Simple repetition/divergence detector.
 * Used by the watchdog to detect runaway generation; exported for testing.
 * Returns true if the output looks like runaway repetition.
 */
export function isDivergent(text, minReps = 5) {
   if (!text || text.length < 200) {
      return false;
   }
   // Check for repeated line (same non-empty line repeated >= minReps times)
   const lines = text.split('\n').filter(Boolean);
   if (lines.length >= minReps) {
      const counts = new Map();
      for (const l of lines) {
         const c = (counts.get(l) ?? 0) + 1;
         counts.set(l, c);
         if (c >= minReps) {
            return true;
         }
      }
   }
   return false;
}

// ── Results ────────────────────────────────────────────────────────────────────
const RESULTS_DIR = join(ROOT, 'results');
mkdirSync(RESULTS_DIR, { recursive: true });

// Readable server fingerprint (shared/run-fingerprint.mjs): the config marker stamped
// on the run, derived from the server-dependent config (GPU, backend, KV-cache quant,
// flash-attn, ngl/np, batch/ubatch defaults, and the verbatim start-server.sh launch
// line). Config-FILE derived — it does NOT capture the llama.cpp build commit or GPU
// driver, so it labels a run for comparability, it is not a reproducibility guarantee.
const START_SERVER_SH = (() => {
   try {
      return readFileSync(join(ROOT, 'scripts/llm2/start-server.sh'), 'utf8');
   } catch {
      return '';
   }
})();
const ENVIRONMENT = buildEnvironment({
   gpu: GPU,
   backend: BACKEND,
   startServerShText: START_SERVER_SH,
   defaultsExtraFlags: modelsConfig.defaults?.extra_flags ?? null,
});

// Captured BEFORE we create our own (empty) run dir so --resume seeds from the
// previous run, not from the directory this invocation is about to write.
const PRIOR_RUN = latestRun(RESULTS_DIR);

// Marker check: if the latest run's server config differs from ours, warn loudly —
// resuming/merging across a config change mixes non-comparable measurements.
if (!DRY_RUN && PRIOR_RUN) {
   const prior = readRun(RESULTS_DIR, PRIOR_RUN);
   const diff = environmentDiff(prior?.environment ?? null, ENVIRONMENT);
   if (diff.length) {
      console.warn(`[run-suite] ⚠ server config changed vs ${PRIOR_RUN}: ${diff.join('; ')}`);
      console.warn('[run-suite]   prior measurements are NOT comparable — consider a fresh checkpoint, not --resume.');
   } else if (prior?.environment) {
      console.log(`[run-suite] server config unchanged vs ${PRIOR_RUN} (resume-safe).`);
   }
}

// Each invocation is its own immutable run directory (results/runs/<run_id>/).
// run.append() stamps run_id/ts and mirrors the row into the manifest.
// Skipped for --dry-run so a discarded invocation never leaves a stray 'running' dir.
const run = DRY_RUN
   ? null
   : createRun(RESULTS_DIR, {
        host: TARGET,
        gpu: GPU,
        backend: BACKEND,
        date: new Date(),
        kind: 'suite',
        environment: ENVIRONMENT,
        extra: {
           filters: {
              models: FILTER_MODELS.length ? FILTER_MODELS : null,
              benches: FILTER_BENCHES.length ? FILTER_BENCHES : null,
              skip_think: SKIP_THINK,
              skip_maxctx: SKIP_MAXCTX,
              maxctx_recheck: MAXCTX_RECHECK,
           },
        },
     });

// Resume key = the row identity (model, think, bench). Each run is single-host/backend,
// so target/backend don't need to be part of the key.
function tsvKey(model, think, bench) {
   return `${model}\t${think}\t${bench}`;
}

// --resume seeds done-keys from a prior run (--resume-from <run_id>, else the latest
// run) since each invocation now writes a fresh directory rather than appending.
function loadDoneKeys() {
   const seedId = flags['resume-from'] ?? PRIOR_RUN;
   if (!seedId) {
      return new Set();
   }
   const seed = readRun(RESULTS_DIR, seedId);
   if (!seed) {
      console.warn(`[run-suite] --resume: seed run not found (${seedId}); nothing to skip.`);
      return new Set();
   }
   console.log(`[run-suite] --resume: skipping combos already ok in ${seedId}`);
   const done = new Set();
   for (const r of seed.results) {
      if (r.status !== 'ok') {
         continue;
      }
      // The speed bench writes four granular rows (speed_short, speed_long-32k,
      // speed_prefill-4k, speed_prefill-12k) but the run loop checks a single 'speed'
      // resume key — collapse them so a completed speed pass is recognised as done.
      const bench = r.bench.startsWith('speed_') ? 'speed' : r.bench;
      done.add(`${r.model}\t${r.think}\t${bench}`);
   }
   return done;
}

/**
 * The full set of resume keys a model would produce in this run — mirrors the bench
 * dispatch gating in the model loop below (capability gates, think-mode gates,
 * once-only benches). Lets --resume skip a fully-completed model BEFORE the slow
 * max-ctx ladder probe + server start, instead of probing then skipping each bench.
 * Must stay in sync with the dispatch; an over-broad key here is safe (we just re-probe),
 * a missing key is not (we'd skip a model with outstanding work).
 */
function plannedResumeKeys(model) {
   const keys = new Set();
   const allow = (b) => (model.benches ?? []).includes(b) && (!FILTER_BENCHES.length || FILTER_BENCHES.includes(b));
   const thinkModes = getThinkModes(model).filter((t) => !(SKIP_THINK && t === true));
   const mid = modelId(model, null);
   if (allow('maxctx')) {
      keys.add(tsvKey(mid, '-', 'maxctx')); // think-independent, recorded once
   }
   thinkModes.forEach((thinkState, i) => {
      const tl = thinkState === null ? 'n/a' : thinkState ? 'think' : 'no_think';
      const passId = modelId(model, thinkState);
      // Benches gated only by the model's benches list — run in every think pass.
      for (const b of ['triage', 'reasoning', 'docqa', 'coding_multipl', 'summarization', 'speed']) {
         if (allow(b)) {
            keys.add(tsvKey(passId, tl, b));
         }
      }
      if (model.tools && allow('toolcalling')) {
         keys.add(tsvKey(passId, tl, 'toolcalling'));
      }
      // toolcalling_decay: tools-only, no-think, first pass only (KV-independent).
      if (model.tools && thinkState !== true && i === 0 && allow('toolcalling_decay')) {
         keys.add(tsvKey(passId, 'no_think', 'toolcalling_decay'));
      }
      // longctx: non-think passes only.
      if (thinkState !== true && allow('longctx')) {
         keys.add(tsvKey(passId, tl, 'longctx'));
      }
   });
   return keys;
}

function appendTsv(row) {
   run.append(row);
}

// promptfoo JSON accumulator (compatible with `npx promptfoo view`)
const pfResults = [];
function recordPf({ bench, model, think, vars, promptRaw, output, gradingResult, latencyMs, tokS }) {
   const tl = think === null ? 'n/a' : think ? 'think' : 'no_think';
   pfResults.push({
      provider: { id: `llamacpp:${modelId(model)}`, label: `${model.label} [${tl}]` },
      prompt: { raw: promptRaw, label: bench },
      vars,
      response: { output, metadata: { tok_per_sec: tokS } },
      gradingResult,
      success: gradingResult?.pass ?? false,
      score: gradingResult?.score ?? 0,
      latencyMs: latencyMs ?? 0,
   });
}

function flushPfJson() {
   if (!pfResults.length) {
      return;
   }
   const ts = new Date().toISOString().replace(/[:.]/g, '-');
   const out = join(RESULTS_DIR, `run-${ts}.json`);
   const s = pfResults.filter((r) => r.success).length;
   const f = pfResults.filter((r) => !r.success).length;
   writeFileSync(
      out,
      JSON.stringify(
         {
            results: {
               version: 3,
               timestamp: new Date().toISOString(),
               results: pfResults,
               stats: { successes: s, failures: f, errors: 0 },
            },
            config: { description: `llm-bench target=${TARGET} backend=${BACKEND}` },
         },
         null,
         2,
      ),
   );
   console.log(`\n[run-suite] promptfoo JSON → ${out}`);
}

// ── Bench runners ──────────────────────────────────────────────────────────────

async function runTriage(client, model, thinkState) {
   const sampling = sampleOpts(model, thinkState, 'triage');
   const thinkControl = model.think_control ?? 'enable_thinking';
   const maxTok = thinkState === true ? MAX_TOKENS.think : MAX_TOKENS.instruct;
   const itemResults = [];
   let halls = 0,
      jsonFail = 0,
      totalMs = 0;
   const tokList = [];

   for (const item of GOLDEN) {
      const messages = [
         { role: 'system', content: TRIAGE_STATIC_PROMPT },
         { role: 'user', content: `Title: ${item.title}\nContent preview:\n${item.content_preview}` },
      ];
      const t0 = Date.now();
      let completion;
      try {
         const res = await client.chat(messages, {
            think: thinkState,
            thinkControl,
            // JSON grammar blocks <think> tokens — omit in think mode; grader strips think first
            responseFormat: thinkState === true || model.no_schema ? null : TRIAGE_SCHEMA,
            max_tokens: maxTok,
            ...sampling,
         });
         completion = res.completion;
      } catch (e) {
         console.error(`    triage error on ${item.id}: ${e.message.slice(0, 80)}`);
         itemResults.push({ item, grade: { scores: {}, parsedOk: false, anchorHallucination: false } });
         jsonFail++;
         continue;
      }
      const latencyMs = Date.now() - t0;
      totalMs += latencyMs;
      const raw = completion.choices?.[0]?.message?.content ?? '';
      const tps = client.tokPerSec();
      if (tps) {
         tokList.push(tps);
      }
      warnRunaway('triage', item.id, completion);
      const grade = triageGradeOne(item, raw);
      if (grade.anchorHallucination) {
         halls++;
      }
      if (!grade.parsedOk) {
         jsonFail++;
      }
      itemResults.push({ item, grade, tps, latencyMs });
      recordPf({
         bench: 'triage',
         model,
         think: thinkState,
         vars: { item_id: item.id },
         promptRaw: messages[1].content,
         output: raw,
         gradingResult: triageGrader(raw, { vars: { item_id: item.id } }),
         latencyMs,
         tokS: tps?.toFixed(1),
      });
   }

   const { perRule } = triageComputeScore(itemResults);
   const avgTps = tokList.length ? tokList.reduce((a, b) => a + b, 0) / tokList.length : 0;
   // score omitted — computed from sub-scores at analysis time in scoring.mjs.
   return {
      triage_R1: perRule.R1 ?? null,
      triage_R2: perRule.R2 ?? null,
      triage_R3: perRule.R3 ?? null,
      triage_R4: perRule.R4 ?? null,
      triage_R5: perRule.R5 ?? null,
      triage_R6: perRule.R6 ?? null,
      triage_R7: perRule.R7 ?? null,
      triage_C1: perRule.C1 ?? null,
      triage_C2: perRule.C2 ?? null,
      halls,
      json_fail: jsonFail,
      tok_s: avgTps.toFixed(1),
      wall_s: (totalMs / 1000).toFixed(0),
   };
}

async function runReasoning(client, model, thinkState) {
   const sampling = sampleOpts(model, thinkState, 'reasoning');
   const thinkControl = model.think_control ?? 'enable_thinking';
   const ANSWER_SCHEMA = { type: 'object', properties: { answer: { type: 'string' } }, required: ['answer'] };
   const SYSTEM =
      'Solve the reasoning problem. Think step by step.\nRespond ONLY with JSON: {"answer": "<final answer — a number or single word>"}.';

   let correct = 0,
      errors = 0,
      totalMs = 0;
   const tokList = [];

   for (const [caseId, caseData] of Object.entries(REASON_CASES)) {
      const q = caseData.question ?? caseData;
      const messages = [
         { role: 'system', content: SYSTEM },
         { role: 'user', content: q },
      ];
      const maxTok = thinkState === true ? MAX_TOKENS.think : MAX_TOKENS.reasoning;
      const t0 = Date.now();
      let completion;
      try {
         const res = await client.chat(messages, {
            think: thinkState,
            thinkControl,
            responseFormat: thinkState === true || model.no_schema ? null : ANSWER_SCHEMA,
            max_tokens: maxTok,
            ...sampling,
         });
         completion = res.completion;
      } catch {
         errors++;
         continue;
      }
      totalMs += Date.now() - t0;
      const tps = client.tokPerSec();
      if (tps) {
         tokList.push(tps);
      }
      const raw = completion.choices?.[0]?.message?.content ?? '';
      warnRunaway('reasoning', caseId, completion);
      const gradingResult = reasoningGrader(stripThink(raw), { vars: { case_id: caseId } });
      if (gradingResult.pass) {
         correct++;
      }
      recordPf({
         bench: 'reasoning',
         model,
         think: thinkState,
         vars: { case_id: caseId, question: q },
         promptRaw: q,
         output: raw,
         gradingResult,
         latencyMs: 0,
         tokS: tps?.toFixed(1),
      });
   }

   const total = Object.keys(REASON_CASES).length;
   const avgTps = tokList.length ? tokList.reduce((a, b) => a + b, 0) / tokList.length : 0;
   // score omitted — derived from reasoning_correct / reasoning_total at analysis time.
   return {
      reasoning_correct: correct,
      reasoning_total: total,
      halls: '-',
      json_fail: errors,
      tok_s: avgTps.toFixed(1),
      wall_s: (totalMs / 1000).toFixed(0),
   };
}

async function runToolcalling(client, model, thinkState) {
   const sampling = sampleOpts(model, thinkState, 'toolcalling');
   const thinkControl = model.think_control ?? 'enable_thinking';
   const SYSTEM =
      'You are a helpful assistant with access to tools. Call a tool ONLY when needed. If no tool fits, respond in plain text WITHOUT calling any tool.';

   let pass = 0,
      totalMs = 0;

   for (const [caseId] of Object.entries(TOOL_CASES)) {
      const tc = TOOL_CASES[caseId];
      const userMsg = tc.user ?? caseId;
      const tools = (tc.tools ?? []).map((n) => TOOLS_POOL[n]).filter(Boolean);
      const messages = [
         { role: 'system', content: SYSTEM },
         { role: 'user', content: userMsg },
      ];
      const t0 = Date.now();
      let completion;
      try {
         const res = await client.chat(messages, {
            think: thinkState,
            thinkControl,
            tools,
            // think mode emits a reasoning block before the call → needs the larger budget
            max_tokens: thinkState === true ? MAX_TOKENS.think : MAX_TOKENS.tool,
            ...sampling,
         });
         completion = res.completion;
      } catch {
         continue;
      }
      totalMs += Date.now() - t0;

      const calls = completion.choices?.[0]?.message?.tool_calls ?? [];
      const output = JSON.stringify(calls);
      const gradingResult = toolGrader(output, { vars: { case_id: caseId } });
      if (gradingResult.pass) {
         pass++;
      }
      recordPf({
         bench: 'toolcalling',
         model,
         think: thinkState,
         vars: { case_id: caseId },
         promptRaw: userMsg,
         output,
         gradingResult,
         latencyMs: Date.now() - t0,
         tokS: null,
      });
   }

   const total = Object.keys(TOOL_CASES).length;
   // score omitted — derived from toolcall_pass / toolcall_total at analysis time.
   return { toolcall_pass: pass, toolcall_total: total, halls: '-', json_fail: '-', tok_s: '-', wall_s: (totalMs / 1000).toFixed(0) };
}

async function runSummarization(client, model, thinkState) {
   const sampling = sampleOpts(model, thinkState, 'summarization');
   const thinkControl = model.think_control ?? 'enable_thinking';
   const SYSTEM =
      'Summarize and categorize content for a personal knowledge vault.\nVault areas: craft (software, AI, hardware, PKM), finance (trading, markets), music (DJing, production), work (career, employer).\n\nRespond with JSON only:\n{"summary": "<1-2 sentence factual summary>", "area": "<craft|finance|music|work>", "tags": ["<area/subtag>", ...]}';

   let totalMs = 0,
      count = 0;
   const totals = { kw: 0, area: 0, tags: 0, length: 0 };

   for (const [caseId, item] of Object.entries(SUMM_ITEMS)) {
      const messages = [
         { role: 'system', content: SYSTEM },
         { role: 'user', content: `Title: ${item.title}\n\n${item.content}` },
      ];
      const t0 = Date.now();
      let completion;
      try {
         const res = await client.chat(messages, {
            think: thinkState,
            thinkControl,
            max_tokens: thinkState === true ? MAX_TOKENS.think : MAX_TOKENS.instruct,
            ...sampling,
         });
         completion = res.completion;
      } catch {
         continue;
      }
      totalMs += Date.now() - t0;
      const raw = stripThink(completion.choices?.[0]?.message?.content ?? '');
      const gradingResult = summGrader(raw, { vars: { case_id: caseId } });
      // Accumulate raw sub-scores; weighting happens at analysis time in scoring.mjs.
      const rs = gradingResult.rawScores ?? {};
      totals.kw += rs.kw ?? 0;
      totals.area += rs.area ?? 0;
      totals.tags += rs.tags ?? 0;
      totals.length += rs.length ?? 0;
      count++;
      recordPf({
         bench: 'summarization',
         model,
         think: thinkState,
         vars: { case_id: caseId },
         promptRaw: messages[1].content,
         output: raw,
         gradingResult,
         latencyMs: 0,
         tokS: null,
      });
   }

   return {
      // score is intentionally omitted — computed from sub-scores at analysis time.
      summ_kw: count ? totals.kw / count : null,
      summ_area: count ? totals.area / count : null,
      summ_tags: count ? totals.tags / count : null,
      summ_length: count ? totals.length / count : null,
      halls: '-',
      json_fail: '-',
      tok_s: '-',
      wall_s: (totalMs / 1000).toFixed(0),
   };
}

async function runDocqa(client, model, thinkState) {
   const sampling = sampleOpts(model, thinkState, 'docqa');
   const thinkControl = model.think_control ?? 'enable_thinking';
   const { docs, questions } = docqaCases;
   const docMap = Object.fromEntries((docs ?? []).map((d) => [d.id, d.source]));
   const answers = {};

   for (const q of questions ?? []) {
      const context = (q.doc_ids ?? [])
         .map((id) => docMap[id] ?? '')
         .filter(Boolean)
         .join('\n\n');
      const messages = [
         {
            role: 'system',
            content: 'Answer the question using ONLY the provided documents. Be precise and concise. Show your numerical work if needed.',
         },
         { role: 'user', content: `Documents:\n${context}\n\nQuestion: ${q.question}` },
      ];
      let completion;
      try {
         const res = await client.chat(messages, {
            think: thinkState,
            thinkControl,
            max_tokens: thinkState === true ? MAX_TOKENS.think : MAX_TOKENS.docqa,
            ...sampling,
         });
         completion = res.completion;
      } catch {
         answers[q.id] = '';
         continue;
      }
      const raw = stripThink(completion.choices?.[0]?.message?.content ?? '');
      warnRunaway('docqa', q.id, completion);
      answers[q.id] = raw;
   }

   const { per_question } = docqaGradeAll(questions ?? [], answers);
   const trapHits = per_question.filter((r) => r.trap_hits?.length > 0).length;
   const n = per_question.length || 1;
   const avgOf = (field) => per_question.reduce((s, q) => s + (q[field] ?? 0), 0) / n;
   // score omitted — derived from sub-scores at analysis time. Total per question = correctness+coverage+faithfulness (0–10).
   return {
      docqa_correctness: avgOf('correctness'),
      docqa_coverage: avgOf('coverage'),
      docqa_faithfulness: avgOf('faithfulness'),
      halls: trapHits,
      json_fail: '-',
      tok_s: '-',
      wall_s: '-',
   };
}

async function runCoding(
   client,
   model,
   thinkState,
   cases = CODING_MULTIPL_CASES,
   maxTok = MAX_TOKENS.coding_multipl,
   benchName = 'coding_multipl',
   thinkTok = MAX_TOKENS.think,
) {
   const sampling = sampleOpts(model, thinkState, 'coding');
   const thinkControl = model.think_control ?? 'enable_thinking';

   let passAt1 = 0,
      testsPassed = 0,
      testsTotal = 0,
      noCode = 0,
      totalMs = 0;
   const tokList = [];

   // Periodic progress for large imported sets (e.g. the 160-case MultiPL-E run),
   // which would otherwise sit silent for many minutes. Quiet for the small
   // hand-authored sets (≤ PROGRESS_EVERY cases → no interim lines).
   const totalCases = Object.keys(cases).length;
   const PROGRESS_EVERY = 20;
   const PROGRESS = totalCases > 30;
   if (PROGRESS) {
      console.log(`(${totalCases} cases — progress every ${PROGRESS_EVERY})`);
   }
   let caseIdx = 0;

   for (const [caseId, c] of Object.entries(cases)) {
      const SYSTEM =
         `You are an expert programmer. Implement the requested function in JavaScript.\n` +
         `Respond with ONLY one JavaScript code block defining \`${c.entry}\` — no prose, no tests, ` +
         `no example calls, no console.log. The function must \`return\` its result.`;
      const messages = [
         { role: 'system', content: SYSTEM },
         { role: 'user', content: `${c.prompt}\n\nSignature: ${c.signature}` },
      ];
      const t0 = Date.now();
      let completion;
      try {
         const res = await client.chat(messages, {
            think: thinkState,
            thinkControl,
            max_tokens: thinkState === true ? thinkTok : maxTok,
            ...sampling,
         });
         completion = res.completion;
      } catch {
         noCode++;
         continue;
      }
      totalMs += Date.now() - t0;
      const tps = client.tokPerSec();
      if (tps) {
         tokList.push(tps);
      }
      const raw = completion.choices?.[0]?.message?.content ?? '';
      warnRunaway(benchName, caseId, completion);
      const gradingResult = await codingGradeCase(c, raw);
      if (gradingResult.pass) {
         passAt1++;
      }
      if (gradingResult.reason?.startsWith('no-code')) {
         noCode++;
      }
      testsPassed += gradingResult.passed;
      testsTotal += gradingResult.total;
      caseIdx++;
      if (PROGRESS && (caseIdx % PROGRESS_EVERY === 0 || caseIdx === totalCases)) {
         const pa1 = ((passAt1 / caseIdx) * 100).toFixed(0);
         const tr = testsTotal ? ((testsPassed / testsTotal) * 100).toFixed(0) : '0';
         const elapsed = (totalMs / 1000).toFixed(0);
         const eta = caseIdx < totalCases ? ` eta~${(((totalMs / caseIdx) * (totalCases - caseIdx)) / 1000).toFixed(0)}s` : '';
         console.log(
            `    [${benchName}] ${caseIdx}/${totalCases}  pass@1=${pa1}%  tests=${tr}%  noCode=${noCode}  elapsed=${elapsed}s${eta}`,
         );
      }
      recordPf({
         bench: benchName,
         model,
         think: thinkState,
         vars: { case_id: caseId, category: c.category, difficulty: c.difficulty },
         promptRaw: c.prompt,
         output: raw,
         gradingResult,
         latencyMs: 0,
         tokS: tps?.toFixed(1),
      });
   }

   const total = Object.keys(cases).length;
   const avgTps = tokList.length ? tokList.reduce((a, b) => a + b, 0) / tokList.length : 0;
   // score/notes omitted — derived from raw counts at analysis time.
   return {
      coding_pass_at_1: passAt1,
      coding_total: total,
      coding_tests_passed: testsPassed,
      coding_tests_total: testsTotal,
      coding_no_code: noCode,
      halls: '-',
      tok_s: avgTps.toFixed(1),
      wall_s: (totalMs / 1000).toFixed(0),
   };
}

let _speedNonce = 0; // increments across passes to keep each prefill probe cache-cold
async function runSpeed(client) {
   const SHORT_PROMPT = 'Tell me a single short sentence about the sky.';
   const LONG_PROMPT =
      'Tell me about the history of computing. Be as comprehensive as possible and write at least 2000 words covering all major developments from ancient times to today.';
   const rows = [];

   for (const [label, prompt] of [
      ['short', SHORT_PROMPT],
      ['long-32k', LONG_PROMPT],
   ]) {
      const t0 = Date.now();
      let completion,
         prefillTps = null,
         decodeTps = null;
      try {
         const res = await client.chat([{ role: 'user', content: prompt }], {
            think: null,
            max_tokens: MAX_TOKENS.speed,
            temperature: 0.7,
         });
         completion = res.completion;
         decodeTps = client.tokPerSec();
         prefillTps = client.prefillTokPerSec();
      } catch (e) {
         console.error(`    speed/${label} error: ${e.message}`);
         rows.push({ label, error: e.message });
         continue;
      }
      rows.push({ label, decodeTps, prefillTps, wallMs: Date.now() - t0, tokens: completion.usage?.completion_tokens ?? 0 });
      // No runaway check here: the speed bench intentionally caps at max_tokens (150)
      // to time a fixed-size decode, and the long probe prompts for 2000 words so the
      // model fills that budget. finish_reason='length' is the expected stop, not a
      // divergence — warning on it (as other benches do) is a false positive.
   }

   // Real prefill throughput on large prompts. The short/long runs above use tiny
   // prompts (~10–30 tokens), so their prefill_tps is dominated by fixed overhead
   // and not representative. Here we prefill a large synthetic codebase prompt and
   // read the prompt-processing rate (max_tokens tiny — we only want prefill).
   // Requires the server ctx ≥ the largest prompt (run with --skip-maxctx --ctx 16384).
   for (const promptTokens of [4096, 12288]) {
      const label = `prefill-${Math.round(promptTokens / 1024)}k`;
      try {
         const built = makeFillPrompt(promptTokens);
         // Bust the server KV prefix cache: makeFillPrompt is deterministic, so the
         // identical prompt across think/no_think passes would cache-hit and report
         // a bogus (tiny-processed) prefill rate. A unique leading nonce forces a
         // full fresh prefill every time.
         const um = built.messages[built.messages.length - 1];
         _speedNonce += 1;
         um.content = `// prefill probe ${_speedNonce}\n${um.content}`;
         await client.chat(built.messages, { think: null, max_tokens: 8, temperature: 0.0 }, 300_000);
         rows.push({ label, decodeTps: client.tokPerSec(), prefillTps: client.prefillTokPerSec() });
      } catch (e) {
         console.error(`    speed/${label} error: ${e.message}`);
         rows.push({ label, error: e.message });
      }
   }
   return rows;
}

// ── Smoke gate ──────────────────────────────────────────────────────────────────

/**
 * Fast per-model validation before the full bench run.
 * Steps: health → short gen → triage JSON (1 item) → tool call (1 case).
 * Returns { ok: boolean, failStep: string|null }
 */
async function smokePasses(client, model) {
   // 1. Health (503-aware already handled by waitHealthy before this, but one more check)
   try {
      await client.waitHealthy(5_000);
   } catch {
      return { ok: false, failStep: 'health' };
   }

   // 2. Short generation (confirms decode). Disable thinking on hybrid models so the
   //    answer lands in `content`; always-thinking models emit reasoning_content, which
   //    we also accept as proof of decode.
   try {
      const thinkState = model.think === 'optional' ? false : null;
      const thinkControl = model.think_control ?? 'enable_thinking';
      const { completion } = await client.chat(
         [{ role: 'user', content: 'Say "ready" and nothing else.' }],
         { think: thinkState, thinkControl, max_tokens: 64, temperature: 0.0 },
         15_000,
      );
      const msg = completion.choices?.[0]?.message ?? {};
      const text = `${msg.content ?? ''}${msg.reasoning_content ?? ''}`;
      if (!text.trim()) {
         return { ok: false, failStep: 'short-gen:empty' };
      }
   } catch (e) {
      return { ok: false, failStep: `short-gen:${e.message.slice(0, 40)}` };
   }

   // 3. Triage JSON (1 item, confirms response_format + JSON parsing). Retry a few
   //    times: a single item at the model's sampling temperature can probabilistically
   //    omit a field, and one unlucky generation shouldn't skip the entire model.
   if ((model.benches ?? []).includes('triage')) {
      const item = GOLDEN[0];
      // Mirror the bench's first think pass: hybrid → false (schema needs thinking
      // off), required → true, others → null. A live JSON grammar blocks think tokens.
      const thinkState = thinkStates(capabilityClass(model))[0];
      const thinkControl = model.think_control ?? 'enable_thinking';
      let lastFail = 'triage-json:no-action';
      let ok = false;
      for (let attempt = 0; attempt < 3 && !ok; attempt++) {
         try {
            const { completion } = await client.chat(
               [
                  { role: 'system', content: TRIAGE_STATIC_PROMPT },
                  { role: 'user', content: `Title: ${item.title}\nContent preview:\n${item.content_preview}` },
               ],
               { think: thinkState, thinkControl, responseFormat: thinkState || model.no_schema ? null : TRIAGE_SCHEMA, max_tokens: 256 },
               30_000,
            );
            const raw = completion.choices?.[0]?.message?.content ?? '';
            const parsed = extractJson(stripThink(raw));
            if (parsed?.proposed_action) {
               ok = true;
            } else {
               lastFail = 'triage-json:no-action';
            }
         } catch (e) {
            lastFail = `triage-json:${e.message.slice(0, 40)}`;
         }
      }
      if (!ok) {
         return { ok: false, failStep: lastFail };
      }
   }

   // 4. Tool call (1 case, confirms tools + single-step response)
   if (model.tools) {
      const firstCase = Object.entries(TOOL_CASES).find(([, tc]) => tc.tools?.length > 0);
      if (firstCase) {
         const [, tc] = firstCase;
         const tools = (tc.tools ?? []).map((n) => TOOLS_POOL[n]).filter(Boolean);
         const thinkControl = model.think_control ?? 'enable_thinking';
         try {
            const { completion } = await client.chat(
               [
                  { role: 'system', content: 'Call a tool when asked.' },
                  { role: 'user', content: tc.user ?? 'What is the weather in London?' },
               ],
               { think: false, thinkControl, tools, max_tokens: MAX_TOKENS.tool },
               30_000,
            );
            // Smoke only checks we didn't get an exception — not grading
            if (!completion?.choices?.[0]) {
               return { ok: false, failStep: 'tool-call:no-choice' };
            }
         } catch (e) {
            return { ok: false, failStep: `tool-call:${e.message.slice(0, 40)}` };
         }
      }
   }

   return { ok: true, failStep: null };
}

// ── Dry-run ────────────────────────────────────────────────────────────────────
function dryRun() {
   const models = filterModels();
   console.log(`\nDry-run — target=${TARGET}  backend=${BACKEND}  LLAMA_URL=${LLAMA_URL}\n`);
   console.log(`${models.length} models\n`);

   for (const m of models) {
      const b = (m.benches ?? []).filter((x) => !FILTER_BENCHES.length || FILTER_BENCHES.includes(x));
      const thinkModes = getThinkModes(m)
         .filter((t) => !(SKIP_THINK && t === true)) // mirror the real run loop's --skip-think filter
         .map((t) => (t === null ? 'n/a' : t ? 'think' : 'no_think'));
      console.log(`  ${(m.label ?? modelId(m, null)).padEnd(55)} think=[${thinkModes.join(',')}]  benches=[${b.join(',')}]`);
   }
   console.log(`\nTotal models: ${models.length}`);
}

if (DRY_RUN) {
   dryRun();
   process.exit(0);
}

// ── Main ──────────────────────────────────────────────────────────────────────
const { llamacppServer, extraFlagsToString } = await import('./llamacpp-server.mjs');
const srv = llamacppServer({ sshHost: SSH_HOST, llamaUrl: LLAMA_URL, backend: BACKEND, debug: DEBUG });
const client = srv.client;

const models = filterModels();
const doneKeys = flags.resume ? loadDoneKeys() : new Set();

// Seed prior max-ctx ceilings for --maxctx-recheck (extreme-only re-validation).
// Keyed by base model id (hf_file minus .gguf — matches the row `model` field).
const recheckSeeds = new Map();
if (MAXCTX_RECHECK) {
   const seedId = flags['recheck-from'] ?? latestRun(RESULTS_DIR);
   const seed = seedId ? readRun(RESULTS_DIR, seedId) : null;
   if (!seed) {
      console.error(`[run-suite] --maxctx-recheck needs a seed run; none found (${seedId ?? 'no runs'}).`);
      process.exit(1);
   }
   for (const row of seed.results) {
      if (row.bench === 'maxctx') {
         const c = Number(row.coherence_ceiling ?? row.ctx_loaded);
         if (Number.isFinite(c) && c > 0) {
            recheckSeeds.set(row.model, c);
         }
      }
   }
   console.log(`[run-suite] maxctx-recheck: seeded ${recheckSeeds.size} prior ceilings from ${seedId}`);
}

if (!models.length) {
   console.error('[run-suite] No models matched filter. Exiting.');
   process.exit(1);
}

// Kill any orphaned server before starting
console.log('[run-suite] sweeping remote for orphaned llama-server processes...');
await srv.killAll();

// SIGINT / SIGTERM handler
async function shutdown(sig) {
   console.log(`\n[run-suite] ${sig} received — stopping remote server...`);
   run?.finalize('aborted'); // mark the run incomplete so its partial rows aren't taken as a full run
   flushPfJson();
   await srv.killAll().catch(() => {});
   process.exit(1);
}
process.on('SIGINT', () => shutdown('SIGINT'));
process.on('SIGTERM', () => shutdown('SIGTERM'));

console.log(`\n[run-suite] ${models.length} models  target=${TARGET}  backend=${BACKEND}  LLAMA_URL=${LLAMA_URL}  SSH=${SSH_HOST}\n`);

// ─────────────────────────────────────────────────────────────────────────────
for (const model of models) {
   const mid = modelId(model, null); // base ID (used for load/OOM error rows)
   // --skip-think drops the think=true pass (keeps no_think/null) for a fast partial run.
   const thinkModes = getThinkModes(model).filter((t) => !(SKIP_THINK && t === true));
   const benches = (model.benches ?? []).filter((b) => !FILTER_BENCHES.length || FILTER_BENCHES.includes(b));

   // --resume: if every planned (model,think,bench) is already ok in the seed run, skip
   // the model BEFORE the slow max-ctx ladder probe + server start — not after, which
   // is what made a resumed run re-probe every already-completed model.
   if (flags.resume) {
      const planned = plannedResumeKeys(model);
      if (planned.size && [...planned].every((k) => doneKeys.has(k))) {
         console.log(`\n${'═'.repeat(70)}`);
         console.log(`  ${model.label ?? mid} — all benches already done; skipping (no max-ctx probe)`);
         continue;
      }
   }

   console.log(`\n${'═'.repeat(70)}`);
   console.log(`  ${model.label ?? modelId(model, null)}`);
   console.log('═'.repeat(70));
   console.log(`[model-start] ${model.label ?? modelId(model, null)}`);

   // ── Max-ctx ladder probe (128/100/64/32/16k) ─────────────────────────────
   let ctxLoaded, oomCeiling, coherenceCeiling, vramMib;
   if (MAXCTX_RECHECK) {
      // Extreme-only re-validation: probe AT the prior ceiling under the current
      // config; step down only if it now OOMs. No full binary search.
      const seed = recheckSeeds.get(mid);
      if (!seed) {
         console.log(`  [maxctx] recheck: no prior ceiling for ${mid} — falling back to full search`);
         try {
            ({ ctxLoaded, oomCeiling, coherenceCeiling, vramMib } = await srv.startForModel(model));
         } catch (e) {
            console.error(`  [error] max-ctx probe failed: ${e.message}`);
            continue;
         }
      } else {
         let held, probes;
         ({ ctxLoaded, oomCeiling, coherenceCeiling, vramMib, held, probes } = await srv.probeCeiling(model, seed));
         console.log(
            `  [maxctx] recheck ${held ? 'HELD' : 'CHANGED'}: ${seed} → ${ctxLoaded} ` +
               `(oom=${oomCeiling}, vram=${vramMib ?? '?'}MiB, ${probes} probe${probes === 1 ? '' : 's'})`,
         );
      }
   } else if (SKIP_MAXCTX) {
      // --ctx forces a fixed window (skips the slow search) — used by the speed-only
      // re-run so the server starts fast at a size that fits every model.
      ctxLoaded = flags.ctx ? Number(flags.ctx) : (model.ctx_cap ?? model.native_max_ctx ?? 8192);
      oomCeiling = ctxLoaded;
      coherenceCeiling = ctxLoaded;
      console.log(`  [maxctx] skipped — using ${ctxLoaded} (${flags.ctx ? '--ctx' : 'ctx_cap or native_max_ctx'})`);
   } else {
      try {
         ({ ctxLoaded, oomCeiling, coherenceCeiling, vramMib } = await srv.startForModel(model));
      } catch (e) {
         console.error(`  [error] max-ctx probe failed: ${e.message}`);
         appendTsv({
            target: TARGET,
            backend: BACKEND,
            model: mid,
            think: '-',
            bench: 'load',
            score: '?',
            halls: '-',
            json_fail: '-',
            tok_s: '-',
            prefill_tps: '-',
            vram_mib: '-',
            ctx_loaded: '-',
            oom_ceiling: '-',
            coherence_ceiling: '-',
            status: `error:${e.message.slice(0, 60)}`,
            wall_s: '-',
            notes: '',
         });
         continue;
      }
   }

   // Record maxctx result
   if (benches.includes('maxctx')) {
      const key = tsvKey(mid, '-', 'maxctx');
      if (!(flags.resume && doneKeys.has(key))) {
         console.log(
            `  [maxctx] ${ctxLoaded?.toLocaleString()} tokens  oom=${oomCeiling}  coherence=${coherenceCeiling}  vram=${vramMib ?? '?'}MiB`,
         );
         appendTsv({
            target: TARGET,
            backend: BACKEND,
            model: mid,
            think: '-',
            bench: 'maxctx',
            score: ctxLoaded ?? '?',
            halls: '-',
            json_fail: '-',
            tok_s: '-',
            prefill_tps: '-',
            vram_mib: vramMib ?? '?',
            ctx_loaded: ctxLoaded ?? '?',
            oom_ceiling: oomCeiling ?? '?',
            coherence_ceiling: coherenceCeiling ?? '?',
            status: 'ok',
            wall_s: '-',
            notes: '',
         });
      }
   }

   // ── Start real server at discovered ctx ───────────────────────────────────
   if (!SKIP_MAXCTX) {
      // startForModel already left the server running at ctxLoaded; no restart needed.
      // The binary-search probe calls stop after each probe, then startForModel restarts.
      // If we're here, the server should already be up. Just verify.
      const alive = await client
         .waitHealthy(5_000)
         .then(() => true)
         .catch(() => false);
      if (!alive) {
         try {
            await srv.startServer({
               hf_repo: model.hf_repo,
               hf_file: model.hf_file,
               ctx: ctxLoaded,
               extraFlags: extraFlagsToString(model.extra_flags),
            });
            await srv.waitHealthy(120_000);
         } catch (e) {
            console.error(`  [error] server failed to restart for bench pass: ${e.message}`);
            continue;
         }
      }
   } else {
      // SKIP_MAXCTX: need to start the server fresh
      try {
         await srv.startServer({
            hf_repo: model.hf_repo,
            hf_file: model.hf_file,
            ctx: ctxLoaded,
            extraFlags: extraFlagsToString(model.extra_flags),
         });
         await srv.waitHealthy(360_000);
         vramMib = await srv.snapshotVram();
      } catch (e) {
         console.error(`  [error] server start failed: ${e.message}`);
         appendTsv({
            target: TARGET,
            backend: BACKEND,
            model: mid,
            think: '-',
            bench: 'load',
            score: '?',
            halls: '-',
            json_fail: '-',
            tok_s: '-',
            prefill_tps: '-',
            vram_mib: '-',
            ctx_loaded: '-',
            oom_ceiling: '-',
            coherence_ceiling: '-',
            status: `error:${e.message.slice(0, 60)}`,
            wall_s: '-',
            notes: '',
         });
         continue;
      }
   }

   // ── Per-model smoke gate ───────────────────────────────────────────────────
   const { ok: smokeOk, failStep } = await smokePasses(client, model);
   if (!smokeOk) {
      console.error(`  [smoke] FAIL step=${failStep} — skipping all benches for this model`);
      appendTsv({
         target: TARGET,
         backend: BACKEND,
         model: mid,
         think: '-',
         bench: 'smoke',
         score: '0',
         halls: '-',
         json_fail: '-',
         tok_s: '-',
         prefill_tps: '-',
         vram_mib: vramMib ?? '?',
         ctx_loaded: ctxLoaded ?? '?',
         oom_ceiling: oomCeiling ?? '?',
         coherence_ceiling: coherenceCeiling ?? '?',
         status: `error:smoke:${failStep}`,
         wall_s: '-',
         notes: '',
      });
      await srv.stopServer();
      await srv.waitVramClear();
      continue;
   }
   console.log(`  [smoke] PASS`);

   // ── model._ctxLoaded (for ensureAlive restarts) ───────────────────────────
   model._ctxLoaded = ctxLoaded;

   // ── Bench passes ──────────────────────────────────────────────────────────
   for (const thinkState of thinkModes) {
      const tl = thinkState === null ? 'n/a' : thinkState ? 'think' : 'no_think';
      // Per-pass ID: appends --think/--nothi suffix for hybrid models
      const passId = modelId(model, thinkState);

      // Helper: skip if already done, check server alive
      async function skipOrRun(benchName, fn) {
         if (FILTER_BENCHES.length && !FILTER_BENCHES.includes(benchName)) {
            return;
         }
         if (!benches.includes(benchName)) {
            return;
         }
         const key = tsvKey(passId, tl, benchName);
         if (flags.resume && doneKeys.has(key)) {
            console.log(`  [${benchName} ${tl}] skip`);
            return;
         }
         const { alive } = await srv.ensureAlive(model);
         if (!alive) {
            console.error(`  [${benchName} ${tl}] server dead — skipping`);
            return;
         }

         process.stdout.write(`  [${benchName} ${tl}] `);
         const t0 = Date.now();
         let r;
         try {
            r = await fn();
         } catch (e) {
            console.error(`error: ${e.message}`);
            appendTsv({
               target: TARGET,
               backend: BACKEND,
               model: passId,
               think: tl,
               bench: benchName,
               score: '?',
               halls: '-',
               json_fail: '-',
               tok_s: '-',
               prefill_tps: '-',
               vram_mib: vramMib ?? '?',
               ctx_loaded: ctxLoaded ?? '?',
               oom_ceiling: oomCeiling ?? '?',
               coherence_ceiling: coherenceCeiling ?? '?',
               status: `error:${e.message.slice(0, 60)}`,
               wall_s: ((Date.now() - t0) / 1000).toFixed(0),
               notes: '',
            });
            return;
         }
         const curVram = await srv.snapshotVram();
         return { r, curVram, wallS: ((Date.now() - t0) / 1000).toFixed(0) };
      }

      // triage
      {
         const res = await skipOrRun('triage', () => runTriage(client, model, thinkState));
         if (res) {
            console.log(`halls=${res.r.halls}  json_fail=${res.r.json_fail}  tok/s=${res.r.tok_s}  vram=${res.curVram ?? '?'}MiB`);
            appendTsv({
               target: TARGET,
               backend: BACKEND,
               model: passId,
               think: tl,
               bench: 'triage',
               prefill_tps: '-',
               vram_mib: res.curVram ?? '?',
               ctx_loaded: ctxLoaded ?? '?',
               oom_ceiling: oomCeiling ?? '?',
               coherence_ceiling: coherenceCeiling ?? '?',
               status: 'ok',
               ...res.r,
            });
         }
      }

      // reasoning
      {
         const res = await skipOrRun('reasoning', () => runReasoning(client, model, thinkState));
         if (res) {
            console.log(`accuracy=${res.r.reasoning_correct}/${res.r.reasoning_total}  tok/s=${res.r.tok_s}`);
            appendTsv({
               target: TARGET,
               backend: BACKEND,
               model: passId,
               think: tl,
               bench: 'reasoning',
               prefill_tps: '-',
               vram_mib: vramMib ?? '?',
               ctx_loaded: ctxLoaded ?? '?',
               oom_ceiling: oomCeiling ?? '?',
               coherence_ceiling: coherenceCeiling ?? '?',
               status: 'ok',
               ...res.r,
            });
         }
      }

      // toolcalling — runs in every think pass (Qwen3/GLM/Gemma4 support tool use
      // while thinking; see vendor docs). Capability gate (model.tools) still applies.
      if (model.tools) {
         const res = await skipOrRun('toolcalling', () => runToolcalling(client, model, thinkState));
         if (res) {
            console.log(`accuracy=${res.r.toolcall_pass}/${res.r.toolcall_total}`);
            appendTsv({
               target: TARGET,
               backend: BACKEND,
               model: passId,
               think: tl,
               bench: 'toolcalling',
               prefill_tps: '-',
               vram_mib: vramMib ?? '?',
               ctx_loaded: ctxLoaded ?? '?',
               oom_ceiling: oomCeiling ?? '?',
               coherence_ceiling: coherenceCeiling ?? '?',
               status: 'ok',
               ...res.r,
            });
         }
      }

      // docqa — runs in both think and no-think passes
      {
         const res = await skipOrRun('docqa', () => runDocqa(client, model, thinkState));
         if (res) {
            const docqaTotal = (res.r.docqa_correctness ?? 0) + (res.r.docqa_coverage ?? 0) + (res.r.docqa_faithfulness ?? 0);
            console.log(`mean=${docqaTotal.toFixed(2)}/10  trap_hits=${res.r.halls}`);
            appendTsv({
               target: TARGET,
               backend: BACKEND,
               model: passId,
               think: tl,
               bench: 'docqa',
               prefill_tps: '-',
               vram_mib: vramMib ?? '?',
               ctx_loaded: ctxLoaded ?? '?',
               oom_ceiling: oomCeiling ?? '?',
               coherence_ceiling: coherenceCeiling ?? '?',
               status: 'ok',
               ...res.r,
               wall_s: res.wallS, // runDocqa doesn't measure wall time; skipOrRun's timer is authoritative
            });
         }
      }

      // coding_multipl — execution-graded JS (imported MultiPL-E / HumanEval-JS); the sole
      // coding source. Runs in both think and no-think passes.
      {
         const res = await skipOrRun('coding_multipl', () =>
            runCoding(
               client,
               model,
               thinkState,
               CODING_MULTIPL_CASES,
               MAX_TOKENS.coding_multipl,
               'coding_multipl',
               MAX_TOKENS.coding_multipl_think,
            ),
         );
         if (res) {
            const p1pct = res.r.coding_total > 0 ? ((res.r.coding_pass_at_1 / res.r.coding_total) * 100).toFixed(1) : '?';
            const testsPct = res.r.coding_tests_total > 0 ? ((res.r.coding_tests_passed / res.r.coding_tests_total) * 100).toFixed(1) : '?';
            console.log(`pass@1=${p1pct}%  tests=${testsPct}%  noCode=${res.r.coding_no_code}  tok/s=${res.r.tok_s}`);
            appendTsv({
               target: TARGET,
               backend: BACKEND,
               model: passId,
               think: tl,
               bench: 'coding_multipl',
               prefill_tps: '-',
               vram_mib: vramMib ?? '?',
               ctx_loaded: ctxLoaded ?? '?',
               oom_ceiling: oomCeiling ?? '?',
               coherence_ceiling: coherenceCeiling ?? '?',
               status: 'ok',
               ...res.r,
            });
         }
      }

      // summarization — runs in both think and no-think passes
      {
         const res = await skipOrRun('summarization', () => runSummarization(client, model, thinkState));
         if (res) {
            console.log(`kw=${res.r.summ_kw?.toFixed(2)}  area=${res.r.summ_area?.toFixed(2)}  tags=${res.r.summ_tags?.toFixed(2)}`);
            appendTsv({
               target: TARGET,
               backend: BACKEND,
               model: passId,
               think: tl,
               bench: 'summarization',
               prefill_tps: '-',
               vram_mib: vramMib ?? '?',
               ctx_loaded: ctxLoaded ?? '?',
               oom_ceiling: oomCeiling ?? '?',
               coherence_ceiling: coherenceCeiling ?? '?',
               status: 'ok',
               ...res.r,
            });
         }
      }
      if (benches.includes('speed') && (!FILTER_BENCHES.length || FILTER_BENCHES.includes('speed'))) {
         const key = tsvKey(passId, tl, 'speed');
         if (flags.resume && doneKeys.has(key)) {
            console.log(`  [speed ${tl}] skip`);
         } else {
            const { alive } = await srv.ensureAlive(model);
            if (alive) {
               process.stdout.write(`  [speed ${tl}] `);
               const speedRows = await runSpeed(client).catch((e) => {
                  console.error(`error: ${e.message}`);
                  return [];
               });
               for (const sr of speedRows) {
                  if (sr.error) {
                     continue;
                  }
                  const decodeTps = sr.decodeTps?.toFixed(1) ?? '-';
                  const prefTps = sr.prefillTps?.toFixed(1) ?? '-';
                  console.log(`${sr.label}: decode=${decodeTps} tok/s  prefill=${prefTps} tok/s`);
                  appendTsv({
                     target: TARGET,
                     backend: BACKEND,
                     model: passId,
                     think: tl,
                     bench: `speed_${sr.label}`,
                     score: decodeTps,
                     halls: '-',
                     json_fail: '-',
                     tok_s: decodeTps,
                     prefill_tps: prefTps,
                     vram_mib: vramMib ?? '?',
                     ctx_loaded: ctxLoaded ?? '?',
                     oom_ceiling: oomCeiling ?? '?',
                     coherence_ceiling: coherenceCeiling ?? '?',
                     status: 'ok',
                     wall_s: '-',
                     notes: `prefill_tps=${prefTps}`,
                  });
               }
            }
         }
      }

      // toolcalling_decay — no-think mode only, once per model (KV-independent)
      if (model.tools && thinkState !== true && thinkModes.indexOf(thinkState) === 0) {
         if (benches.includes('toolcalling_decay') && (!FILTER_BENCHES.length || FILTER_BENCHES.includes('toolcalling_decay'))) {
            const key = tsvKey(passId, 'no_think', 'toolcalling_decay');
            if (flags.resume && doneKeys.has(key)) {
               console.log(`  [toolcalling_decay] skip`);
            } else {
               const { alive } = await srv.ensureAlive(model);
               if (alive) {
                  process.stdout.write(`  [toolcalling_decay] `);
                  const t0 = Date.now();
                  const { stdout } = await execP('node', [join(ROOT, 'benchmarks/toolcalling/decay-bench.mjs'), passId], {
                     env: { ...process.env, LLAMA_URL },
                     timeout: 3_600_000,
                  }).catch((e) => ({ stdout: '', stderr: e.message }));
                  const decayRows = [...stdout.matchAll(/^\s+(\d+)\s+\d+\s+([\d.]+)%/gm)].map((m) => `r${m[1]}=${m[2]}%`);
                  const wall = ((Date.now() - t0) / 1000).toFixed(0);
                  console.log(decayRows.join(' ') || 'done');
                  appendTsv({
                     target: TARGET,
                     backend: BACKEND,
                     model: passId,
                     think: 'no_think',
                     bench: 'toolcalling_decay',
                     score: '-',
                     halls: '-',
                     json_fail: '-',
                     tok_s: '-',
                     prefill_tps: '-',
                     vram_mib: vramMib ?? '?',
                     ctx_loaded: ctxLoaded ?? '?',
                     oom_ceiling: oomCeiling ?? '?',
                     coherence_ceiling: coherenceCeiling ?? '?',
                     status: 'ok',
                     wall_s: wall,
                     notes: decayRows.join(' '),
                  });
               }
            }
         }
      }

      // longctx — passkey + multifact
      if (thinkState !== true) {
         if (benches.includes('longctx') && (!FILTER_BENCHES.length || FILTER_BENCHES.includes('longctx'))) {
            const key = tsvKey(passId, tl, 'longctx');
            if (flags.resume && doneKeys.has(key)) {
               console.log(`  [longctx] skip`);
            } else {
               const { alive } = await srv.ensureAlive(model);
               if (alive) {
                  process.stdout.write(`  [longctx] `);
                  const t0 = Date.now();
                  const llamaEnv = { ...process.env, LLAMA_URL };
                  const ctxArg = String(ctxLoaded ?? 24000);
                  const [pkOut, mfOut] = await Promise.all([
                     execP('node', [join(ROOT, 'benchmarks/longctx/passkey-bench.mjs'), ctxArg], { env: llamaEnv, timeout: 600_000 }).catch(
                        () => ({ stdout: '' }),
                     ),
                     execP('node', [join(ROOT, 'benchmarks/longctx/multifact-bench.mjs'), ctxArg], {
                        env: llamaEnv,
                        timeout: 600_000,
                     }).catch(() => ({ stdout: '' })),
                  ]);
                  const pkScore =
                     pkOut.stdout
                        .split('\n')
                        .find((l) => l.startsWith('RESULT\t'))
                        ?.split('\t')[4] ?? '?';
                  const mfScore =
                     mfOut.stdout
                        .split('\n')
                        .find((l) => l.startsWith('RESULT_MULTIFACT\t'))
                        ?.split('\t')[4] ?? '?';
                  const wall = ((Date.now() - t0) / 1000).toFixed(0);
                  console.log(`passkey=${pkScore}  multifact=${mfScore}`);
                  appendTsv({
                     target: TARGET,
                     backend: BACKEND,
                     model: passId,
                     think: tl,
                     bench: 'longctx',
                     score: pkScore,
                     halls: '-',
                     json_fail: '-',
                     tok_s: '-',
                     prefill_tps: '-',
                     vram_mib: vramMib ?? '?',
                     ctx_loaded: ctxLoaded ?? '?',
                     oom_ceiling: oomCeiling ?? '?',
                     coherence_ceiling: coherenceCeiling ?? '?',
                     status: 'ok',
                     wall_s: wall,
                     notes: `multifact=${mfScore}`,
                  });
               }
            }
         }
      }
   } // end thinkModes loop

   await srv.stopServer();
   await srv.waitVramClear();
} // end model loop

flushPfJson();
const finalStatus = run.finalize('complete'); // clean exit — the run covered its full matrix

// Build the summary report + chart. When resuming, merge this run with the run it
// resumed from so the report reflects base + catch-up (ts/status arbitrate overlaps).
const REPORT_JSON = join(RESULTS_DIR, 'report.json');
const CHART_SVG = join(RESULTS_DIR, 'chart.svg');

// --full: a "full run" is not full without the secondaries. The core suite alone
// leaves the fleet (VRAM-packing) chart and the e2e/ttft/decode+quality-retention
// chart sections empty, and zeroes every composite score (structGate=0). Chain all
// five secondary runners against THIS run, then rebuild every chart merging them in.
// Each secondary writes its own run dir and prints `[<kind>] done → <dir>`; we parse
// that line to collect the dirs. A failure in one secondary is logged, not fatal —
// the rebuild proceeds with whatever completed.
const secondaryInputs = [];
if (FULL) {
   const secondaries = [
      ['kv-probe', 'runners/kv-probe.mjs'],
      ['struct-output', 'runners/struct-output.mjs'],
      ['throughput-ttft', 'runners/throughput-ttft.mjs'],
      ['quality-decay', 'runners/quality-decay.mjs'],
      ['instruction-following', 'runners/instruction-following.mjs'],
      ['prompt-cache', 'runners/prompt-cache.mjs'],
      ['agentic-loop', 'runners/agentic-loop.mjs'],
      ['parallel-gen', 'runners/parallel-gen.mjs'],
   ];
   console.log(`\n[run-suite] --full: chaining ${secondaries.length} secondary runners against ${run.runId}\n`);
   // --depths caps the two depth sweeps (speed-decay, quality-decay); other secondaries ignore it.
   const DEPTH_SWEEPS = new Set(['quality-decay']);
   for (const [kind, script] of secondaries) {
      try {
         console.log(`[run-suite] ▸ ${kind} …`);
         const extraArgs = flags.depths && DEPTH_SWEEPS.has(kind) ? ['--depths', flags.depths] : [];
         const { stdout } = await execP('node', [join(ROOT, script), '--input', run.runId, ...extraArgs], {
            timeout: 6 * 60 * 60 * 1000, // depth sweeps are slow; 6h ceiling per runner
            maxBuffer: 64 * 1024 * 1024,
         });
         process.stdout.write(stdout);
         const m = stdout.match(/done → (.+)\s*$/m);
         if (m) {
            secondaryInputs.push(m[1].trim());
         } else {
            console.warn(`[run-suite] ${kind}: could not parse output run dir — chart may miss its rows`);
         }
      } catch (e) {
         console.warn(`[run-suite] ${kind} failed: ${e.message.slice(0, 160)}`);
      }
   }
}

// report/main chart merge ALL historical runs so partial/filtered runs don't wipe the fleet.
// The current run + its secondaries are always included; all other on-disk runs contribute
// their data via timestamp-arbitrated deduplication in build-report.mjs.
const sessionIds = new Set([run.runId, ...(flags.resume && PRIOR_RUN ? [PRIOR_RUN] : []), ...secondaryInputs]);
const allIds = [...sessionIds, ...listRuns(RESULTS_DIR).filter((id) => !sessionIds.has(id))];
const reportInputs = allIds.flatMap((id) => ['--input', id]);
try {
   await execP('node', [join(ROOT, 'runners/build-report.mjs'), ...reportInputs, '--output', REPORT_JSON]);
   console.log(`[run-suite] report → ${REPORT_JSON}`);
} catch (e) {
   console.warn(`[run-suite] report build failed: ${e.message.slice(0, 120)}`);
}
try {
   await execP('node', [join(ROOT, 'runners/render-chart.mjs'), ...reportInputs, '--output', CHART_SVG]);
   console.log(`[run-suite] chart → ${CHART_SVG}`);
} catch (e) {
   console.warn(`[run-suite] chart render failed: ${e.message.slice(0, 120)}`);
}
if (FULL) {
   try {
      await execP('node', [join(ROOT, 'runners/fleet-analysis.mjs'), ...reportInputs]);
      console.log('[run-suite] fleet chart rebuilt');
   } catch (e) {
      console.warn(`[run-suite] fleet-analysis failed: ${e.message.slice(0, 120)}`);
   }
}

console.log(`\n[run-suite] Done (${finalStatus}). Run: ${run.dir}`);
