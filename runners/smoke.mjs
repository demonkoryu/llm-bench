#!/usr/bin/env node

/**
 * Standalone smoke test — fast single-pass validation of the benchmark stack.
 * Requires a running llama-server. Does NOT start/stop the server.
 *
 * Usage:
 *   LLAMA_URL=http://192.168.1.120:8090 node runners/smoke.mjs
 *   LLAMA_URL=http://192.168.1.120:8090 BENCH_DEBUG=1 node runners/smoke.mjs
 *
 * Steps:
 *   1. Offline checks (codebase LCG parity, dataset load)
 *   2. Server health (503-aware)
 *   3. Short generation (confirms decode)
 *   4. Triage JSON (confirms response_format + JSON parsing)
 *   5. Tool call (confirms tools dispatch + single-step response)
 *   6. Reasoning (confirms basic Q&A)
 */

import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dir = dirname(fileURLToPath(import.meta.url));
const ROOT = join(__dir, '..');

const LLAMA_URL = process.env.LLAMA_URL ?? 'http://192.168.1.120:8090';
const DEBUG = !!process.env.BENCH_DEBUG;

const { createClient } = await import('../shared/llm/index.mjs');
const { stripThink, extractJson } = await import('../shared/llm/index.mjs');
const { verifyLcgParity } = await import('../shared/codebase.mjs');
const { GOLDEN } = await import('../shared/triage-golden.mjs');
const { TRIAGE_SCHEMA, TRIAGE_STATIC_PROMPT } = await import('../shared/triage-prompt.mjs');
const { CASES: TOOL_CASES, TOOLS_POOL } = await import('../benchmarks/toolcalling/toolcases.mjs');
const { CASES: REASON_CASES } = await import('../benchmarks/reasoning/cases.mjs');

const client = createClient(LLAMA_URL, { debug: DEBUG });

let passed = 0;
let failed = 0;

function pass(msg) {
   console.log(`  PASS  ${msg}`);
   passed++;
}
function fail(msg) {
   console.error(`  FAIL  ${msg}`);
   failed++;
}

console.log('=== llm-bench smoke test ===');
console.log(`  server: ${LLAMA_URL}`);
console.log('');

// ── Step 1: Offline checks ─────────────────────────────────────────────────────
console.log('[1/6] Offline checks...');

const { ok: lcgOk, probe0 } = verifyLcgParity();
lcgOk
   ? pass(`codebase LCG parity (probe0.answer=${probe0.answer} kind=${probe0.kind})`)
   : fail(`codebase LCG broken! probe0.answer=${probe0.answer}`);

const docqaCasesPath = join(ROOT, 'benchmarks/docqa/cases.json');
try {
   const dq = JSON.parse(readFileSync(docqaCasesPath, 'utf8'));
   pass(`docqa cases loaded (${dq.questions?.length ?? 0} questions)`);
} catch (e) {
   fail(`docqa cases not found: ${e.message}`);
}

pass(`triage golden loaded (${GOLDEN.length} items)`);
pass(`toolcalling cases loaded (${Object.keys(TOOL_CASES).length} cases)`);
pass(`reasoning cases loaded (${Object.keys(REASON_CASES).length} cases)`);

// ── Step 2: Health check ───────────────────────────────────────────────────────
console.log('\n[2/6] Server health...');
try {
   await client.waitHealthy(30_000);
   pass('server responding (non-503)');
} catch (e) {
   fail(`server not ready: ${e.message}`);
   console.error('\nSmoke aborted — server not responding. Start llama-server first.');
   process.exit(1);
}

// ── Step 3: Short generation ───────────────────────────────────────────────────
console.log('\n[3/6] Short generation...');
try {
   const { completion } = await client.chat(
      [{ role: 'user', content: 'Reply with exactly one word: "ready"' }],
      { max_tokens: 12, temperature: 0.0 },
      15_000,
   );
   const text = completion.choices?.[0]?.message?.content ?? '';
   const tps = client.tokPerSec();
   text.trim() ? pass(`generated "${text.trim()}"  decode_tps=${tps?.toFixed(1) ?? 'n/a'}`) : fail('empty response');
} catch (e) {
   fail(`error: ${e.message}`);
}

// ── Step 4: Triage JSON ────────────────────────────────────────────────────────
console.log('\n[4/6] Triage JSON (1 item, response_format)...');
const item = GOLDEN[0];
try {
   const { completion } = await client.chat(
      [
         { role: 'system', content: TRIAGE_STATIC_PROMPT },
         { role: 'user', content: `Title: ${item.title}\nContent preview:\n${item.content_preview}` },
      ],
      { think: false, responseFormat: TRIAGE_SCHEMA, max_tokens: 256 },
      30_000,
   );
   const raw = completion.choices?.[0]?.message?.content ?? '';
   const parsed = extractJson(stripThink(raw));
   parsed?.action
      ? pass(`triage parsed OK (action="${parsed.action}" area="${parsed.area}")`)
      : fail(`triage parse failed. raw="${raw.slice(0, 80)}"`);
} catch (e) {
   fail(`error: ${e.message}`);
}

// ── Step 5: Tool call ─────────────────────────────────────────────────────────
console.log('\n[5/6] Tool call (1 case, tools array)...');
const weatherCase = TOOL_CASES['weather-basic'];
const weatherTool = TOOLS_POOL.get_weather;
try {
   const { completion } = await client.chat(
      [
         { role: 'system', content: 'You are a helpful assistant with tools. Use them.' },
         { role: 'user', content: weatherCase.user },
      ],
      { think: false, tools: [weatherTool], max_tokens: 64 },
      30_000,
   );
   const calls = completion.choices?.[0]?.message?.tool_calls ?? [];
   calls.length > 0
      ? pass(`tool called: ${calls[0].function?.name} args=${JSON.stringify(calls[0].function?.arguments ?? {}).slice(0, 60)}`)
      : fail(`no tool call in response (finish=${completion.choices?.[0]?.finish_reason})`);
} catch (e) {
   fail(`error: ${e.message}`);
}

// ── Step 6: Reasoning ─────────────────────────────────────────────────────────
console.log('\n[6/6] Reasoning (1 question)...');
const firstReason = Object.entries(REASON_CASES)[0];
try {
   const { completion } = await client.chat(
      [
         { role: 'system', content: 'Answer briefly with just the answer.' },
         { role: 'user', content: firstReason[1].question },
      ],
      { max_tokens: 32, temperature: 0.0 },
      20_000,
   );
   const text = stripThink(completion.choices?.[0]?.message?.content ?? '');
   const accepted = firstReason[1].accepted;
   const correct = accepted.some((a) => text.toLowerCase().includes(a.toLowerCase()));
   correct ? pass(`"${text.trim()}" ∈ accepted answers`) : fail(`"${text.trim()}" not in accepted (${accepted.join('|')})`);
} catch (e) {
   fail(`error: ${e.message}`);
}

// ── Summary ───────────────────────────────────────────────────────────────────
console.log('');
console.log(`=== ${passed} passed, ${failed} failed ===`);
if (failed > 0) {
   console.error('Smoke FAILED — fix the issues above before running the full benchmark.');
   process.exit(1);
} else {
   console.log('Smoke PASSED — safe to run: node runners/run-suite.mjs --dry-run');
}
