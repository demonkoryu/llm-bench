#!/usr/bin/env node
/**
 * Serial benchmark orchestrator — restart-minimizing loop order.
 *
 * Execution: direct Ollama/llama.cpp calls + grader function imports.
 * No eval framework in the hot path.
 *
 * Visualization: writes results/run-TIMESTAMP.json in promptfoo output
 * schema → open with: npx promptfoo view results/run-TIMESTAMP.json
 *
 * Ollama phase (3 service restarts total):
 *   for kv in [f16, q8_0, q4_0]:       ← OUTER: 1 systemd restart per KV type
 *     for model in fitting:             ← INNER: hot-swap, no restart
 *       run: triage, reasoning, toolcalling, toolcalling_decay, summarization, speed, maxctx
 *
 * llama.cpp phase (1 server start per model × kv combo):
 *   for model × kv: start server → longctx passkey + multifact → stop
 *
 * Options:
 *   --target rose|m1       Host target (default: rose)
 *   --models <tag,...>     Restrict to these model tags (substring match)
 *   --benches <name,...>   Restrict bench names
 *   --kv <type,...>        KV types to sweep
 *   --dry-run              Print matrix and exit
 *   --no-llamacpp          Skip llama.cpp phase
 *   --no-ollama            Skip Ollama phase
 *   --resume               Skip combos already present in results/results.tsv
 */

import { readFileSync, existsSync, appendFileSync, mkdirSync, writeFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { parseArgs } from 'node:util';

const __dir = dirname(fileURLToPath(import.meta.url));
const ROOT  = join(__dir, '..');
const execP = promisify(execFile);

// ── CLI ────────────────────────────────────────────────────────────────────────
const { values: flags } = parseArgs({
   options: {
      target:        { type: 'string',  default: 'rose' },
      models:        { type: 'string',  default: '' },
      benches:       { type: 'string',  default: '' },
      kv:            { type: 'string',  default: '' },
      'dry-run':     { type: 'boolean', default: false },
      'no-llamacpp': { type: 'boolean', default: false },
      'no-ollama':   { type: 'boolean', default: false },
      resume:        { type: 'boolean', default: false },
   },
});

const DRY_RUN        = flags['dry-run'];
const TARGET         = flags.target;
const FILTER_MODELS  = flags.models  ? flags.models.split(',').map((s) => s.trim())  : [];
const FILTER_BENCHES = flags.benches ? flags.benches.split(',').map((s) => s.trim()) : [];
const FILTER_KV      = flags.kv      ? flags.kv.split(',').map((s) => s.trim())      : [];

// ── Config ─────────────────────────────────────────────────────────────────────
let yaml;
try { yaml = (await import('js-yaml')).default; }
catch { yaml = { load: () => { throw new Error('js-yaml not available; run npm install'); } }; }

const modelsConfig = yaml.load(readFileSync(join(ROOT, 'config/models.yaml'), 'utf8'));
const hostsConfig  = yaml.load(readFileSync(join(ROOT, 'config/hosts.yaml'),  'utf8'));

const host = hostsConfig[TARGET];
if (!host) throw new Error(`Unknown target: ${TARGET}`);

function resolveEnv(s) {
   return String(s ?? '').replace(/\$\{([^}]+)\}/g, (_, e) => {
      const [v, d] = e.split(':-');
      return process.env[v] ?? d ?? '';
   });
}

const OLLAMA_HOST = resolveEnv(host.ollama);
const LLAMA_URL   = host.llamacpp ? resolveEnv(host.llamacpp) : null;
const SSH_HOST    = resolveEnv(host.ssh_host);

// ── Grader imports ─────────────────────────────────────────────────────────────
const { gradeOne: triageGradeOne, computeScore: triageComputeScore } =
   await import('../shared/triage-rubric.mjs');
const { GOLDEN }          = await import('../shared/triage-golden.mjs');
const { TRIAGE_SCHEMA, TRIAGE_STATIC_PROMPT } = await import('../shared/triage-prompt.mjs');
const triageGrader        = (await import('../benchmarks/triage/grader.mjs')).default;

const { CASES: REASON_CASES } = await import('../benchmarks/reasoning/cases.mjs');
const reasoningGrader         = (await import('../benchmarks/reasoning/grader.mjs')).default;

const { CASES: TOOL_CASES }   = await import('../benchmarks/toolcalling/toolcases.mjs');
const { TOOLS_POOL }          = await import('../benchmarks/toolcalling/toolcases.mjs');
const toolGrader              = (await import('../benchmarks/toolcalling/grader.mjs')).default;

await import('../benchmarks/summarization/summcases.mjs');
const summGrader              = (await import('../benchmarks/summarization/grader.mjs')).default;

// ── Model helpers ──────────────────────────────────────────────────────────────
const allModels = modelsConfig.models ?? [];

function filterModels(models) {
   return models.filter((m) => {
      if (m.fit_rose === 'oom') return false;
      if (FILTER_MODELS.length && !FILTER_MODELS.some((f) => m.tag.includes(f))) return false;
      return true;
   });
}

function samplingOpts(model, think, bench) {
   if (bench === 'reasoning') return { temperature: 0.6, top_p: 0.95, top_k: 20, num_ctx: 8192 };
   if (bench === 'toolcalling' || bench === 'toolcalling_decay') return { temperature: 0.4, top_p: 0.9, num_ctx: 8192 };
   const f = model.family ?? '';
   if (f.startsWith('qwen3.5') || f.startsWith('qwen3.6')) {
      return think
         ? { temperature: 0.6, top_p: 0.95, top_k: 20, presence_penalty: 0.0 }
         : { temperature: 0.7, top_p: 0.8,  top_k: 20, presence_penalty: 1.5 };
   }
   if (f.startsWith('deepseek')) {
      return model.tag.includes('0528')
         ? { temperature: 0.6, top_p: 0.95, min_p: 0.01 }
         : { temperature: 0.6, top_p: 0.95, min_p: 0.05 };
   }
   if (f === 'gpt-oss') return { temperature: 0.6 };
   return { temperature: 0.1 };
}

// ── Ollama transport ───────────────────────────────────────────────────────────
async function ollamaChat({ model, messages, think = null, format = null, tools = null, options = {} }) {
   const body = { model, messages, stream: false, options };
   if (think !== null) body.think = think;
   if (format)        body.format = format;
   if (tools)         body.tools  = tools;
   const res = await fetch(`${OLLAMA_HOST}/api/chat`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      signal: AbortSignal.timeout(600_000),
      body: JSON.stringify(body),
   });
   return res.json();
}

async function unloadAll() {
   try {
      const res = await fetch(`${OLLAMA_HOST}/api/ps`, { signal: AbortSignal.timeout(5000) });
      for (const m of (await res.json()).models ?? []) {
         await fetch(`${OLLAMA_HOST}/api/generate`, {
            method: 'POST', headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ model: m.name, keep_alive: 0 }),
            signal: AbortSignal.timeout(15_000),
         }).catch(() => {});
      }
   } catch {}
}

async function warmup(tag, supportsThink) {
   try {
      await ollamaChat({ model: tag, messages: [{ role: 'user', content: supportsThink ? 'hi /no_think' : 'hi' }], think: supportsThink ? false : null, options: { num_predict: 1 } });
   } catch {}
}

function tokPerSec(resp) {
   return resp.eval_count && resp.eval_duration
      ? (resp.eval_count / (resp.eval_duration / 1e9))
      : null;
}

function stripThink(s) { return s.replace(/<think>[\s\S]*?<\/think>/g, '').trim(); }

// ── promptfoo-compatible result builder ────────────────────────────────────────
// run-suite writes this JSON for `npx promptfoo view results/run-TIMESTAMP.json`
function makePfResult({ bench, model, think, kv, vars, promptRaw, output, gradingResult, tokenUsage, latencyMs, metadata }) {
   const thinkLabel = think === null ? 'n/a' : think ? 'think' : 'no_think';
   return {
      provider:  { id: `ollama:${model.tag}`, label: `${model.label} [${thinkLabel}] KV=${kv}` },
      prompt:    { raw: promptRaw, label: bench },
      vars,
      response:  { output, tokenUsage: tokenUsage ?? {}, metadata: metadata ?? {} },
      gradingResult,
      success:   gradingResult?.pass ?? false,
      score:     gradingResult?.score ?? 0,
      latencyMs: latencyMs ?? 0,
   };
}

// ── Results storage ────────────────────────────────────────────────────────────
const RESULTS_DIR = join(ROOT, 'results');
const RESULTS_TSV = join(RESULTS_DIR, 'results.tsv');
mkdirSync(RESULTS_DIR, { recursive: true });

const TSV_HEADER = 'target\tkv\tmodel\tthink\tbench\tscore\thalls\tjson_fail\ttok_s\tvram_mib\tstatus\twall_s\tnotes\n';
if (!existsSync(RESULTS_TSV)) appendFileSync(RESULTS_TSV, TSV_HEADER);

function tsvKey(target, kv, model, think, bench) { return `${target}\t${kv}\t${model}\t${think}\t${bench}`; }

function loadDoneKeys() {
   if (!existsSync(RESULTS_TSV)) return new Set();
   return new Set(readFileSync(RESULTS_TSV, 'utf8').split('\n').slice(1).filter(Boolean).map((l) => l.split('\t').slice(0, 5).join('\t')));
}

function appendTsv(row) { appendFileSync(RESULTS_TSV, Object.values(row).join('\t') + '\n'); }

// Accumulate promptfoo JSON across entire run; flushed at end
const pfResults = [];

function flushPfJson() {
   if (!pfResults.length) return;
   const ts = new Date().toISOString().replace(/[:.]/g, '-');
   const outPath = join(RESULTS_DIR, `run-${ts}.json`);
   const successes = pfResults.filter((r) => r.success).length;
   const failures  = pfResults.filter((r) => !r.success).length;
   const payload = {
      results: {
         version: 3,
         timestamp: new Date().toISOString(),
         results: pfResults,
         stats: { successes, failures, errors: 0 },
      },
      config: { description: `llm-bench — target=${TARGET}` },
   };
   writeFileSync(outPath, JSON.stringify(payload, null, 2));
   console.log(`\n[run-suite] promptfoo JSON → ${outPath}`);
   console.log(`[run-suite] View: npx promptfoo view ${outPath}`);
}

// ── Bench runners ──────────────────────────────────────────────────────────────

async function runTriage(model, think, kv) {
   const opts = samplingOpts(model, think, 'triage');
   const itemResults = [];
   let totalMs = 0, totalToks = 0, halls = 0, jsonFail = 0;

   for (const item of GOLDEN) {
      const messages = [
         { role: 'system', content: TRIAGE_STATIC_PROMPT },
         { role: 'user', content: `Title: ${item.title}\nContent preview:\n${item.content_preview}` },
      ];
      const t0 = Date.now();
      let resp;
      try {
         resp = await ollamaChat({ model: model.tag, messages, think, format: TRIAGE_SCHEMA, options: opts });
      } catch (e) {
         itemResults.push({ item, grade: { scores: {}, parsedOk: false, anchorHallucination: false }, tokPerSec: null });
         continue;
      }
      const latencyMs = Date.now() - t0;
      totalMs += latencyMs;
      const tps = tokPerSec(resp);
      if (tps) totalToks += tps;
      const raw = resp.message?.content ?? '';
      const grade = triageGradeOne(item, raw);
      if (grade.anchorHallucination) halls++;
      if (!grade.parsedOk) jsonFail++;
      itemResults.push({ item, grade, tps, latencyMs });

      // promptfoo result per item
      const gradingResult = triageGrader(raw, { vars: { item_id: item.id } });
      pfResults.push(makePfResult({
         bench: 'triage', model, think, kv,
         vars: { item_id: item.id, item_title: item.title },
         promptRaw: messages[1].content,
         output: raw,
         gradingResult,
         tokenUsage: { total: (resp.prompt_eval_count ?? 0) + (resp.eval_count ?? 0), prompt: resp.prompt_eval_count ?? 0, completion: resp.eval_count ?? 0 },
         latencyMs,
         metadata: { tok_per_sec: tps?.toFixed(1) },
      }));
   }

   const { total: score } = triageComputeScore(itemResults);
   const avgTps = totalToks / itemResults.filter((r) => r.tps).length || 0;
   return { score: score.toFixed(1), halls, json_fail: jsonFail, tok_s: avgTps.toFixed(1), wall_s: (totalMs / 1000).toFixed(0) };
}

async function runReasoning(model, think, kv) {
   const opts = samplingOpts(model, think, 'reasoning');
   const ANSWER_SCHEMA = { type: 'object', properties: { answer: { type: 'string' } }, required: ['answer'] };
   const SYSTEM = 'You are solving short reasoning problems. Work out the correct answer.\nRespond ONLY with JSON: {"answer": "<your final answer, as short as possible>"}.\nPut just the final value in "answer" — a number or single word where possible, no explanation.';

   let correct = 0, errors = 0, totalMs = 0;
   const tokList = [];

   for (const [caseId] of Object.entries(REASON_CASES)) {
      const q = REASON_QUESTIONS[caseId];
      if (!q) continue;
      const msgs = [{ role: 'system', content: SYSTEM }, { role: 'user', content: q }];
      const t0 = Date.now();
      let resp;
      try { resp = await ollamaChat({ model: model.tag, messages: msgs, think, format: ANSWER_SCHEMA, options: opts }); }
      catch { errors++; continue; }
      const latencyMs = Date.now() - t0;
      totalMs += latencyMs;
      const tps = tokPerSec(resp);
      if (tps) tokList.push(tps);
      const raw = resp.message?.content ?? '';
      const gradingResult = reasoningGrader(raw, { vars: { case_id: caseId } });
      if (gradingResult.pass) correct++;
      pfResults.push(makePfResult({
         bench: 'reasoning', model, think, kv,
         vars: { case_id: caseId, question: q },
         promptRaw: q,
         output: raw,
         gradingResult,
         tokenUsage: { total: (resp.prompt_eval_count ?? 0) + (resp.eval_count ?? 0), prompt: resp.prompt_eval_count ?? 0, completion: resp.eval_count ?? 0 },
         latencyMs,
         metadata: { tok_per_sec: tps?.toFixed(1) },
      }));
   }

   const avgTps = tokList.length ? tokList.reduce((a, b) => a + b) / tokList.length : 0;
   const acc = (correct / Object.keys(REASON_CASES).length * 100).toFixed(1);
   return { score: acc, halls: '-', json_fail: errors, tok_s: avgTps.toFixed(1), wall_s: (totalMs / 1000).toFixed(0) };
}

async function runToolcalling(model, kv) {
   const opts = samplingOpts(model, false, 'toolcalling');
   const SYSTEM = 'You are a helpful assistant with access to tools. Call a tool ONLY when it is needed to fulfill the user\'s request. If no available tool fits, or no tool is needed, respond in plain text WITHOUT calling any tool.';

   let pass = 0, totalMs = 0;
   const USER_REQUESTS = {
      'weather-basic':    'What is the weather in Tokyo right now?',
      'weather-unit':     'What is the temperature in Berlin in Fahrenheit?',
      'add-list':         'Add up these numbers for me: 12, 30, and 8.',
      'currency':         'Convert 250 US dollars to euros.',
      'email-fields':     'Email alice@example.com with the subject "Lunch" and tell her I will be 10 minutes late.',
      'pick-right-tool':  'Find wireless headphones in the catalog, show me 5.',
      'distractor-tools': 'How much is 1000 Japanese yen in British pounds?',
      'no-tool-needed':   'Thanks, that is all I needed. Have a good day!',
      'missing-tool':     'Please book me a flight from London to New York tomorrow.',
      'numbers-from-prose': 'I bought three items costing seven dollars, fifteen dollars, and twenty-two dollars. What is the total?',
   };

   for (const [caseId] of Object.entries(TOOL_CASES)) {
      const userMsg = USER_REQUESTS[caseId] ?? caseId;
      const tools = TOOL_CASES[caseId].tools.map((n) => TOOLS_POOL[n]).filter(Boolean);
      const messages = [{ role: 'system', content: SYSTEM }, { role: 'user', content: userMsg }];
      const t0 = Date.now();
      let resp;
      try { resp = await ollamaChat({ model: model.tag, messages, think: false, tools, options: opts }); }
      catch { continue; }
      const latencyMs = Date.now() - t0;
      totalMs += latencyMs;
      const toolCalls = resp.message?.tool_calls ?? [];
      const output = JSON.stringify(toolCalls);
      const gradingResult = toolGrader(output, { vars: { case_id: caseId } });
      if (gradingResult.pass) pass++;
      pfResults.push(makePfResult({
         bench: 'toolcalling', model, think: false, kv,
         vars: { case_id: caseId, user_request: userMsg },
         promptRaw: userMsg,
         output,
         gradingResult,
         latencyMs,
         metadata: { tok_per_sec: tokPerSec(resp)?.toFixed(1) },
      }));
   }

   const acc = (pass / Object.keys(TOOL_CASES).length * 100).toFixed(1);
   return { score: acc, halls: '-', json_fail: '-', tok_s: '-', wall_s: (totalMs / 1000).toFixed(0) };
}

async function runSummarization(model, think, kv) {
   const opts = samplingOpts(model, think, 'summarization');
   const SYSTEM = 'You are summarizing and categorizing content for a personal knowledge vault.\nThe vault has 4 areas: craft (software, AI, hardware, PKM), finance (trading, markets), music (DJing, production), work (career, employer).\n\nRespond with JSON only:\n{\n  "summary": "<1-2 sentence factual summary>",\n  "area": "<craft|finance|music|work>",\n  "tags": ["<area/subtag>", ...]\n}';

   const ITEMS = {
      'rag-paper':          { title: 'Agentic RAG whitepaper', content: 'Covers multi-step reasoning with retrieval, tool use, and LLM orchestration. Describes how agents decompose queries into sub-tasks, retrieve relevant context at each step, and synthesize answers using chained tool calls.' },
      'trance-compression': { title: 'Sidechain compression for trance pumping', content: 'Classic trance pumping effect: sidechain a compressor on bass and pads keyed to the kick drum. Attack 0.1ms, release 80-150ms for the pump feel. Ghost kick sidechain keeps it in time without audible kick bleed.' },
      'trading-0dte':       { title: '0DTE options theta decay', content: 'Zero-days-to-expiry SPX options accelerate theta decay after 2pm. Selling premium after 2pm captures the steepest part of the intraday theta curve but gamma risk is highest in the last 30 minutes.' },
      'qmk-debounce':       { title: 'Keyboard debouncing in QMK firmware', content: 'QMK supports eager, defer-until-idle, and sym_eager_pk debounce algorithms. Eager fires immediately on press and delays release; sym_eager_pk is best for per-key debounce on split keyboards with noisy switches.' },
      'zettelkasten':       { title: 'Zettelkasten vs folder hierarchies for PKM', content: 'Dense bidirectional links between atomic notes outperform deep folder hierarchies for knowledge retrieval. Each note has exactly one idea; links surface unexpected connections better than any taxonomy.' },
      'salary-negotiation': { title: 'Negotiating a senior engineer offer', content: 'Anchor high on total compensation including equity refresh. Use competing offers as leverage. Recruiter call script: confirm base, then move to signing bonus and RSU refresh before benefits.' },
   };

   let totalScore = 0, totalMs = 0, count = 0;
   for (const [caseId, item] of Object.entries(ITEMS)) {
      const messages = [{ role: 'system', content: SYSTEM }, { role: 'user', content: `Title: ${item.title}\n\n${item.content}` }];
      const t0 = Date.now();
      let resp;
      try { resp = await ollamaChat({ model: model.tag, messages, think: think ?? null, options: opts }); }
      catch { continue; }
      const latencyMs = Date.now() - t0;
      totalMs += latencyMs;
      const raw = stripThink(resp.message?.content ?? '');
      const gradingResult = summGrader(raw, { vars: { case_id: caseId } });
      totalScore += gradingResult.score ?? 0;
      count++;
      pfResults.push(makePfResult({
         bench: 'summarization', model, think, kv,
         vars: { case_id: caseId, title: item.title },
         promptRaw: messages[1].content,
         output: raw,
         gradingResult,
         latencyMs,
         metadata: { tok_per_sec: tokPerSec(resp)?.toFixed(1) },
      }));
   }

   const avgScore = count ? (totalScore / count * 100).toFixed(1) : '?';
   return { score: avgScore, halls: '-', json_fail: '-', tok_s: '-', wall_s: (totalMs / 1000).toFixed(0) };
}

// Reasoning questions — inline to avoid a config file import
const REASON_QUESTIONS = {
   'bat-and-ball':     'A bat and a ball cost $1.10 in total. The bat costs $1.00 more than the ball. How many cents does the ball cost?',
   'widgets':          'If 5 machines take 5 minutes to make 5 widgets, how many minutes do 100 machines take to make 100 widgets?',
   'lily-pad':         'A patch of lily pads doubles in size every day. It takes 48 days to cover the whole lake. On what day number was the lake half covered?',
   'all-but-9':        'A farmer has 17 sheep. All but 9 die. How many sheep are left alive?',
   'apples-fractions': 'A store starts with 120 apples. It sells one third of them in the morning, then one quarter of the REMAINING apples in the afternoon. How many apples are left at the end of the day?',
   'age-order':        'Alice is older than Bob. Carol is younger than Bob. Dave is older than Alice. Among Alice, Bob, Carol, and Dave, who is the oldest? Give the single name.',
   'days-100':         'Today is Wednesday. What day of the week will it be exactly 100 days from now? Give the weekday name.',
   'count-sevens':     'Counting through the whole numbers from 1 to 100 inclusive, how many times does the digit 7 appear in total (e.g. 77 contains the digit 7 twice)?',
   'next-in-sequence': 'What is the next number in this sequence: 2, 6, 12, 20, 30, ? Give just the number.',
   'modus-tollens':    'Rule: If it is raining, then the ground is wet. Observation: the ground is NOT wet. Based only on this, is it raining? Answer yes or no.',
   'socks':            'A drawer has 10 red socks and 10 blue socks mixed together in the dark. How many socks must you pull out, at minimum, to be GUARANTEED a matching pair?',
   'overtaking':       'In a race, you overtake the runner in second place. What position are you in now? Give the ordinal (e.g. first, second).',
};

// ── Speed + max-ctx ────────────────────────────────────────────────────────────
async function measureSpeed(tag, think, numCtx = 4096) {
   const body = { model: tag, stream: false, options: { temperature: 0.7, num_ctx: numCtx, num_predict: 150 }, messages: [{ role: 'user', content: 'Describe the water cycle in detail.' }] };
   if (think !== null) body.think = think;
   try {
      const res = await fetch(`${OLLAMA_HOST}/api/chat`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, signal: AbortSignal.timeout(120_000), body: JSON.stringify(body) });
      const r = await res.json();
      return tokPerSec(r)?.toFixed(1) ?? null;
   } catch { return null; }
}

async function probeMaxCtx(tag) {
   const pts = modelsConfig.ctx_probe_points ?? [4096, 16384, 32768, 65536];
   let lo = 0, hi = pts.length - 1, best = pts[0];
   while (lo <= hi) {
      const mid = (lo + hi) >> 1;
      const ok = await canLoadCtx(tag, pts[mid]);
      if (ok) { best = pts[mid]; lo = mid + 1; } else { hi = mid - 1; }
   }
   return best;
}

async function canLoadCtx(tag, numCtx) {
   try {
      const res = await fetch(`${OLLAMA_HOST}/api/chat`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, signal: AbortSignal.timeout(60_000), body: JSON.stringify({ model: tag, stream: false, options: { num_ctx: numCtx, num_predict: 1 }, messages: [{ role: 'user', content: 'hi' }] }) });
      return !(await res.json()).error;
   } catch { return false; }
}

// ── VRAM ──────────────────────────────────────────────────────────────────────
async function snapshotVram() {
   try {
      const { stdout } = await execP('ssh', [SSH_HOST, 'rocm-smi --showmemuse --json'], { timeout: 10_000 });
      const card = Object.values(JSON.parse(stdout.trim()))[0] ?? {};
      return Math.round(parseInt(card['VRAM Total Used Memory (B)'] ?? '0', 10) / (1024 * 1024));
   } catch { return null; }
}

// ── Dry-run ────────────────────────────────────────────────────────────────────
function dryRun() {
   const ollamaModels = filterModels(allModels).filter((m) => m.benches?.some((b) => b !== 'longctx'));
   const llamaModels  = filterModels(allModels).filter((m) => m.benches?.includes('longctx'));
   const kvOllama = FILTER_KV.length ? FILTER_KV : (modelsConfig.kv_configs?.ollama   ?? ['f16','q8_0','q4_0']);
   const kvLlama  = FILTER_KV.length ? FILTER_KV : (modelsConfig.kv_configs?.llamacpp ?? ['f16','q8_0','q4_0','k8v4']);

   console.log(`\nDry-run — target=${TARGET}  OLLAMA_HOST=${OLLAMA_HOST}\n`);
   console.log(`── Ollama phase ──  (${kvOllama.length} KV types × ${ollamaModels.length} models = ${kvOllama.length} restarts)`);
   for (const kv of kvOllama) {
      console.log(`  KV=${kv}:`);
      for (const m of ollamaModels) {
         const b = (m.benches ?? []).filter((x) => x !== 'longctx' && (!FILTER_BENCHES.length || FILTER_BENCHES.includes(x)));
         console.log(`    ${m.tag.padEnd(52)} benches=[${b.join(',')}]`);
      }
   }
   if (!flags['no-llamacpp'] && LLAMA_URL) {
      console.log(`\n── llama.cpp phase ──  (${llamaModels.length} models × ${kvLlama.length} KV = ${llamaModels.length * kvLlama.length} server starts)`);
      for (const m of llamaModels) for (const kv of kvLlama) console.log(`  ${m.tag.padEnd(52)} KV=${kv}`);
   }
   console.log(`\nTotal Ollama restarts: ${kvOllama.length}`);
   console.log(`Total llama.cpp server starts: ${flags['no-llamacpp'] ? 0 : llamaModels.length * kvLlama.length}`);
}

if (DRY_RUN) { dryRun(); process.exit(0); }

// ── Main ──────────────────────────────────────────────────────────────────────
const doneKeys = flags.resume ? loadDoneKeys() : new Set();

// ══════════════════════════════════════════════════════════════════════════════
// OLLAMA PHASE
// ══════════════════════════════════════════════════════════════════════════════
if (!flags['no-ollama']) {
   const kvTypes  = FILTER_KV.length ? FILTER_KV : (modelsConfig.kv_configs?.ollama ?? ['f16','q8_0','q4_0']);
   const models   = filterModels(allModels).filter((m) => m.benches?.some((b) => b !== 'longctx'));

   let kvMgr = null;
   if (host.ollama_service) {
      const { ollamaKvManager } = await import('./ollama-kv.mjs');
      kvMgr = ollamaKvManager({ sshHost: SSH_HOST, service: host.ollama_service, ollamaHost: OLLAMA_HOST });
   }

   for (const kv of kvTypes) {
      console.log(`\n${'═'.repeat(70)}\n  OLLAMA PHASE — KV=${kv}${kvMgr ? '  (restarting)' : ''}\n${'═'.repeat(70)}`);
      if (kvMgr) await kvMgr.setKvType(kv);

      for (const model of models) {
         const supportsThink = model.think === 'optional' || model.think === 'required';
         const thinkModes    = supportsThink ? [false, true] : [null];

         await unloadAll();
         await warmup(model.tag, supportsThink);
         console.log(`\n  ── ${model.label} (${model.tag})`);

         const benches = (model.benches ?? []).filter((b) => b !== 'longctx' && (!FILTER_BENCHES.length || FILTER_BENCHES.includes(b)));

         for (const think of thinkModes) {
            const tl = think === null ? 'n/a' : think ? 'think' : 'no_think';

            if (benches.includes('triage')) {
               const key = tsvKey(TARGET, kv, model.tag, tl, 'triage');
               if (flags.resume && doneKeys.has(key)) { console.log(`    [triage ${tl}] skip`); }
               else {
                  process.stdout.write(`    [triage ${tl}] `);
                  const r = await runTriage(model, think, kv);
                  const vram = await snapshotVram();
                  console.log(`score=${r.score}  halls=${r.halls}  json_fail=${r.json_fail}  tok/s=${r.tok_s}  vram=${vram ?? '?'}MiB`);
                  appendTsv({ target: TARGET, kv, model: model.tag, think: tl, bench: 'triage', score: r.score, halls: r.halls, json_fail: r.json_fail, tok_s: r.tok_s, vram_mib: vram ?? '?', status: 'ok', wall_s: r.wall_s, notes: '' });
               }
            }

            if (benches.includes('reasoning')) {
               const key = tsvKey(TARGET, kv, model.tag, tl, 'reasoning');
               if (flags.resume && doneKeys.has(key)) { console.log(`    [reasoning ${tl}] skip`); }
               else {
                  process.stdout.write(`    [reasoning ${tl}] `);
                  const r = await runReasoning(model, think, kv);
                  const vram = await snapshotVram();
                  console.log(`accuracy=${r.score}%  tok/s=${r.tok_s}`);
                  appendTsv({ target: TARGET, kv, model: model.tag, think: tl, bench: 'reasoning', score: r.score, halls: '-', json_fail: r.json_fail, tok_s: r.tok_s, vram_mib: vram ?? '?', status: 'ok', wall_s: r.wall_s, notes: '' });
               }
            }

            if (benches.includes('toolcalling') && model.tools && think !== true) {
               const key = tsvKey(TARGET, kv, model.tag, tl, 'toolcalling');
               if (flags.resume && doneKeys.has(key)) { console.log(`    [toolcalling] skip`); }
               else {
                  process.stdout.write(`    [toolcalling] `);
                  const r = await runToolcalling(model, kv);
                  const vram = await snapshotVram();
                  console.log(`accuracy=${r.score}%`);
                  appendTsv({ target: TARGET, kv, model: model.tag, think: tl, bench: 'toolcalling', score: r.score, halls: '-', json_fail: '-', tok_s: '-', vram_mib: vram ?? '?', status: 'ok', wall_s: r.wall_s, notes: '' });
               }
            }

            if (benches.includes('toolcalling_decay') && model.tools && think !== true && kv === kvTypes[0]) {
               const key = tsvKey(TARGET, kvTypes[0], model.tag, tl, 'toolcalling_decay');
               if (flags.resume && doneKeys.has(key)) { console.log(`    [toolcalling_decay] skip`); }
               else {
                  process.stdout.write(`    [toolcalling_decay] `);
                  const t0 = Date.now();
                  const { stdout } = await execP('node', [join(ROOT, 'benchmarks/toolcalling/decay-bench.mjs'), model.tag], { env: { ...process.env, OLLAMA_HOST }, timeout: 3_600_000 }).catch((e) => ({ stdout: '', stderr: e.message }));
                  const decayRows = [...stdout.matchAll(/^\s+(\d+)\s+\d+\s+([\d.]+)%/gm)].map((m) => `r${m[1]}=${m[2]}%`);
                  const wall = ((Date.now() - t0) / 1000).toFixed(0);
                  console.log(decayRows.join(' ') || 'done');
                  appendTsv({ target: TARGET, kv: kvTypes[0], model: model.tag, think: tl, bench: 'toolcalling_decay', score: '-', halls: '-', json_fail: '-', tok_s: '-', vram_mib: '?', status: 'ok', wall_s: wall, notes: decayRows.join(' ') });
               }
            }

            if (benches.includes('summarization') && think !== true) {
               const key = tsvKey(TARGET, kv, model.tag, tl, 'summarization');
               if (flags.resume && doneKeys.has(key)) { console.log(`    [summarization] skip`); }
               else {
                  process.stdout.write(`    [summarization] `);
                  const r = await runSummarization(model, think === null ? null : false, kv);
                  const vram = await snapshotVram();
                  console.log(`score=${r.score}`);
                  appendTsv({ target: TARGET, kv, model: model.tag, think: tl, bench: 'summarization', score: r.score, halls: '-', json_fail: '-', tok_s: '-', vram_mib: vram ?? '?', status: 'ok', wall_s: r.wall_s, notes: '' });
               }
            }
         }

         // speed (all KV passes)
         if (benches.includes('speed')) {
            const key = tsvKey(TARGET, kv, model.tag, 'no_think', 'speed');
            if (flags.resume && doneKeys.has(key)) { console.log(`    [speed] skip`); }
            else {
               process.stdout.write(`    [speed] `);
               const tps = await measureSpeed(model.tag, supportsThink ? false : null, 4096);
               const vram = await snapshotVram();
               console.log(`${tps ?? '?'} tok/s  vram=${vram ?? '?'}MiB`);
               appendTsv({ target: TARGET, kv, model: model.tag, think: 'no_think', bench: 'speed', score: tps ?? '?', halls: '-', json_fail: '-', tok_s: tps ?? '?', vram_mib: vram ?? '?', status: tps ? 'ok' : 'error', wall_s: '-', notes: '' });
            }
         }

         // maxctx (first KV pass only)
         if (benches.includes('maxctx') && kv === kvTypes[0]) {
            const key = tsvKey(TARGET, kv, model.tag, '-', 'maxctx');
            if (flags.resume && doneKeys.has(key)) { console.log(`    [maxctx] skip`); }
            else {
               process.stdout.write(`    [maxctx] `);
               const maxCtx = await probeMaxCtx(model.tag);
               const vram   = await snapshotVram();
               console.log(`${maxCtx.toLocaleString()} tokens (${(maxCtx * 4).toLocaleString()} chars)  vram=${vram ?? '?'}MiB`);
               appendTsv({ target: TARGET, kv, model: model.tag, think: '-', bench: 'maxctx', score: maxCtx, halls: '-', json_fail: '-', tok_s: '-', vram_mib: vram ?? '?', status: 'ok', wall_s: '-', notes: '' });
            }
         }
      }
   }

   if (kvMgr) await kvMgr.restore();
   console.log('\n[run-suite] Ollama phase complete.');
}

// ══════════════════════════════════════════════════════════════════════════════
// LLAMA.CPP PHASE
// ══════════════════════════════════════════════════════════════════════════════
if (!flags['no-llamacpp'] && LLAMA_URL) {
   const { llamacppServer } = await import('./llamacpp-server.mjs');
   const srv      = llamacppServer({ sshHost: SSH_HOST, llamaUrl: LLAMA_URL });
   const kvTypes  = FILTER_KV.length ? FILTER_KV : (modelsConfig.kv_configs?.llamacpp ?? ['f16','q8_0','q4_0','k8v4']);
   const models   = filterModels(allModels).filter((m) => m.benches?.includes('longctx'));

   console.log(`\n${'═'.repeat(70)}\n  LLAMA.CPP PHASE — ${models.length} models × ${kvTypes.length} KV configs\n${'═'.repeat(70)}`);

   for (const model of models) {
      for (const kv of kvTypes) {
         const [ctk, ctv] = kv === 'k8v4' ? ['q8_0', 'q4_0'] : [kv, kv];
         const key = tsvKey(TARGET, kv, model.tag, '-', 'longctx');
         if (flags.resume && doneKeys.has(key)) { console.log(`  [${model.tag} KV=${kv}] skip`); continue; }

         console.log(`\n  ── ${model.label} KV=${kv} (ctk=${ctk} ctv=${ctv})`);
         const modelPath = `$(ollama show '${model.tag}' --modelfile 2>/dev/null | awk '/^FROM/{print $2}')`;
         let vramMib = null;
         try {
            ({ vramMib } = await srv.start({ modelPath, ctxSize: 65536, ctk, ctv, ngl: 99 }));
            const t0 = Date.now();
            const llamaEnv = { ...process.env, LLAMA_URL };
            const [pkOut, mfOut] = await Promise.all([
               execP('node', [join(ROOT, 'benchmarks/longctx/passkey-bench.mjs'), '24000', kv, model.tag], { env: llamaEnv, timeout: 600_000 }).catch((e) => ({ stdout: '' })),
               execP('node', [join(ROOT, 'benchmarks/longctx/multifact-bench.mjs'), '24000', kv, model.tag], { env: llamaEnv, timeout: 600_000 }).catch(() => ({ stdout: '' })),
            ]);
            const pkScore = pkOut.stdout.split('\n').find((l) => l.startsWith('RESULT\t'))?.split('\t')[4] ?? '?';
            const mfScore = mfOut.stdout.split('\n').find((l) => l.startsWith('RESULT_MULTIFACT\t'))?.split('\t')[4] ?? '?';
            const wall = ((Date.now() - t0) / 1000).toFixed(0);
            console.log(`    passkey=${pkScore}  multifact=${mfScore}  vram=${vramMib ?? '?'}MiB`);
            appendTsv({ target: TARGET, kv, model: model.tag, think: '-', bench: 'longctx', score: pkScore, halls: '-', json_fail: '-', tok_s: '-', vram_mib: vramMib ?? '?', status: 'ok', wall_s: wall, notes: `multifact=${mfScore}` });
         } catch (e) {
            console.error(`  ERROR: ${e.message}`);
            appendTsv({ target: TARGET, kv, model: model.tag, think: '-', bench: 'longctx', score: '?', halls: '-', json_fail: '-', tok_s: '-', vram_mib: vramMib ?? '?', status: `error:${e.message.slice(0, 60)}`, wall_s: '-', notes: '' });
         } finally {
            await srv.stop().catch(() => {});
         }
      }
   }
   console.log('\n[run-suite] llama.cpp phase complete.');
}

// ── Flush promptfoo JSON for visualization ────────────────────────────────────
flushPfJson();

console.log(`\n[run-suite] Done. Results: ${RESULTS_TSV}`);
