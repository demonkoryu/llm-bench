/**
 * Grader for the coding benchmark.
 *
 * Extracts a JavaScript function from the model output, then executes it against
 * each case's HIDDEN tests in an isolated child-process sandbox
 * (./coding-harness.mjs). Scoring is two-level:
 *   - score (partial credit) = passed tests / total tests for the problem
 *   - pass (pass@1)           = every test passed
 *
 * Execution is async (it spawns a process per case), so run-suite awaits
 * gradeCase. The parent enforces a wall-clock timeout — a model that emits
 * `while(true){}` is killed and scored 0 rather than hanging the suite.
 */

import { execFile } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
// Code extraction lives in the shared LLM layer (reusable across products) and
// is Gemma4-channel-aware + handles unfenced `class` output — see repair.mjs.
import { extractCode } from '../../shared/llm/index.mjs';

const __dir = dirname(fileURLToPath(import.meta.url));
const HARNESS = join(__dir, 'coding-harness.mjs');

function runHarness(payload, timeoutMs) {
   return new Promise((resolve) => {
      const dir = mkdtempSync(join(tmpdir(), 'llmbench-coding-'));
      const file = join(dir, 'payload.json');
      writeFileSync(file, JSON.stringify(payload));
      execFile(process.execPath, [HARNESS, file], { timeout: timeoutMs, maxBuffer: 1 << 20, killSignal: 'SIGKILL' }, (err, stdout) => {
         rmSync(dir, { recursive: true, force: true });
         // timeout → err.killed true; harness non-zero exit → err set but stdout has JSON
         if (err?.killed) {
            resolve({ ok: false, reason: 'timeout', passed: 0, total: payload.tests.length, results: [] });
            return;
         }
         try {
            resolve(JSON.parse(String(stdout).trim().split('\n').pop()));
         } catch {
            resolve({ ok: false, reason: 'harness-crash', passed: 0, total: payload.tests.length, results: [] });
         }
      });
   });
}

/**
 * Grade one case. caseObj must carry { entry, tests }.
 * Returns { pass, score, passed, total, reason }.
 */
export async function gradeCase(caseObj, output, { timeoutMs = 5000 } = {}) {
   const total = caseObj.tests.length;
   const { code, fenced } = extractCode(output, { lang: 'js' });

   if (!code || !/[a-z]/i.test(code)) {
      return { pass: false, score: 0, passed: 0, total, reason: 'no-code: empty extraction' };
   }

   const res = await runHarness({ code, entry: caseObj.entry, tests: caseObj.tests }, timeoutMs);

   if (!res.ok) {
      // define-error / no-entry / timeout / harness-crash
      const tag = res.reason?.split(':')[0] ?? 'runtime-error';
      return { pass: false, score: 0, passed: 0, total, reason: `${tag}${fenced ? '' : ' (recovered, no fence)'}` };
   }

   const passed = res.passed ?? 0;
   const score = total ? passed / total : 0;
   const pass = passed === total && total > 0;
   let reason;
   if (pass) {
      reason = `pass: ${passed}/${total}`;
   } else {
      const firstWrong = (res.results ?? []).find((r) => !r.pass);
      const detail = firstWrong?.error ? `err="${firstWrong.error}"` : firstWrong ? `case#${firstWrong.i} got ${firstWrong.got}` : '';
      reason = `wrong: ${passed}/${total} ${detail}`.trim();
   }
   return { pass, score, passed, total, reason };
}

/**
 * Aggregate over a {caseId: caseObj} map and a {caseId: output} map.
 * Returns { pass_at_1, test_pass_rate, per_case }.
 */
export async function gradeAll(cases, outputs, opts = {}) {
   const per_case = [];
   let passAt1 = 0;
   let testsPassed = 0;
   let testsTotal = 0;
   for (const [id, caseObj] of Object.entries(cases)) {
      const r = await gradeCase(caseObj, outputs[id] ?? '', opts);
      if (r.pass) {
         passAt1++;
      }
      testsPassed += r.passed;
      testsTotal += r.total;
      per_case.push({ id, category: caseObj.category, difficulty: caseObj.difficulty, ...r });
   }
   const n = Object.keys(cases).length;
   return {
      pass_at_1: n ? (passAt1 / n) * 100 : 0,
      test_pass_rate: testsTotal ? (testsPassed / testsTotal) * 100 : 0,
      per_case,
   };
}
