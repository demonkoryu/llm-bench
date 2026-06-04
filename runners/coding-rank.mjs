#!/usr/bin/env node

/**
 * Combined coding ranking — folds the easy (`coding`) and hard (`coding_hard`)
 * tiers into ONE score per model.
 *
 * Metric per tier (each tier's most granular signal):
 *   • easy → pass@1   (fraction of the 18 function problems fully solved; the
 *                      `score` column). Granular, spreads the weak models.
 *   • hard → test-rate (passed/12 on the 2048 engine; parsed from `notes`
 *                      "tests N%"). pass@1 on a single hard case is binary, so
 *                      test-rate is the signal that separates 4/12 from 11/12.
 *
 * Combination (hard-weighted — easy ceilings and acts as a competence gate,
 * hard is the discriminator):
 *
 *     combined(state) = W_EASY·easy_pass@1 + W_HARD·hard_test_rate
 *
 * Think-state collapse — two policies, printed side by side:
 *   • best   : max over {no_think, think} — the model's achievable ceiling.
 *   • cold   : the no_think / null state only — rewards solving hard WITHOUT
 *              thinking (an efficiency signal; demotes models that need to think).
 *
 * Data: merges every results/llm-benchmarks-*.csv, newest-file-wins per
 * (model, think, bench), so corrected re-runs (e.g. Gemma at temp 1.0)
 * supersede the originals automatically. Standalone — does NOT feed the
 * multiplicative fleet composite (coding is a reported axis per project policy).
 *
 *   node runners/coding-rank.mjs
 */

import { readdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { readTable } from '../shared/results-csv.mjs';

const W_EASY = 0.3;
const W_HARD = 0.7;

const __dir = dirname(fileURLToPath(import.meta.url));
const RESULTS = join(__dir, '..', 'results');

// Strip the per-pass think suffix to get a stable base model id.
const baseId = (m) => m.replace(/--(think|nothi)$/, '');
// hard test-rate lives in notes as "tests 91.7%"
const testRate = (notes) => {
   const m = /tests\s+([\d.]+)%/.exec(notes ?? '');
   return m ? Number(m[1]) : null;
};

// ── Merge all coding rows, newest file wins per (base, think, bench) ──────────
const files = readdirSync(RESULTS)
   .filter((f) => /^llm-benchmarks-.*\.csv$/.test(f))
   .sort(); // filenames carry a sortable YYYYMMDD-HHMMSS stamp → ascending = oldest first
const merged = new Map(); // `${base}|${think}|${bench}` → row (last write = newest file)
for (const f of files) {
   for (const r of readTable(join(RESULTS, f))) {
      if (r.bench === 'coding' || r.bench === 'coding_hard') {
         merged.set(`${baseId(r.model)}|${r.think}|${r.bench}`, { ...r, _file: f });
      }
   }
}

// ── Pivot into per-model, per-state tiers ────────────────────────────────────
// model → { label, states: { <think>: { easy, hard } } }
const models = new Map();
for (const r of merged.values()) {
   const base = baseId(r.model);
   if (!models.has(base)) {
      models.set(base, { base, states: {} });
   }
   const states = models.get(base).states;
   if (!states[r.think]) {
      states[r.think] = { easy: null, hard: null };
   }
   const st = states[r.think];
   if (r.bench === 'coding') {
      st.easy = Number(r.score);
   } else {
      st.hard = testRate(r.notes);
   }
}

function combined(st) {
   if (st.easy == null && st.hard == null) {
      return null;
   }
   const easy = st.easy ?? 0;
   const hard = st.hard ?? 0;
   return W_EASY * easy + W_HARD * hard;
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
      bestEasy: best.st.easy,
      bestHard: best.st.hard,
      coldScore: coldEntry ? coldEntry.c : null,
   });
}

rows.sort((a, b) => b.bestScore - a.bestScore);

const pad = (s, n) => String(s).padEnd(n);
const num = (v, n = 5) => (v == null ? '—'.padStart(n) : v.toFixed(1).padStart(n));
console.log(`\nCombined coding score = ${W_EASY}·easy_pass@1 + ${W_HARD}·hard_test-rate   (${files.length} result files merged)\n`);
console.log(pad('model', 34), pad('best', 6), pad('via', 9), pad('easy', 6), pad('hard', 6), pad('cold(no-think)', 14));
console.log('─'.repeat(82));
for (const r of rows) {
   console.log(
      pad(r.base.slice(0, 33), 34),
      num(r.bestScore, 5).padStart(6),
      pad(r.bestState, 9),
      num(r.bestEasy, 5).padStart(6),
      num(r.bestHard, 5).padStart(6),
      num(r.coldScore, 5).padStart(14),
   );
}
console.log(`\n${rows.length} models ranked. "best" = ceiling over think states; "cold" = no_think/null only.`);
