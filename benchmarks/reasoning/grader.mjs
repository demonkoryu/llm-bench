/**
 * promptfoo grader for the reasoning benchmark.
 * Normalizes answer and checks against accepted forms + trap detection.
 */

function norm(s) {
   return String(s ?? '').toLowerCase().trim()
      .replace(/[.,!?$"']/g, '')
      .replace(/\s+/g, ' ')
      .trim();
}

function stripThink(c) {
   return c.replace(/<think>[\s\S]*?<\/think>/g, '').trim();
}

export default function(output, context) {
   const accepted = context?.vars?.accepted ?? [];
   const trap = context?.vars?.trap ?? '';
   const caseId = context?.vars?.case_id ?? '?';

   let answer = null;
   try {
      answer = JSON.parse(stripThink(output)).answer;
   } catch {
      return { pass: false, score: 0, reason: `JSON parse failed for case ${caseId}` };
   }

   const a = norm(answer);
   const correct = accepted.some((acc) => {
      const n = norm(acc);
      return a === n || a.includes(n) || n.includes(a);
   });
   const hitTrap = !correct && a === norm(trap);

   return {
      pass: correct,
      score: correct ? 1 : 0,
      reason: correct
         ? `correct: "${answer}"`
         : hitTrap
            ? `trap: got "${answer}" (trap=${trap})`
            : `wrong: got "${answer}", expected one of [${accepted.join(', ')}]`,
   };
}
