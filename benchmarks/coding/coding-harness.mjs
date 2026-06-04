#!/usr/bin/env node

/**
 * Child-process sandbox driver for the coding benchmark.
 *
 * Invoked as: node coding-harness.mjs <payload.json>
 *   payload = { code: string, entry: string, tests: [{args, expected}] }
 *
 * Runs the model's `code` in a FRESH vm context with no require/process/module/fs
 * and no access to this process's globals, then calls `entry(...args)` for each
 * test and structurally compares the result to `expected`. The PARENT (grader.mjs)
 * owns the wall-clock kill — an infinite loop in model code is terminated there.
 *
 * Contract: prints exactly one JSON line to stdout and exits 0 even when tests
 * fail. A non-zero exit means the harness itself could not run (bad payload, code
 * that throws at definition time, or a missing entry function).
 */

import { readFileSync } from 'node:fs';
import { createContext, runInContext } from 'node:vm';

/** Structural deep-equality: handles nested arrays, plain objects, NaN. (-0 ≡ 0.) */
function deepEqual(a, b) {
   if (a === b) {
      return true;
   }
   if (typeof a === 'number' && typeof b === 'number') {
      return Number.isNaN(a) && Number.isNaN(b);
   }
   if (a === null || b === null || typeof a !== 'object' || typeof b !== 'object') {
      return false;
   }
   const aArr = Array.isArray(a);
   const bArr = Array.isArray(b);
   if (aArr !== bArr) {
      return false;
   }
   if (aArr) {
      if (a.length !== b.length) {
         return false;
      }
      for (let i = 0; i < a.length; i++) {
         if (!deepEqual(a[i], b[i])) {
            return false;
         }
      }
      return true;
   }
   const ak = Object.keys(a);
   const bk = Object.keys(b);
   if (ak.length !== bk.length) {
      return false;
   }
   for (const k of ak) {
      if (!Object.hasOwn(b, k) || !deepEqual(a[k], b[k])) {
         return false;
      }
   }
   return true;
}

function fail(reason) {
   process.stdout.write(`${JSON.stringify({ ok: false, reason, passed: 0, total: 0, results: [] })}\n`);
   process.exit(1);
}

const payloadPath = process.argv[2];
if (!payloadPath) {
   fail('no-payload-path');
}

let payload;
try {
   payload = JSON.parse(readFileSync(payloadPath, 'utf8'));
} catch (e) {
   fail(`bad-payload: ${e.message}`);
}

const { code, entry, tests } = payload;

// Minimal, frozen global surface. No require/process/module/fs/import — model
// code that reaches for them throws a ReferenceError inside the sandbox.
const sandbox = {
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
};
const context = createContext(sandbox);

// Define the model's code once in the sandbox context. Subsequent test
// evaluations (function calls or `call` expressions) reuse this same context,
// so the model's `entry` symbol — whether a function or a class — is in scope.
try {
   runInContext(code, context, { timeout: 4000 });
} catch (e) {
   fail(`define-error: ${e.message}`);
}

// Pure-function cases ({args}) need `entry` resolvable as a function. Stateful
// cases ({call}) drive a class/instance via an expression and skip this check.
const usesArgs = tests.some((t) => !t.call);
let fn;
if (usesArgs) {
   try {
      fn = runInContext(`;(${entry});`, context, { timeout: 1000 });
   } catch (e) {
      fail(`no-entry: ${e.message}`);
   }
   if (typeof fn !== 'function') {
      fail(`no-entry: \`${entry}\` is not a function (got ${typeof fn})`);
   }
}

const results = [];
let passed = 0;
for (let i = 0; i < tests.length; i++) {
   const t = tests[i];
   try {
      let got;
      if (t.call) {
         // Stateful test: evaluate the driver expression in the model's context.
         // The expression constructs/drives `entry` and returns observable state.
         got = runInContext(`;(${t.call});`, context, { timeout: 2000 });
      } else {
         // Deep-clone args so a mutating solution can't poison later tests.
         const args = JSON.parse(JSON.stringify(t.args ?? []));
         got = fn(...args);
      }
      // Normalize through JSON so sandbox-realm arrays/objects compare structurally.
      const norm = got === undefined ? undefined : JSON.parse(JSON.stringify(got));
      const pass = deepEqual(norm, t.expected);
      if (pass) {
         passed++;
      }
      results.push({ i, pass, got: pass ? undefined : safe(norm) });
   } catch (e) {
      results.push({ i, pass: false, error: String(e?.message ?? e) });
   }
}

/** JSON-safe preview of a wrong answer for the per-case reason string. */
function safe(v) {
   try {
      const s = JSON.stringify(v);
      return s && s.length > 120 ? `${s.slice(0, 120)}…` : s;
   } catch {
      return String(v);
   }
}

process.stdout.write(`${JSON.stringify({ ok: true, passed, total: tests.length, results })}\n`);
process.exit(0);
