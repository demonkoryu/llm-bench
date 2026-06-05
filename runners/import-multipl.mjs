#!/usr/bin/env node

/**
 * MultiPL-E → llm-bench coding-case importer.
 *
 * Pulls the JavaScript variants of HumanEval / MBPP from the MultiPL-E dataset
 * (nuprl/MultiPL-E on the HF Hub) and emits a `cases-*.mjs` file in the exact
 * shape `benchmarks/coding/grader.mjs` consumes — a `{caseId: {entry, prompt,
 * signature, tests}}` map. The generated `cases-multipl.mjs` is the sole coding
 * source wired into run-suite (the `coding_multipl` bench).
 *
 * Why a converter and not a passthrough: MultiPL-E ships its test suite as a
 * Node `assert` harness —
 *     const assert = require('node:assert');
 *     function test(){ let candidate = NAME;
 *       assert.deepEqual(candidate(ARGS), EXPECTED); ... }
 *     test();
 * — but our grader runs model code in a `require`-free vm sandbox and compares a
 * RETURNED value to a literal `expected`. So we transform asserts into our
 * `{args, expected}` test form.
 *
 * Transformation is by EXECUTION, not regex: we run the `tests` string in a vm
 * with `candidate` rebound to a recorder (captures the call args, returns a
 * sentinel) and `require('node:assert')` rebound to a shim (captures the second
 * argument — the expected value). JS itself parses the (possibly deeply nested)
 * argument expressions, so the converter is robust to arrays/objects/strings
 * with embedded commas. Asserts that wrap or transform the candidate result
 * (e.g. `assert.deepEqual(candidate(x).length, 3)`) cannot be expressed as a
 * pure {args,expected} pair — those are dropped and reported, never silently
 * mis-imported.
 *
 * Fidelity notes:
 *   - Number comparison is exact (JSON-normalized deep-equality), matching
 *     MultiPL-E's own `assert.deepEqual`. Float-result problems inherit the same
 *     fragility they have upstream — flagged in the run summary, not hidden.
 *   - Expected values containing NaN/Infinity can't survive the harness's JSON
 *     normalization; such asserts are dropped and counted.
 *
 * Usage:
 *   node runners/import-multipl.mjs                       # 20 HumanEval-JS problems
 *   node runners/import-multipl.mjs --config mbpp-js --limit 30
 *   node runners/import-multipl.mjs --limit 0             # all (161 for humaneval-js)
 *   node runners/import-multipl.mjs --offset 40 --limit 20 --out benchmarks/coding/cases-multipl.mjs
 *
 * Options:
 *   --config <name>   MultiPL-E config: humaneval-js (default) | mbpp-js
 *   --limit  <n>      Number of problems to import (0 = all). Default 20.
 *   --offset <n>      Skip the first n problems. Default 0.
 *   --max-tests <n>   Cap tests kept per problem (0 = all). Default 0.
 *   --out    <path>   Output file. Default benchmarks/coding/cases-multipl.mjs
 *   --difficulty <s>  difficulty tag written on every case. Default 'medium'.
 */

import { writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseArgs } from 'node:util';
import { createContext, runInContext } from 'node:vm';

const __dir = dirname(fileURLToPath(import.meta.url));
const ROOT = join(__dir, '..');

const { values: flags } = parseArgs({
   options: {
      config: { type: 'string', default: 'humaneval-js' },
      limit: { type: 'string', default: '20' },
      offset: { type: 'string', default: '0' },
      'max-tests': { type: 'string', default: '0' },
      out: { type: 'string' },
      difficulty: { type: 'string', default: 'medium' },
   },
});

const CONFIG = flags.config;
const LIMIT = Number(flags.limit);
const OFFSET = Number(flags.offset);
const MAX_TESTS = Number(flags['max-tests']);
const DIFFICULTY = flags.difficulty;
const OUT = flags.out ? resolve(flags.out) : join(ROOT, 'benchmarks/coding/cases-multipl.mjs');

const DATASET = 'nuprl/MultiPL-E';
const API = 'https://datasets-server.huggingface.co/rows';

/** GET JSON with retry — the datasets-server returns transient 502/503 under load. */
async function fetchJson(url, { tries = 5 } = {}) {
   let lastErr;
   for (let i = 0; i < tries; i++) {
      try {
         const res = await fetch(url);
         if (res.ok) {
            return await res.json();
         }
         lastErr = new Error(`HTTP ${res.status}`);
         // 502/503/429 are transient; back off. 4xx (except 429) is fatal.
         if (res.status < 500 && res.status !== 429) {
            throw lastErr;
         }
      } catch (e) {
         lastErr = e;
      }
      await new Promise((r) => setTimeout(r, 800 * 2 ** i));
   }
   throw new Error(`datasets-server failed after ${tries} tries: ${lastErr?.message}`);
}

/** Page through the HF datasets-server rows API (max 100 rows/request). */
async function fetchRows(config, { offset, limit }) {
   const rows = [];
   const want = limit > 0 ? limit : Infinity;
   let cursor = offset;
   while (rows.length < want) {
      const length = Math.min(100, want === Infinity ? 100 : want - rows.length);
      const url = `${API}?dataset=${encodeURIComponent(DATASET)}&config=${encodeURIComponent(config)}&split=test&offset=${cursor}&length=${length}`;
      const json = await fetchJson(url);
      const page = (json.rows ?? []).map((r) => r.row);
      if (!page.length) {
         break; // reached the end of the split
      }
      rows.push(...page);
      cursor += page.length;
      if (json.num_rows_total != null && cursor >= json.num_rows_total) {
         break;
      }
   }
   return rows;
}

/** Pull the entry function name and split the prompt into description + signature line. */
function parsePrompt(prompt) {
   const m = prompt.match(/^\s*function\s+([A-Za-z_$][\w$]*)\s*\(/m);
   if (!m) {
      return null;
   }
   const entry = m[1];
   const sigLine = prompt
      .slice(m.index)
      .split('\n')[0]
      .replace(/\s*\{\s*$/, '')
      .trim();
   // Description = everything before the `function` line, with leading `// ` markers stripped.
   const desc = prompt
      .slice(0, m.index)
      .split('\n')
      .map((l) => l.replace(/^\s*\/\/\s?/, ''))
      .join('\n')
      .trim();
   return { entry, signature: sigLine, description: desc };
}

/** JSON round-trip → plain host value. Returns {ok:false} if not representable (NaN/Infinity/undefined/fn). */
function jsonClone(v) {
   try {
      const s = JSON.stringify(v);
      if (s === undefined) {
         return { ok: false };
      }
      return { ok: true, value: JSON.parse(s) };
   } catch {
      return { ok: false };
   }
}

/**
 * Execute a MultiPL-E `tests` string with instrumented candidate + assert and
 * return { tests: [{args, expected}], dropped, total }.
 */
function extractTests(entry, testsSrc) {
   const recArgs = [];
   const REC = '__mrec__';
   const recorder = (...args) => ({ [REC]: recArgs.push(args) - 1 });
   const pairs = [];
   const push = (got, expected) => pairs.push({ got, expected });
   const assertShim = {
      deepEqual: push,
      deepStrictEqual: push,
      equal: push,
      strictEqual: push,
      notEqual: () => {}, // can't be expressed as a positive {args,expected}
      notDeepEqual: () => {},
      ok: (g) => push(g, true),
   };
   const sandbox = {
      require: () => assertShim,
      console: { log() {}, error() {}, warn() {} },
      Math,
      JSON,
      Array,
      Object,
      String,
      Number,
      Boolean,
      Map,
      Set,
      Symbol,
      RegExp,
      Date,
      isNaN,
      isFinite,
      parseInt,
      parseFloat,
      Infinity,
      NaN,
      undefined,
      [entry]: recorder,
   };
   const ctx = createContext(sandbox);
   runInContext(testsSrc, ctx, { timeout: 4000 });

   const tests = [];
   let dropped = 0;
   for (const { got, expected } of pairs) {
      if (!got || typeof got !== 'object' || !(REC in got)) {
         dropped++; // assert wrapped/transformed the candidate result — not a pure call
         continue;
      }
      const argsC = jsonClone(recArgs[got[REC]]);
      const expC = jsonClone(expected);
      if (!argsC.ok || !expC.ok) {
         dropped++; // NaN/Infinity/undefined — not survivable through the grader's JSON normalize
         continue;
      }
      tests.push({ args: argsC.value, expected: expC.value });
   }
   return { tests, dropped, total: pairs.length };
}

// ── Main ─────────────────────────────────────────────────────────────────────
console.log(`[import-multipl] fetching ${DATASET} / ${CONFIG} (offset=${OFFSET}, limit=${LIMIT || 'all'})`);
const rows = await fetchRows(CONFIG, { offset: OFFSET, limit: LIMIT });
console.log(`[import-multipl] got ${rows.length} rows`);

const CASES = {};
const skipped = [];
let totalDropped = 0;
const floaty = [];

for (const row of rows) {
   const parsed = parsePrompt(row.prompt ?? '');
   if (!parsed) {
      skipped.push({ name: row.name, reason: 'no function signature in prompt' });
      continue;
   }
   let extracted;
   try {
      extracted = extractTests(parsed.entry, row.tests ?? '');
   } catch (e) {
      skipped.push({ name: row.name, reason: `tests threw: ${e.message.slice(0, 80)}` });
      continue;
   }
   let tests = extracted.tests;
   if (!tests.length) {
      skipped.push({ name: row.name, reason: `no usable asserts (${extracted.dropped}/${extracted.total} dropped)` });
      continue;
   }
   if (MAX_TESTS > 0 && tests.length > MAX_TESTS) {
      tests = tests.slice(0, MAX_TESTS);
   }
   totalDropped += extracted.dropped;
   if (tests.some((t) => JSON.stringify(t.expected).includes('.'))) {
      floaty.push(row.name); // has a non-integer expected → exact float comparison may be fragile
   }
   CASES[row.name] = {
      category: 'multipl',
      difficulty: DIFFICULTY,
      source: `${CONFIG}`,
      entry: parsed.entry,
      signature: parsed.signature,
      prompt: parsed.description,
      tests,
   };
}

const header = `/**
 * GENERATED by runners/import-multipl.mjs — DO NOT EDIT BY HAND.
 *
 * Source: ${DATASET} / ${CONFIG} (offset=${OFFSET}, limit=${LIMIT || 'all'})
 * Problems: ${Object.keys(CASES).length}   |   asserts dropped (non-pure): ${totalDropped}
 *
 * Each case is consumed by benchmarks/coding/grader.mjs: the model implements
 * \`entry\`, and the grader runs the {args, expected} tests in the vm sandbox. Regenerate
 * with: node runners/import-multipl.mjs --config ${CONFIG} --limit ${LIMIT}
 */

export const CASES = ${JSON.stringify(CASES, null, 3)};
`;

writeFileSync(OUT, header);

console.log(`\n[import-multipl] wrote ${Object.keys(CASES).length} cases → ${OUT}`);
console.log(`[import-multipl] asserts dropped as non-pure: ${totalDropped}`);
if (floaty.length) {
   console.log(
      `[import-multipl] ${floaty.length} problem(s) have float expected values (exact-match fragile): ${floaty.slice(0, 8).join(', ')}${floaty.length > 8 ? ' …' : ''}`,
   );
}
if (skipped.length) {
   console.log(`[import-multipl] skipped ${skipped.length} problem(s):`);
   for (const s of skipped.slice(0, 20)) {
      console.log(`    - ${s.name}: ${s.reason}`);
   }
   if (skipped.length > 20) {
      console.log(`    … and ${skipped.length - 20} more`);
   }
}
