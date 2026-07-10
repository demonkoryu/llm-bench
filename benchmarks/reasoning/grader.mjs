/**
 * promptfoo grader for the reasoning benchmark.
 * Accepted answers and traps are looked up from cases.mjs by case_id
 * to avoid promptfoo's array-expansion behavior on YAML vars.
 */

import { CASES as BASE_CASES } from './cases.mjs';
import { HARD_CASES } from './cases-hard.mjs';
import { EXPERT_CASES } from './cases-expert.mjs';

// Base + hard + expert tiers share one grader; lookup is by case_id so they can't collide.
const CASES = { ...BASE_CASES, ...HARD_CASES, ...EXPERT_CASES };

function norm(s) {
   return String(s ?? '')
      .toLowerCase()
      .trim()
      .replace(/[.,!?$"']/g, '')
      .replace(/\s+/g, ' ')
      .trim();
}

function stripThink(c) {
   return c.replace(/<think>[\s\S]*?<\/think>/g, '').trim();
}

export default function (output, context) {
   const caseId = context?.vars?.case_id ?? '?';
   const c = CASES[caseId];
   if (!c) {
      return { pass: false, score: 0, reason: `Unknown case_id: ${caseId}` };
   }

   let answer = null;
   const stripped = stripThink(output);
   // Primary: model followed the JSON instruction. A bare value (e.g. "686") parses as a
   // JSON number, not an object with .answer — treat that as the answer itself, not undefined.
   try {
      const parsed = JSON.parse(stripped);
      answer = (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) ? parsed.answer : String(parsed);
   } catch {
      // Tolerant fallback 1: extract first {...} span (trailing token / preamble).
      const m = stripped.match(/\{[\s\S]*\}/);
      if (m) {
         try {
            answer = JSON.parse(m[0]).answer;
         } catch {
            /* continue */
         }
      }
      // Tolerant fallback 2: think mode without grammar often emits plain text.
      // Use the whole stripped output as the answer — grader normalises anyway.
      if (answer == null) {
         answer = stripped;
      }
   }

   const a = norm(answer);
   // Guard: an empty normalized answer must not match (else n.includes('') is always true).
   const correct = a !== '' && c.accepted.some((acc) => {
      const n = norm(acc);
      return a === n || a.includes(n) || n.includes(a);
   });
   const hitTrap = !correct && a === norm(c.trap);

   return {
      pass: correct,
      score: correct ? 1 : 0,
      reason: correct
         ? `correct: "${answer}"`
         : hitTrap
           ? `trap: got "${answer}" (trap=${c.trap})`
           : `wrong: got "${answer}", expected one of [${c.accepted.join(', ')}]`,
   };
}
