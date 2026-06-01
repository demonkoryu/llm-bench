/**
 * promptfoo grader for the summarization/categorization benchmark.
 * Case metadata (expected_area, tags_prefix, must_mention) in summcases.mjs.
 *
 * Score breakdown (0-1):
 *   0.40  keyword coverage (must_mention / total)
 *   0.25  area correct
 *   0.20  tag prefix discipline
 *   0.15  summary length ok (10-100 words)
 */

import { CASES } from './summcases.mjs';

export default function(output, context) {
   const caseId = context?.vars?.case_id ?? '?';
   const c = CASES[caseId];
   if (!c) return { pass: false, score: 0, reason: `Unknown case_id: ${caseId}` };

   let parsed = null;
   try {
      parsed = JSON.parse(output.replace(/<think>[\s\S]*?<\/think>/g, '').trim());
   } catch {
      return { pass: false, score: 0, reason: `${caseId}: JSON parse failed` };
   }

   const summary = String(parsed.summary ?? '');
   const area = parsed.area ?? null;
   const tags = Array.isArray(parsed.tags) ? parsed.tags : [];

   const summaryLower = summary.toLowerCase();
   const mentioned = c.must_mention.filter((kw) => summaryLower.includes(kw.toLowerCase()));
   const kwScore = c.must_mention.length ? mentioned.length / c.must_mention.length : 1;

   const areaOk = area === c.expected_area;
   const tagsOk = tags.length > 0 && tags.every((t) => typeof t === 'string' && t.startsWith(`${c.tags_prefix}/`));
   const wordCount = summary.trim().split(/\s+/).length;
   const lengthOk = wordCount >= 10 && wordCount <= 100;

   const score = kwScore * 0.40 + (areaOk ? 0.25 : 0) + (tagsOk ? 0.20 : 0) + (lengthOk ? 0.15 : 0);
   const missing = c.must_mention.filter((kw) => !summaryLower.includes(kw.toLowerCase()));

   const reason = [
      `score=${(score * 100).toFixed(0)}/100`,
      `kw=${mentioned.length}/${c.must_mention.length}${missing.length ? `(missing:${missing.join(',')})` : ''}`,
      `area=${area}${areaOk ? '' : `≠${c.expected_area}`}`,
      `tags=${tagsOk ? 'ok' : `bad`}`,
      `words=${wordCount}`,
   ].join(' | ');

   return { pass: score >= 0.75, score, reason };
}
