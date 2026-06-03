#!/usr/bin/env node
/**
 * Serial benchmark orchestrator — everything via llama.cpp directly.
 *
 * Models downloaded from HuggingFace via --hf-repo/--hf-file on first use,
 * cached in ~/.cache/llama.cpp/ on the remote host. No Ollama required.
 *
 * Loop: for model × kv_config — start llama-server, run all benches, stop.
 *   - toolcalling_decay and maxctx: first KV pass per model only (KV-independent)
 *   - longctx passkey + multifact: all KV passes (this is the KV sweep point)
 *
 * Think toggle: chat_template_kwargs.enable_thinking (per-request, llama.cpp native)
 * Structured output: response_format.json_schema (triage)
 * Tools: standard OpenAI tools spec
 * KV quant: -ctk / -ctv server launch flags (f16 | q8_0 | q4_0 | k8v4)
 *
 * Options:
 *   --target rose|m1       Host target (default: rose)
 *   --models <tag,...>     Restrict to these model tags (substring match)
 *   --benches <name,...>   Restrict bench names
 *   --kv <type,...>        KV types to sweep
 *   --dry-run              Print matrix and exit
 *   --resume               Skip combos already in results/results.tsv
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
      target:    { type: 'string',  default: 'rose' },
      models:    { type: 'string',  default: '' },
      benches:   { type: 'string',  default: '' },
      kv:        { type: 'string',  default: '' },
      'dry-run': { type: 'boolean', default: false },
      resume:    { type: 'boolean', default: false },
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
const hostsConfig  = yaml.load(readFileSync(join(ROOT, 'config/hosts.yaml'), 'utf8'));
const hostCfg      = hostsConfig[TARGET];
if (!hostCfg) throw new Error(`Unknown target: ${TARGET}`);

function resolveEnv(s) {
   return String(s ?? '').replace(/\$\{([^}]+)\}/g, (_, e) => {
      const [v, d] = e.split(':-');
      return process.env[v] ?? d ?? '';
   });
}

const LLAMA_URL = resolveEnv(hostCfg.llamacpp);
const SSH_HOST  = resolveEnv(hostCfg.ssh_host);

// ── Grader imports ─────────────────────────────────────────────────────────────
const { gradeOne: triageGradeOne, computeScore: triageComputeScore } =
   await import('../shared/triage-rubric.mjs');
const { GOLDEN }                        = await import('../shared/triage-golden.mjs');
const { TRIAGE_SCHEMA, TRIAGE_STATIC_PROMPT } = await import('../shared/triage-prompt.mjs');
const triageGrader                      = (await import('../benchmarks/triage/grader.mjs')).default;
const { CASES: REASON_CASES }           = await import('../benchmarks/reasoning/cases.mjs');
const reasoningGrader                   = (await import('../benchmarks/reasoning/grader.mjs')).default;
const { CASES: TOOL_CASES, TOOLS_POOL } = await import('../benchmarks/toolcalling/toolcases.mjs');
const toolGrader                        = (await import('../benchmarks/toolcalling/grader.mjs')).default;
const summGrader                        = (await import('../benchmarks/summarization/grader.mjs')).default;

// ── Model helpers ──────────────────────────────────────────────────────────────
const allModels = modelsConfig.models ?? [];

/** Stable ID derived from the GGUF filename (no extension). Used as TSV key. */
function modelId(m) { return m.hf_file.replace(/\.gguf$/i, ''); }

function filterModels() {
   return allModels.filter((m) => {
      if (m.fit_rose === 'oom') return false;
      if (FILTER_MODELS.length && !FILTER_MODELS.some((f) => modelId(m).includes(f) || m.label.includes(f))) return false;
      return true;
   });
}

// ── Token budgets — keyed by mode, same across all models (fairness) ─────────
// Qwen and DeepSeek-R1 both officially recommend 32768 for thinking.
// no_think/instruct: 1024 is well above any structured JSON answer.
// speed bench overrides to 150 at call site (not a scored bench).
const MAX_TOKENS = {
   no_think: 1024,   // structured JSON answer, no think block
   think:    32768,  // think block + answer; Qwen + DeepSeek-R1 official recommendation
   tool:     512,    // single tool call response
   instruct: 1024,   // non-thinking model
};

function samplingOpts(model, think, bench) {
   const base = (() => {
      // Reasoning bench: fix sampling so think vs no_think is the only variable.
      // min_p 0 per Qwen spec (llama.cpp default is 0.1 which prunes unexpectedly).
      if (bench === 'reasoning') return { temperature: 0.6, top_p: 0.95, top_k: 20, min_p: 0 };
      // Toolcalling: top_k + min_p per Qwen spec.
      if (bench === 'toolcalling') return { temperature: 0.4, top_p: 0.9, top_k: 20, min_p: 0 };
      const f = model.family ?? '';
      if (f.startsWith('qwen3.5') || f.startsWith('qwen3.6')) {
         // Official Qwen3/3.5 guidance: both modes set min_p 0. No greedy decoding in think mode.
         return think
            ? { temperature: 0.6, top_p: 0.95, top_k: 20, min_p: 0 }
            : { temperature: 0.7, top_p: 0.8,  top_k: 20, min_p: 0, presence_penalty: 1.5 };
      }
      if (f.startsWith('qwen3')) {
         return think
            ? { temperature: 0.6, top_p: 0.95, top_k: 20, min_p: 0 }
            : { temperature: 0.7, top_p: 0.8,  top_k: 20, min_p: 0 };
      }
      if (f.startsWith('deepseek')) {
         // DeepSeek guidance intentionally differs: min_p 0.01/0.05 (not 0).
         return modelId(model).includes('0528')
            ? { temperature: 0.6, top_p: 0.95, min_p: 0.01 }
            : { temperature: 0.6, top_p: 0.95, min_p: 0.05 };
      }
      // Non-thinking instruct models (llama, mistral, phi, gemma, qwen2.5, granite).
      return { temperature: 0.1 };
   })();
   return base;
}

/**
 * Warn and record when a model hit max_tokens instead of its natural stop token.
 * This is a model failure (failed to converge within a generous budget), not a
 * harness failure — but we must surface it immediately, not silently.
 */
function warnRunaway(bench, id, reason) {
   if (reason === 'length') {
      console.warn(`    [RUNAWAY] ${bench}/${id}: hit max_tokens ceiling — model did not converge`);
   }
}

// ── Results ────────────────────────────────────────────────────────────────────
const RESULTS_DIR = join(ROOT, 'results');
const RESULTS_TSV = join(RESULTS_DIR, 'results.tsv');
mkdirSync(RESULTS_DIR, { recursive: true });

const TSV_HEADER = 'target\tkv\tmodel\tthink\tbench\tscore\thalls\tjson_fail\ttok_s\tvram_mib\tctx_loaded\tstatus\twall_s\tnotes\n';
if (!existsSync(RESULTS_TSV)) appendFileSync(RESULTS_TSV, TSV_HEADER);

function tsvKey(kv, model, think, bench) { return `${TARGET}\t${kv}\t${model}\t${think}\t${bench}`; }

function loadDoneKeys() {
   if (!existsSync(RESULTS_TSV)) return new Set();
   return new Set(
      readFileSync(RESULTS_TSV, 'utf8').split('\n').slice(1).filter(Boolean)
         .map((l) => l.split('\t').slice(0, 5).join('\t'))
   );
}

function appendTsv(row) { appendFileSync(RESULTS_TSV, Object.values(row).join('\t') + '\n'); }

// promptfoo JSON accumulator for visualization
const pfResults = [];

function recordPf({ bench, model, think, kv, vars, promptRaw, output, gradingResult, latencyMs, tokS }) {
   const tl = think === null ? 'n/a' : think ? 'think' : 'no_think';
   pfResults.push({
      provider:  { id: `llamacpp:${modelId(model)}`, label: `${model.label} [${tl}] KV=${kv}` },
      prompt:    { raw: promptRaw, label: bench },
      vars,
      response:  { output, metadata: { tok_per_sec: tokS } },
      gradingResult,
      success:   gradingResult?.pass ?? false,
      score:     gradingResult?.score ?? 0,
      latencyMs: latencyMs ?? 0,
   });
}

function flushPfJson() {
   if (!pfResults.length) return;
   const ts = new Date().toISOString().replace(/[:.]/g, '-');
   const out = join(RESULTS_DIR, `run-${ts}.json`);
   const s = pfResults.filter((r) => r.success).length;
   const f = pfResults.filter((r) => !r.success).length;
   writeFileSync(out, JSON.stringify({
      results: { version: 3, timestamp: new Date().toISOString(), results: pfResults, stats: { successes: s, failures: f, errors: 0 } },
      config: { description: `llm-bench target=${TARGET}` },
   }, null, 2));
   console.log(`\n[run-suite] promptfoo JSON → ${out}`);
   console.log(`[run-suite] View: npx promptfoo view ${out}`);
}

// ── Reasoning questions (inline — avoids a config file import) ─────────────────
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

const SUMM_ITEMS = {
   'rag-paper':          { title: 'Agentic RAG whitepaper', content: 'Covers multi-step reasoning with retrieval, tool use, and LLM orchestration. Describes how agents decompose queries into sub-tasks, retrieve relevant context at each step, and synthesize answers using chained tool calls.' },
   'trance-compression': { title: 'Sidechain compression for trance pumping', content: 'Classic trance pumping effect: sidechain a compressor on bass and pads keyed to the kick drum. Attack 0.1ms, release 80-150ms for the pump feel. Ghost kick sidechain keeps it in time without audible kick bleed.' },
   'trading-0dte':       { title: '0DTE options theta decay', content: 'Zero-days-to-expiry SPX options accelerate theta decay after 2pm. Selling premium after 2pm captures the steepest part of the intraday theta curve but gamma risk is highest in the last 30 minutes.' },
   'qmk-debounce':       { title: 'Keyboard debouncing in QMK firmware', content: 'QMK supports eager, defer-until-idle, and sym_eager_pk debounce algorithms. Eager fires immediately on press and delays release; sym_eager_pk is best for per-key debounce on split keyboards with noisy switches.' },
   'zettelkasten':       { title: 'Zettelkasten vs folder hierarchies for PKM', content: 'Dense bidirectional links between atomic notes outperform deep folder hierarchies for knowledge retrieval. Each note has exactly one idea; links surface unexpected connections better than any taxonomy.' },
   'salary-negotiation': { title: 'Negotiating a senior engineer offer', content: 'Anchor high on total compensation including equity refresh. Use competing offers as leverage. Recruiter call script: confirm base, then move to signing bonus and RSU refresh before benefits.' },
};

const TOOL_USER_REQUESTS = {
   'weather-basic':      'What is the weather in Tokyo right now?',
   'weather-unit':       'What is the temperature in Berlin in Fahrenheit?',
   'add-list':           'Add up these numbers for me: 12, 30, and 8.',
   'currency':           'Convert 250 US dollars to euros.',
   'email-fields':       'Email alice@example.com with the subject "Lunch" and tell her I will be 10 minutes late.',
   'pick-right-tool':    'Find wireless headphones in the catalog, show me 5.',
   'distractor-tools':   'How much is 1000 Japanese yen in British pounds?',
   'no-tool-needed':     'Thanks, that is all I needed. Have a good day!',
   'missing-tool':       'Please book me a flight from London to New York tomorrow.',
   'numbers-from-prose': 'I bought three items costing seven dollars, fifteen dollars, and twenty-two dollars. What is the total?',
};

// ── Bench runners ──────────────────────────────────────────────────────────────

async function runTriage(client, model, think, kv) {
   const opts = samplingOpts(model, think, 'triage');
   // In think mode, never force a JSON grammar — the grammar blocks <think> tokens
   // and prevents the model from emitting its natural EOS. Graders already strip think.
   const maxTok = think ? MAX_TOKENS.think : MAX_TOKENS.no_think;
   const itemResults = [];
   let totalMs = 0, halls = 0, jsonFail = 0;
   const tokList = [];

   for (const item of GOLDEN) {
      const messages = [
         { role: 'system', content: TRIAGE_STATIC_PROMPT },
         { role: 'user',   content: `Title: ${item.title}\nContent preview:\n${item.content_preview}` },
      ];
      const t0 = Date.now();
      let resp;
      try {
         resp = await client.chat(messages, {
            think,
            responseFormat: think ? null : TRIAGE_SCHEMA,
            max_tokens: maxTok,
            ...opts,
         });
      } catch (e) {
         console.error(`    triage error on ${item.id}: ${e.message.slice(0, 80)}`);
         itemResults.push({ item, grade: { scores: {}, parsedOk: false, anchorHallucination: false } });
         continue;
      }
      const latencyMs = Date.now() - t0;
      totalMs += latencyMs;
      const raw = client.content(resp);
      const tps = client.tokPerSec(resp);
      if (tps) tokList.push(tps);
      warnRunaway('triage', item.id, client.finishReason(resp));
      const grade = triageGradeOne(item, raw);
      if (grade.anchorHallucination) halls++;
      if (!grade.parsedOk) jsonFail++;
      itemResults.push({ item, grade, tps, latencyMs });
      recordPf({ bench: 'triage', model, think, kv, vars: { item_id: item.id }, promptRaw: messages[1].content, output: raw, gradingResult: triageGrader(raw, { vars: { item_id: item.id } }), latencyMs, tokS: tps?.toFixed(1) });
   }

   const { total: score } = triageComputeScore(itemResults);
   const avgTps = tokList.length ? (tokList.reduce((a, b) => a + b) / tokList.length) : 0;
   return { score: score.toFixed(1), halls, json_fail: jsonFail, tok_s: avgTps.toFixed(1), wall_s: (totalMs / 1000).toFixed(0) };
}

async function runReasoning(client, model, think, kv) {
   const opts = samplingOpts(model, think, 'reasoning');
   const ANSWER_SCHEMA = { type: 'object', properties: { answer: { type: 'string' } }, required: ['answer'] };
   const SYSTEM = 'You are solving short reasoning problems. Work out the correct answer.\nRespond ONLY with JSON: {"answer": "<your final answer, as short as possible>"}.\nPut just the final value in "answer" — a number or single word where possible, no explanation.';

   let correct = 0, errors = 0, totalMs = 0;
   const tokList = [];

   for (const [caseId] of Object.entries(REASON_CASES)) {
      const q = REASON_QUESTIONS[caseId];
      if (!q) continue;
      const messages = [{ role: 'system', content: SYSTEM }, { role: 'user', content: q }];
      const t0 = Date.now();
      let resp;
      const maxTok = think ? MAX_TOKENS.think : MAX_TOKENS.no_think;
      // In think mode, omit the JSON grammar so the model can emit its think block
      // then the answer, stopped by its native EOS — grader strips think before parsing.
      try { resp = await client.chat(messages, { think, responseFormat: think ? null : ANSWER_SCHEMA, max_tokens: maxTok, ...opts }); }
      catch { errors++; continue; }
      const latencyMs = Date.now() - t0;
      totalMs += latencyMs;
      const tps = client.tokPerSec(resp);
      if (tps) tokList.push(tps);
      const raw = client.content(resp);
      warnRunaway('reasoning', caseId, client.finishReason(resp));
      const gradingResult = reasoningGrader(client.stripThink(raw), { vars: { case_id: caseId } });
      if (gradingResult.pass) correct++;
      recordPf({ bench: 'reasoning', model, think, kv, vars: { case_id: caseId, question: q }, promptRaw: q, output: raw, gradingResult, latencyMs, tokS: tps?.toFixed(1) });
   }

   const total = Object.keys(REASON_CASES).length;
   const avgTps = tokList.length ? (tokList.reduce((a, b) => a + b) / tokList.length) : 0;
   return { score: (correct / total * 100).toFixed(1), halls: '-', json_fail: errors, tok_s: avgTps.toFixed(1), wall_s: (totalMs / 1000).toFixed(0) };
}

async function runToolcalling(client, model, kv) {
   const opts = samplingOpts(model, false, 'toolcalling');
   const SYSTEM = 'You are a helpful assistant with access to tools. Call a tool ONLY when it is needed. If no available tool fits, or no tool is needed, respond in plain text WITHOUT calling any tool.';

   let pass = 0, totalMs = 0;

   for (const [caseId] of Object.entries(TOOL_CASES)) {
      const userMsg = TOOL_USER_REQUESTS[caseId] ?? caseId;
      const tools = TOOL_CASES[caseId].tools.map((n) => TOOLS_POOL[n]).filter(Boolean);
      const messages = [{ role: 'system', content: SYSTEM }, { role: 'user', content: userMsg }];
      const t0 = Date.now();
      let resp;
      try { resp = await client.chat(messages, { think: false, tools, max_tokens: MAX_TOKENS.tool, ...opts }); }
      catch { continue; }
      const latencyMs = Date.now() - t0;
      totalMs += latencyMs;
      const calls = client.toolCalls(resp);
      const output = JSON.stringify(calls);
      const gradingResult = toolGrader(output, { vars: { case_id: caseId } });
      if (gradingResult.pass) pass++;
      recordPf({ bench: 'toolcalling', model, think: false, kv, vars: { case_id: caseId }, promptRaw: userMsg, output, gradingResult, latencyMs, tokS: null });
   }

   const total = Object.keys(TOOL_CASES).length;
   return { score: (pass / total * 100).toFixed(1), halls: '-', json_fail: '-', tok_s: '-', wall_s: (totalMs / 1000).toFixed(0) };
}

async function runSummarization(client, model, think, kv) {
   const opts = samplingOpts(model, think, 'summarization');
   const SYSTEM = 'You are summarizing and categorizing content for a personal knowledge vault.\nThe vault has 4 areas: craft (software, AI, hardware, PKM), finance (trading, markets), music (DJing, production), work (career, employer).\n\nRespond with JSON only:\n{\n  "summary": "<1-2 sentence factual summary>",\n  "area": "<craft|finance|music|work>",\n  "tags": ["<area/subtag>", ...]\n}';

   let totalScore = 0, totalMs = 0, count = 0;

   for (const [caseId, item] of Object.entries(SUMM_ITEMS)) {
      const messages = [{ role: 'system', content: SYSTEM }, { role: 'user', content: `Title: ${item.title}\n\n${item.content}` }];
      const t0 = Date.now();
      let resp;
      const summMaxTok = think ? MAX_TOKENS.think : MAX_TOKENS.no_think;
      try { resp = await client.chat(messages, { think: think ?? null, max_tokens: summMaxTok, ...opts }); }
      catch { continue; }
      const latencyMs = Date.now() - t0;
      totalMs += latencyMs;
      const raw = client.stripThink(client.content(resp));
      const gradingResult = summGrader(raw, { vars: { case_id: caseId } });
      totalScore += gradingResult.score ?? 0;
      count++;
      recordPf({ bench: 'summarization', model, think, kv, vars: { case_id: caseId }, promptRaw: messages[1].content, output: raw, gradingResult, latencyMs, tokS: null });
   }

   return { score: count ? (totalScore / count * 100).toFixed(1) : '?', halls: '-', json_fail: '-', tok_s: '-', wall_s: (totalMs / 1000).toFixed(0) };
}

// runSpeed removed — replaced by llama-bench (runners/llama-bench.mjs).

// ── Dry-run ────────────────────────────────────────────────────────────────────
function dryRun() {
   const models  = filterModels();
   const kvTypes = FILTER_KV.length ? FILTER_KV : (modelsConfig.kv_configs?.llamacpp ?? ['f16','q8_0','q4_0','k8v4']);
   const starts  = models.length * kvTypes.length;

   console.log(`\nDry-run — target=${TARGET}  LLAMA_URL=${LLAMA_URL}\n`);
   console.log(`${models.length} models × ${kvTypes.length} KV configs = ${starts} server starts\n`);

   for (const m of models) {
      const b = (m.benches ?? []).filter((x) => !FILTER_BENCHES.length || FILTER_BENCHES.includes(x));
      console.log(`  ${modelId(m).padEnd(55)} benches=[${b.join(',')}]`);
      for (const kv of kvTypes) {
         const [ctk, ctv] = kv === 'k8v4' ? ['q8_0', 'q4_0'] : [kv, kv];
         console.log(`    KV=${kv.padEnd(5)} ctk=${ctk} ctv=${ctv}`);
      }
   }
   console.log(`\nTotal server starts: ${starts}`);
}

if (DRY_RUN) { dryRun(); process.exit(0); }

// ── Main ──────────────────────────────────────────────────────────────────────
const { llamacppServer } = await import('./llamacpp-server.mjs');
const { runLlamaBench }  = await import('./llama-bench.mjs');
const srv      = llamacppServer({ sshHost: SSH_HOST, llamaUrl: LLAMA_URL });
const models   = filterModels();
const kvTypes  = FILTER_KV.length ? FILTER_KV : (modelsConfig.kv_configs?.llamacpp ?? ['f16','q8_0','q4_0','k8v4']);
const doneKeys = flags.resume ? loadDoneKeys() : new Set();

// Kill any orphaned llama-server on the remote host before starting.
console.log('[run-suite] sweeping remote for orphaned llama-server processes...');
await srv.stop();

// On SIGINT / SIGTERM: stop the remote server before exiting so nothing is left dangling.
async function shutdown(sig) {
   console.log(`\n[run-suite] ${sig} received — stopping remote server...`);
   await srv.stop();
   process.exit(1);
}
process.on('SIGINT',  () => shutdown('SIGINT'));
process.on('SIGTERM', () => shutdown('SIGTERM'));

console.log(`\n[run-suite] ${models.length} models × ${kvTypes.length} KV = ${models.length * kvTypes.length} server starts`);
console.log(`[run-suite] LLAMA_URL=${LLAMA_URL}  SSH=${SSH_HOST}\n`);

for (const model of models) {
   // required: template enforces thinking — only run think:true (false would be misrepresented).
   // optional: run both modes — the think vs no_think comparison is the data point.
   // none:     no thinking mode at all — pass think:null (no chat_template_kwargs sent).
   const thinkModes = model.think === 'required' ? [true]
                    : model.think === 'optional' ? [false, true]
                    : [null];
   const benches       = (model.benches ?? []).filter((b) => !FILTER_BENCHES.length || FILTER_BENCHES.includes(b));
   const mid           = modelId(model);

   for (const [kvIdx, kv] of kvTypes.entries()) {
      const [ctk, ctv] = kv === 'k8v4' ? ['q8_0', 'q4_0'] : [kv, kv];
      const isFirstKv  = kvIdx === 0;

      console.log(`\n${'═'.repeat(70)}`);
      console.log(`  ${model.label}  KV=${kv}  (ctk=${ctk} ctv=${ctv})`);
      console.log('═'.repeat(70));

      // Start server — downloads model on first use, auto-probes largest fitting context
      let ctxLoaded, vramMib;    // mutable: ensureAlive() may update on restart
      try {
         ({ ctxLoaded, vramMib } = await srv.start({ hf_repo: model.hf_repo, hf_file: model.hf_file, ctk, ctv }));
      } catch (e) {
         console.error(`  [error] ${e.message}`);
         appendTsv({ target: TARGET, kv, model: mid, think: '-', bench: 'load', score: '?', halls: '-', json_fail: '-', tok_s: '-', vram_mib: '-', ctx_loaded: '-', status: `error:${e.message.slice(0, 60)}`, wall_s: '-', notes: '' });
         continue;
      }

      const client = srv.client;
      const startOpts = { hf_repo: model.hf_repo, hf_file: model.hf_file, ctk, ctv };

      /** Restart the server if it has crashed. Returns false if restart fails. */
      async function ensureAlive() {
         const alive = await client.waitHealthy(5_000).then(() => true).catch(() => false);
         if (alive) return true;
         console.warn('  [warn] server died, restarting...');
         try {
            const r = await srv.start(startOpts);
            ctxLoaded = r.ctxLoaded;
            vramMib   = r.vramMib;
            return true;
         } catch (e) {
            console.error(`  [error] restart failed: ${e.message}`);
            return false;
         }
      }

      for (const think of thinkModes) {
         const tl = think === null ? 'n/a' : think ? 'think' : 'no_think';

         if (benches.includes('triage')) {
            const key = tsvKey(kv, mid, tl, 'triage');
            if (flags.resume && doneKeys.has(key)) { console.log(`  [triage ${tl}] skip`); }
            else if (await ensureAlive()) {
               process.stdout.write(`  [triage ${tl}] `);
               const r = await runTriage(client, model, think, kv);
               const vram = await srv.snapshotVram();
               console.log(`score=${r.score}  halls=${r.halls}  json_fail=${r.json_fail}  tok/s=${r.tok_s}  vram=${vram ?? '?'}MiB`);
               appendTsv({ target: TARGET, kv, model: mid, think: tl, bench: 'triage', score: r.score, halls: r.halls, json_fail: r.json_fail, tok_s: r.tok_s, vram_mib: vram ?? '?', ctx_loaded: ctxLoaded, status: 'ok', wall_s: r.wall_s, notes: '' });
            }
         }

         if (benches.includes('reasoning')) {
            const key = tsvKey(kv, mid, tl, 'reasoning');
            if (flags.resume && doneKeys.has(key)) { console.log(`  [reasoning ${tl}] skip`); }
            else if (await ensureAlive()) {
               process.stdout.write(`  [reasoning ${tl}] `);
               const r = await runReasoning(client, model, think, kv);
               console.log(`accuracy=${r.score}%  tok/s=${r.tok_s}`);
               appendTsv({ target: TARGET, kv, model: mid, think: tl, bench: 'reasoning', score: r.score, halls: '-', json_fail: r.json_fail, tok_s: r.tok_s, vram_mib: vramMib ?? '?', ctx_loaded: ctxLoaded, status: 'ok', wall_s: r.wall_s, notes: '' });
            }
         }

         if (benches.includes('toolcalling') && model.tools && think !== true) {
            const key = tsvKey(kv, mid, tl, 'toolcalling');
            if (flags.resume && doneKeys.has(key)) { console.log(`  [toolcalling] skip`); }
            else if (await ensureAlive()) {
               process.stdout.write(`  [toolcalling] `);
               const r = await runToolcalling(client, model, kv);
               console.log(`accuracy=${r.score}%`);
               appendTsv({ target: TARGET, kv, model: mid, think: tl, bench: 'toolcalling', score: r.score, halls: '-', json_fail: '-', tok_s: '-', vram_mib: vramMib ?? '?', ctx_loaded: ctxLoaded, status: 'ok', wall_s: r.wall_s, notes: '' });
            }
         }

         if (benches.includes('summarization') && think !== true) {
            const key = tsvKey(kv, mid, tl, 'summarization');
            if (flags.resume && doneKeys.has(key)) { console.log(`  [summarization] skip`); }
            else if (await ensureAlive()) {
               process.stdout.write(`  [summarization] `);
               const r = await runSummarization(client, model, think === null ? null : false, kv);
               console.log(`score=${r.score}`);
               appendTsv({ target: TARGET, kv, model: mid, think: tl, bench: 'summarization', score: r.score, halls: '-', json_fail: '-', tok_s: '-', vram_mib: vramMib ?? '?', ctx_loaded: ctxLoaded, status: 'ok', wall_s: r.wall_s, notes: '' });
            }
         }
      }

      // speed — now handled by llama-bench (per-model, after server loop); skipped here.

      // maxctx + toolcalling_decay — first KV pass only (KV-type-independent results)
      if (isFirstKv) {
         // maxctx: ctxLoaded from auto-probe above IS the result
         if (benches.includes('maxctx')) {
            const key = tsvKey(kv, mid, '-', 'maxctx');
            if (!(flags.resume && doneKeys.has(key))) {
               console.log(`  [maxctx] ${ctxLoaded.toLocaleString()} tokens (${(ctxLoaded * 4).toLocaleString()} chars)  vram=${vramMib ?? '?'}MiB`);
               appendTsv({ target: TARGET, kv, model: mid, think: '-', bench: 'maxctx', score: ctxLoaded, halls: '-', json_fail: '-', tok_s: '-', vram_mib: vramMib ?? '?', ctx_loaded: ctxLoaded, status: 'ok', wall_s: '-', notes: '' });
            }
         }

         if (benches.includes('toolcalling_decay') && model.tools) {
            const key = tsvKey(kv, mid, 'no_think', 'toolcalling_decay');
            if (flags.resume && doneKeys.has(key)) { console.log(`  [toolcalling_decay] skip`); }
            else if (await ensureAlive()) {
               process.stdout.write(`  [toolcalling_decay] `);
               const t0 = Date.now();
               const { stdout } = await execP(
                  'node', [join(ROOT, 'benchmarks/toolcalling/decay-bench.mjs'), mid],
                  { env: { ...process.env, LLAMA_URL }, timeout: 3_600_000 }
               ).catch((e) => ({ stdout: '', stderr: e.message }));
               const decayRows = [...stdout.matchAll(/^\s+(\d+)\s+\d+\s+([\d.]+)%/gm)].map((m) => `r${m[1]}=${m[2]}%`);
               const wall = ((Date.now() - t0) / 1000).toFixed(0);
               console.log(decayRows.join(' ') || 'done');
               appendTsv({ target: TARGET, kv, model: mid, think: 'no_think', bench: 'toolcalling_decay', score: '-', halls: '-', json_fail: '-', tok_s: '-', vram_mib: vramMib ?? '?', ctx_loaded: ctxLoaded, status: 'ok', wall_s: wall, notes: decayRows.join(' ') });
            }
         }
      }

      // longctx — passkey + multifact (all KV passes; this IS the KV sweep)
      if (benches.includes('longctx')) {
         const key = tsvKey(kv, model.tag, '-', 'longctx');
         if (flags.resume && doneKeys.has(key)) { console.log(`  [longctx] skip`); }
         else if (await ensureAlive()) {
            process.stdout.write(`  [longctx] `);
            const t0 = Date.now();
            const llamaEnv = { ...process.env, LLAMA_URL };
            const [pkOut, mfOut] = await Promise.all([
               execP('node', [join(ROOT, 'benchmarks/longctx/passkey-bench.mjs'), '24000', kv, mid], { env: llamaEnv, timeout: 600_000 }).catch(() => ({ stdout: '' })),
               execP('node', [join(ROOT, 'benchmarks/longctx/multifact-bench.mjs'), '24000', kv, mid], { env: llamaEnv, timeout: 600_000 }).catch(() => ({ stdout: '' })),
            ]);
            const pkScore = pkOut.stdout.split('\n').find((l) => l.startsWith('RESULT\t'))?.split('\t')[4] ?? '?';
            const mfScore = mfOut.stdout.split('\n').find((l) => l.startsWith('RESULT_MULTIFACT\t'))?.split('\t')[4] ?? '?';
            const wall = ((Date.now() - t0) / 1000).toFixed(0);
            console.log(`passkey=${pkScore}  multifact=${mfScore}`);
            appendTsv({ target: TARGET, kv, model: mid, think: '-', bench: 'longctx', score: pkScore, halls: '-', json_fail: '-', tok_s: '-', vram_mib: vramMib ?? '?', ctx_loaded: ctxLoaded, status: 'ok', wall_s: wall, notes: `multifact=${mfScore}` });
         }
      }

      await srv.stop();
   }

   // ── llama-bench perf pass (runs after server loop, no server needed) ──────
   // Only for models that have 'speed' in their bench list.
   if ((model.benches ?? []).includes('speed') && (!FILTER_BENCHES.length || FILTER_BENCHES.includes('speed'))) {
      const perfKey = tsvKey('all', mid, '-', 'speed_pp');
      if (flags.resume && doneKeys.has(perfKey)) {
         console.log(`  [llama-bench] skip (already in results)`);
      } else {
         try {
            const perfRows = await runLlamaBench({ sshHost: SSH_HOST, hf_file: model.hf_file });
            for (const r of perfRows) {
               appendTsv({
                  target: TARGET, kv: r.kv, model: mid, think: '-', bench: r.bench,
                  score: r.avg_ts.toFixed(1), halls: '-', json_fail: '-',
                  tok_s: r.avg_ts.toFixed(1), vram_mib: '-', ctx_loaded: '-',
                  status: 'ok', wall_s: '-',
                  notes: `stddev=${r.stddev_ts.toFixed(1)}`,
               });
            }
         } catch (e) {
            console.error(`  [llama-bench] error: ${e.message}`);
         }
      }
   }
}

flushPfJson();
console.log(`\n[run-suite] Done. Results: ${RESULTS_TSV}`);
