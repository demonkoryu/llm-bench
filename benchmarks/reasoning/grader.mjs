/**
 * promptfoo grader for the reasoning benchmark.
 * Accepted answers and traps are looked up from cases.mjs by case_id
 * to avoid promptfoo's array-expansion behavior on YAML vars.
 */

import { CASES as BASE_CASES } from './cases.mjs';
import { HARD_CASES } from './cases-hard.mjs';

// Base + hard tier share one grader; lookup is by case_id so the sets can't collide.
const CASES = { ...BASE_CASES, ...HARD_CASES };

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
   // Primary: model followed the JSON instruction.
   try {
      answer = JSON.parse(stripped).answer;
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
   const correct = c.accepted.some((acc) => {
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
