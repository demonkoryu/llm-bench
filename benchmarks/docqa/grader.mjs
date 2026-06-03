/**
 * Deterministic doc-QA grader.
 * Ported from wisp-vault-mcp-ts scripts/bench-ts/grade/docqa.ts.
 *
 * Each answer scores 0–10:
 *   correctness (5)  — numeric match ± tolerance + conclusion match
 *   coverage    (3)  — required_facts hit-rate
 *   faithfulness(2)  — penalty for forbidden_claims (trap hits), waived if conclusion correct
 *
 * No LLM judge — fully deterministic.
 */

function escapeRegex(s) {
   return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/**
 * Boundary-aware containment — matches Python _contains() exactly.
 * Numbers: guard against digits/dots on both sides so "120" != "1200"/"1.20".
 * Text: plain word boundaries so trailing period ("No.", "does not fit.") still matches.
 */
function contains(text, term) {
   const t = term.toLowerCase();
   const txt = text.toLowerCase();
   let pat;
   if (/^-?\d+(?:\.\d+)?$/.test(t)) {
      pat = new RegExp(`(?<![\\d.])${escapeRegex(t)}(?![\\d.])`, 'i');
   } else {
      pat = new RegExp(`(?<!\\w)${escapeRegex(t)}(?!\\w)`, 'i');
   }
   return pat.test(txt);
}

function extractNumbers(text) {
   return (text.match(/-?\d+(?:\.\d+)?/g) ?? []).map(Number);
}

/**
 * Grade a single answer against a question spec.
 * @param {object} q   question from cases.json
 * @param {string} answer  model's response text
 * @returns {{id, score, correctness, coverage, faithfulness, numeric_ok, conclusion_ok, missing_facts, trap_hits}}
 */
export function gradeAnswer(q, answer) {
   const ans = (answer ?? '').toLowerCase();

   // correctness (max 5)
   const num  = q.numeric_answer;
   const conc = q.expected_conclusion ?? '';
   const concOk = Boolean(conc) && contains(ans, conc.toLowerCase());

   let numOk = null;
   let correctness;
   if (num) {
      const tol = num.tolerance ?? 0;
      numOk = extractNumbers(ans).some((v) => Math.abs(v - num.value) <= tol);
      correctness = (numOk ? 3 : 0) + (concOk ? 2 : 0);
   } else {
      correctness = concOk ? 5 : 0;
   }

   // coverage (max 3)
   const req     = q.required_facts ?? [];
   const reqHits = req.filter((f) => contains(ans, f.toLowerCase()));
   const coverage = req.length > 0 ? 3 * (reqHits.length / req.length) : 3;

   // faithfulness (max 2) — penalise traps, but only when conclusion is wrong
   const forb = q.forbidden_claims ?? [];
   let forbHits = forb.filter((f) => contains(ans, f.toLowerCase()));
   let faithfulness;
   if (concOk) {
      faithfulness = 2.0;
      forbHits = [];
   } else {
      faithfulness = !forb.length
         ? 2.0
         : Math.max(0, 2.0 - 2.0 * (forbHits.length / forb.length));
   }

   const score = Math.round((correctness + coverage + faithfulness) * 100) / 100;

   return {
      id: q.id,
      score,
      correctness,
      coverage: Math.round(coverage * 100) / 100,
      faithfulness: Math.round(faithfulness * 100) / 100,
      numeric_ok: numOk,
      conclusion_ok: concOk,
      missing_facts: req.filter((f) => !reqHits.includes(f)),
      trap_hits: forbHits,
   };
}

/**
 * Grade all answers and compute mean score.
 * @param {Array}  questions
 * @param {object} answerById  { [questionId]: answerText }
 * @returns {{ mean_score, n, per_question }}
 */
export function gradeAll(questions, answerById) {
   const perQ = questions.map((q) => gradeAnswer(q, answerById[q.id] ?? ''));
   const mean = perQ.length > 0
      ? Math.round((perQ.reduce((s, g) => s + g.score, 0) / perQ.length) * 100) / 100
      : 0;
   return { mean_score: mean, n: perQ.length, per_question: perQ };
}
