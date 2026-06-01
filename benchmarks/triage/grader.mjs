/**
 * promptfoo scriptPath grader for the triage benchmark.
 * Loaded via `assert: [{type: javascript, value: file://grader.mjs}]`.
 *
 * promptfoo calls the default export with (output, context).
 * output   = model's raw response string
 * context  = { vars: { item_id, item_title, item_content }, ... }
 */

import { gradeOne, computeScore, WEIGHTS } from '../../shared/triage-rubric.mjs';
import { GOLDEN } from '../../shared/triage-golden.mjs';

export default function(output, context) {
   const itemId = context?.vars?.item_id;
   const item = GOLDEN.find((g) => g.id === itemId);
   if (!item) {
      return { pass: false, score: 0, reason: `Unknown item_id: ${itemId}` };
   }

   const { scores, parsedOk, anchorHallucination, detail } = gradeOne(item, output);
   const { total } = computeScore([{ grade: { scores } }]);
   const normalizedScore = total / 100;   // promptfoo expects 0-1

   const failedRules = Object.entries(scores)
      .filter(([, v]) => v === 0)
      .map(([k]) => k);

   const reason = [
      `score=${total.toFixed(1)}/100`,
      anchorHallucination ? 'ANCHOR_HALL' : null,
      !parsedOk ? `JSON_FAIL: ${detail}` : null,
      failedRules.length ? `failed=[${failedRules.join(',')}]` : null,
   ].filter(Boolean).join(' | ');

   // pass = parseable + no anchor hallucination + score >= 70
   return {
      pass: parsedOk && !anchorHallucination && total >= 70,
      score: normalizedScore,
      reason,
      // expose per-rule breakdown as named metrics for promptfoo output
      namedScores: Object.fromEntries(
         Object.keys(WEIGHTS).map((k) => [`rule_${k}`, scores[k]])
      ),
   };
}
