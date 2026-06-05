#!/usr/bin/env node

/**
 * Coding ranking — one score per model from the sole coding source
 * (`coding_multipl`, imported MultiPL-E / HumanEval-JS), blending its two metrics:
 *
 *   • pass@1    — fraction of problems fully solved (the `score` column). Strict,
 *                 all-or-nothing per problem; acts as a competence floor.
 *   • test-rate — per-test pass rate (parsed from `notes` "tests N%"). More
 *                 granular; discriminates partial solutions.
 *
 * Combination (test-rate-weighted — mirrors shared/results-store.mjs codingGradeOf):
 *
 *     combined(state) = W_PASS1·pass@1 + W_TESTRATE·test_rate
 *
 * Think-state collapse — two policies, printed side by side:
 *   • best   : max over {no_think, think} — the model's achievable ceiling.
 *   • cold   : the no_think / null state only — rewards solving WITHOUT thinking
 *              (an efficiency signal; demotes models that need to think).
 *
 * Data: merges EVERY run under results/runs/ deterministically (ok beats error,
 * newest ts wins per (model, think, bench)), so corrected re-runs supersede the
 * originals automatically. Standalone — does NOT feed the multiplicative fleet
 * composite (that normalizes the same grade to a multiplier; this is the raw view).
 *
 *   node runners/coding-rank.mjs
 */

import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { loadAllRuns, mergeResultRows } from '../shared/results-store.mjs';

const W_PASS1 = 0.4;
const W_TESTRATE = 0.6;

const __dir = dirname(fileURLToPath(import.meta.url));
const RESULTS = join(__dir, '..', 'results');

// Strip the per-pass think suffix to get a stable base model id.
const baseId = (m) => m.replace(/--(think|nothi)$/, '');
// per-test rate lives in notes as "tests 91.7%"
const testRate = (notes) => {
   const m = /tests\s+([\d.]+)%/.exec(notes ?? '');
   return m ? Number(m[1]) : null;
};

// ── Merge all coding rows across every run (ok beats error, newest ts wins) ───
const runs = loadAllRuns(RESULTS);
const allRows = mergeResultRows(runs.flatMap((r) => r.results));
const merged = new Map(); // `${base}|${think}` → authoritative coding row
for (const r of allRows) {
   if (r.bench === 'coding_multipl') {
      merged.set(`${baseId(r.model)}|${r.think}`, r);
   }
}

// ── Pivot into per-model, per-state metrics ──────────────────────────────────
// model → { base, states: { <think>: { pass1, rate } } }
const models = new Map();
for (const r of merged.values()) {
   const base = baseId(r.model);
   if (!models.has(base)) {
      models.set(base, { base, states: {} });
   }
   const states = models.get(base).states;
   states[r.think] = { pass1: Number(r.score), rate: testRate(r.notes) };
}

function combined(st) {
   if (st.pass1 == null && st.rate == null) {
      return null;
   }
   const pass1 = Number.isFinite(st.pass1) ? st.pass1 : 0;
   const rate = st.rate ?? 0;
   return W_PASS1 * pass1 + W_TESTRATE * rate;
}

// ── Rank under both think-state policies ─────────────────────────────────────
const rows = [];
for (const { base, states } of models.values()) {
   const scored = Object.entries(states)
      .map(([think, st]) => ({ think, st, c: combined(st) }))
      .filter((x) => x.c != null);
   if (!scored.length) {
      continue;
   }
   // best-of-state
   const best = scored.reduce((a, b) => (b.c > a.c ? b : a));
   // cold: the no_think or null (n/a) state, if the model has one
   const coldEntry = scored.find((x) => x.think === 'no_think' || x.think === 'n/a');
   rows.push({
      base,
      bestScore: best.c,
      bestState: best.think,
      bestPass1: best.st.pass1,
      bestRate: best.st.rate,
      coldScore: coldEntry ? coldEntry.c : null,
   });
}

rows.sort((a, b) => b.bestScore - a.bestScore);

const pad = (s, n) => String(s).padEnd(n);
const num = (v, n = 5) => (v == null || !Number.isFinite(v) ? '—'.padStart(n) : v.toFixed(1).padStart(n));
console.log(`\nCoding score = ${W_PASS1}·pass@1 + ${W_TESTRATE}·test-rate   (${runs.length} runs merged)\n`);
console.log(pad('model', 34), pad('best', 6), pad('via', 9), pad('pass@1', 7), pad('tests', 6), pad('cold(no-think)', 14));
console.log('─'.repeat(83));
for (const r of rows) {
   console.log(
      pad(r.base.slice(0, 33), 34),
      num(r.bestScore, 5).padStart(6),
      pad(r.bestState, 9),
      num(r.bestPass1, 5).padStart(7),
      num(r.bestRate, 5).padStart(6),
      num(r.coldScore, 5).padStart(14),
   );
}
console.log(`\n${rows.length} models ranked. "best" = ceiling over think states; "cold" = no_think/null only.`);
