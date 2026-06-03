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
 *   --skip-maxctx          Skip binary-search ctx probe (use ctx_cap or 8192)
 *   --dry-run              Print matrix and exit
 *   --resume               Skip combos already present in the results CSV
 *   --out <file>           Append to an existing results CSV (default: new timestamped file)
 *   --debug                Enable LLM request/response logging (BENCH_DEBUG=1)
 */

import { execFile } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseArgs, promisify } from 'node:util';
import { appendRow, csvFilename, ensureHeader, readTable } from '../shared/results-csv.mjs';

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
      'dry-run': { type: 'boolean', default: false },
      resume: { type: 'boolean', default: false },
      debug: { type: 'boolean', default: false },
      out: { type: 'string' }, // append to an existing results CSV instead of a new file
   },
});

const DRY_RUN = flags['dry-run'];
const TARGET = flags.target;
const BACKEND = flags.backend;
const FILTER_MODELS = flags.models ? flags.models.split(',').map((s) => s.trim()) : [];
const FILTER_BENCHES = flags.benches ? flags.benches.split(',').map((s) => s.trim()) : [];
const SKIP_MAXCTX = flags['skip-maxctx'];
const DEBUG = flags.debug || !!process.env.BENCH_DEBUG;

if (DEBUG) {
   process.env.BENCH_DEBUG = '1';
}

// ── Config ─────────────────────────────────────────────────────────────────────
let yaml;
try {
   yaml = (await import('js-yaml')).default;
} catch {
   yaml = {
      load: () => {
         throw new Error('js-yaml not available — run npm install');
      },
   };
}

const modelsConfig = yaml.load(readFileSync(join(ROOT, 'config/models.yaml'), 'utf8'));
const hostsConfig = yaml.load(readFileSync(join(ROOT, 'config/hosts.yaml'), 'utf8'));
const hostCfg = hostsConfig[TARGET];
if (!hostCfg) {
   throw new Error(`Unknown target: ${TARGET}`);
}

function resolveEnv(s) {
   return String(s ?? '').replace(/\$\{([^}]+)\}/g, (_, e) => {
      const [v, d] = e.split(':-');
      return process.env[v] ?? d ?? '';
   });
}

const LLAMA_URL = resolveEnv(hostCfg.llamacpp);
const SSH_HOST = resolveEnv(hostCfg.ssh_host);
const GPU = hostCfg.gpu ?? TARGET;
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
const docqaCases = JSON.parse(readFileSync(join(ROOT, 'benchmarks/docqa/cases.json'), 'utf8'));

// ── Model helpers ──────────────────────────────────────────────────────────────
const allModels = modelsConfig.models ?? [];

/**
 * Stable ID derived from the GGUF filename + think state.
 * thinkState null → base name (non-hybrid models); true/false → appends --think/--nothi.
 * Used as TSV row key and judge bundle key.
 */
function modelId(m, thinkState) {
   const base = m.hf_file.replace(/\.gguf$/i, '');
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
// toolcalling + toolcalling_decay (tool use is incompatible with a think pass)
// and maxctx (think-independent — probed once in the no_think / null pass).

// ── Token budgets ──────────────────────────────────────────────────────────────
const MAX_TOKENS = {
   no_think: 1024, // structured JSON answer
   think: 32768, // think block + answer; Qwen3/DeepSeek-R1 official recommendation
   tool: 512, // single tool call response
   instruct: 1024, // non-thinking instruct models
   docqa: 1280, // multi-hop doc-QA with citations
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

// Each run writes to a self-describing CSV (host/gpu/backend/datetime). --out
// appends to an existing CSV instead — used by resume / follow-up runs.
const RESULTS_CSV = flags.out
   ? resolve(flags.out) // relative to CWD, like a normal CLI path
   : join(RESULTS_DIR, csvFilename({ host: TARGET, gpu: GPU, backend: BACKEND, date: new Date() }));
ensureHeader(RESULTS_CSV);

// Resume key = the five identity columns (target, backend, model, think, bench).
function tsvKey(model, think, bench) {
   return `${TARGET}\t${BACKEND}\t${model}\t${think}\t${bench}`;
}

function loadDoneKeys() {
   if (!existsSync(RESULTS_CSV)) {
      return new Set();
   }
   return new Set(readTable(RESULTS_CSV).map((r) => `${r.target}\t${r.backend}\t${r.model}\t${r.think}\t${r.bench}`));
}

function appendTsv(row) {
   appendRow(RESULTS_CSV, row);
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
            responseFormat: thinkState === true ? null : TRIAGE_SCHEMA,
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

   const { total: score } = triageComputeScore(itemResults);
   const avgTps = tokList.length ? tokList.reduce((a, b) => a + b, 0) / tokList.length : 0;
   return { score: score.toFixed(1), halls, json_fail: jsonFail, tok_s: avgTps.toFixed(1), wall_s: (totalMs / 1000).toFixed(0) };
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
      const maxTok = thinkState === true ? MAX_TOKENS.think : MAX_TOKENS.no_think;
      const t0 = Date.now();
      let completion;
      try {
         const res = await client.chat(messages, {
            think: thinkState,
            thinkControl,
            responseFormat: thinkState === true ? null : ANSWER_SCHEMA,
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
   return {
      score: ((correct / total) * 100).toFixed(1),
      halls: '-',
      json_fail: errors,
      tok_s: avgTps.toFixed(1),
      wall_s: (totalMs / 1000).toFixed(0),
   };
}

async function runToolcalling(client, model) {
   const sampling = sampleOpts(model, false, 'toolcalling');
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
            think: false,
            thinkControl,
            tools,
            max_tokens: MAX_TOKENS.tool,
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
         think: false,
         vars: { case_id: caseId },
         promptRaw: userMsg,
         output,
         gradingResult,
         latencyMs: Date.now() - t0,
         tokS: null,
      });
   }

   const total = Object.keys(TOOL_CASES).length;
   return { score: ((pass / total) * 100).toFixed(1), halls: '-', json_fail: '-', tok_s: '-', wall_s: (totalMs / 1000).toFixed(0) };
}

async function runSummarization(client, model, thinkState) {
   const sampling = sampleOpts(model, thinkState, 'summarization');
   const thinkControl = model.think_control ?? 'enable_thinking';
   const SYSTEM =
      'Summarize and categorize content for a personal knowledge vault.\nVault areas: craft (software, AI, hardware, PKM), finance (trading, markets), music (DJing, production), work (career, employer).\n\nRespond with JSON only:\n{"summary": "<1-2 sentence factual summary>", "area": "<craft|finance|music|work>", "tags": ["<area/subtag>", ...]}';

   let totalScore = 0,
      totalMs = 0,
      count = 0;

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
      totalScore += gradingResult.score ?? 0;
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
      score: count ? ((totalScore / count) * 100).toFixed(1) : '?',
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

   const { mean_score, per_question } = docqaGradeAll(questions ?? [], answers);
   const trapHits = per_question.filter((r) => r.trap_hits?.length > 0).length;
   return { score: mean_score.toFixed(2), halls: trapHits, json_fail: '-', tok_s: '-', wall_s: '-' };
}

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
      warnRunaway(`speed/${label}`, label, completion);
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
               { think: thinkState, thinkControl, responseFormat: thinkState ? null : TRIAGE_SCHEMA, max_tokens: 256 },
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
      const thinkModes = getThinkModes(m).map((t) => (t === null ? 'n/a' : t ? 'think' : 'no_think'));
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
   const thinkModes = getThinkModes(model);
   const benches = (model.benches ?? []).filter((b) => !FILTER_BENCHES.length || FILTER_BENCHES.includes(b));

   console.log(`\n${'═'.repeat(70)}`);
   console.log(`  ${model.label ?? modelId(model, null)}`);
   console.log('═'.repeat(70));

   // ── Max-ctx binary search ─────────────────────────────────────────────────
   let ctxLoaded, oomCeiling, coherenceCeiling, vramMib;
   if (SKIP_MAXCTX) {
      ctxLoaded = model.ctx_cap ?? model.native_max_ctx ?? 8192;
      oomCeiling = ctxLoaded;
      coherenceCeiling = ctxLoaded;
      console.log(`  [maxctx] skipped — using ${ctxLoaded} (ctx_cap or native_max_ctx)`);
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
            console.log(
               `score=${res.r.score}  halls=${res.r.halls}  json_fail=${res.r.json_fail}  tok/s=${res.r.tok_s}  vram=${res.curVram ?? '?'}MiB`,
            );
            appendTsv({
               target: TARGET,
               backend: BACKEND,
               model: passId,
               think: tl,
               bench: 'triage',
               score: res.r.score,
               halls: res.r.halls,
               json_fail: res.r.json_fail,
               tok_s: res.r.tok_s,
               prefill_tps: '-',
               vram_mib: res.curVram ?? '?',
               ctx_loaded: ctxLoaded ?? '?',
               oom_ceiling: oomCeiling ?? '?',
               coherence_ceiling: coherenceCeiling ?? '?',
               status: 'ok',
               wall_s: res.r.wall_s,
               notes: '',
            });
         }
      }

      // reasoning
      {
         const res = await skipOrRun('reasoning', () => runReasoning(client, model, thinkState));
         if (res) {
            console.log(`accuracy=${res.r.score}%  tok/s=${res.r.tok_s}`);
            appendTsv({
               target: TARGET,
               backend: BACKEND,
               model: passId,
               think: tl,
               bench: 'reasoning',
               score: res.r.score,
               halls: '-',
               json_fail: res.r.json_fail,
               tok_s: res.r.tok_s,
               prefill_tps: '-',
               vram_mib: vramMib ?? '?',
               ctx_loaded: ctxLoaded ?? '?',
               oom_ceiling: oomCeiling ?? '?',
               coherence_ceiling: coherenceCeiling ?? '?',
               status: 'ok',
               wall_s: res.r.wall_s,
               notes: '',
            });
         }
      }

      // toolcalling — only in no-think mode
      if (model.tools && thinkState !== true) {
         const res = await skipOrRun('toolcalling', () => runToolcalling(client, model));
         if (res) {
            console.log(`accuracy=${res.r.score}%`);
            appendTsv({
               target: TARGET,
               backend: BACKEND,
               model: passId,
               think: tl,
               bench: 'toolcalling',
               score: res.r.score,
               halls: '-',
               json_fail: '-',
               tok_s: '-',
               prefill_tps: '-',
               vram_mib: vramMib ?? '?',
               ctx_loaded: ctxLoaded ?? '?',
               oom_ceiling: oomCeiling ?? '?',
               coherence_ceiling: coherenceCeiling ?? '?',
               status: 'ok',
               wall_s: res.r.wall_s,
               notes: '',
            });
         }
      }

      // docqa — runs in both think and no-think passes
      {
         const res = await skipOrRun('docqa', () => runDocqa(client, model, thinkState));
         if (res) {
            console.log(`mean=${res.r.score}/10  trap_hits=${res.r.halls}`);
            appendTsv({
               target: TARGET,
               backend: BACKEND,
               model: passId,
               think: tl,
               bench: 'docqa',
               score: res.r.score,
               halls: res.r.halls,
               json_fail: '-',
               tok_s: '-',
               prefill_tps: '-',
               vram_mib: vramMib ?? '?',
               ctx_loaded: ctxLoaded ?? '?',
               oom_ceiling: oomCeiling ?? '?',
               coherence_ceiling: coherenceCeiling ?? '?',
               status: 'ok',
               wall_s: res.wallS,
               notes: '',
            });
         }
      }

      // summarization — runs in both think and no-think passes
      {
         const res = await skipOrRun('summarization', () => runSummarization(client, model, thinkState));
         if (res) {
            console.log(`score=${res.r.score}`);
            appendTsv({
               target: TARGET,
               backend: BACKEND,
               model: passId,
               think: tl,
               bench: 'summarization',
               score: res.r.score,
               halls: '-',
               json_fail: '-',
               tok_s: '-',
               prefill_tps: '-',
               vram_mib: vramMib ?? '?',
               ctx_loaded: ctxLoaded ?? '?',
               oom_ceiling: oomCeiling ?? '?',
               coherence_ceiling: coherenceCeiling ?? '?',
               status: 'ok',
               wall_s: res.r.wall_s,
               notes: '',
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

// Build the summary report (report.json) and SVG chart directly from the CSV.
const REPORT_JSON = join(RESULTS_DIR, 'report.json');
const CHART_SVG = join(RESULTS_DIR, 'chart.svg');
try {
   await execP('node', [join(ROOT, 'runners/build-report.mjs'), '--input', RESULTS_CSV, '--output', REPORT_JSON]);
   console.log(`[run-suite] report → ${REPORT_JSON}`);
} catch (e) {
   console.warn(`[run-suite] report build failed: ${e.message.slice(0, 120)}`);
}
try {
   await execP('node', [join(ROOT, 'runners/render-chart.mjs'), '--input', RESULTS_CSV, '--output', CHART_SVG]);
   console.log(`[run-suite] chart → ${CHART_SVG}`);
} catch (e) {
   console.warn(`[run-suite] chart render failed: ${e.message.slice(0, 120)}`);
}

console.log(`\n[run-suite] Done. Results: ${RESULTS_CSV}`);
