/**
 * promptfoo grader for the summarization/categorization benchmark.
 * Case metadata (expected_area, tags_prefix, must_mention) in summcases.mjs.
 *
 * Score breakdown (0-1):
 *   0.25  keyword coverage (must_mention / total)
 *   0.30  area correct
 *   0.30  tag prefix discipline
 *   0.15  summary length ok (10-100 words)
 */

import { extractJson } from '../../shared/llm/index.mjs';
import { CASES } from './summcases.mjs';

export default function (output, context) {
   const caseId = context?.vars?.case_id ?? '?';
   const c = CASES[caseId];
   if (!c) {
      return { pass: false, score: 0, reason: `Unknown case_id: ${caseId}` };
   }

   // Tolerant extraction: some models (e.g. Gemma4) wrap the JSON in ```json
   // fences or add prose, which strict JSON.parse rejects. extractJson recovers
   // the object regardless and returns null only when there's truly no JSON.
   const parsed = extractJson(output);
   if (!parsed) {
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

   // Raw component scores — weights are applied at analysis time (scoring.mjs), not here.
   const rawScores = { kw: kwScore, area: areaOk ? 1 : 0, tags: tagsOk ? 1 : 0, length: lengthOk ? 1 : 0 };

   // Compute a weighted score only for the pass threshold and promptfoo reason string.
   // The canonical weighted score for the dashboard is produced by scoring.mjs.
   const score = kwScore * 0.25 + (areaOk ? 0.3 : 0) + (tagsOk ? 0.3 : 0) + (lengthOk ? 0.15 : 0);
   const missing = c.must_mention.filter((kw) => !summaryLower.includes(kw.toLowerCase()));

   const reason = [
      `score=${(score * 100).toFixed(0)}/100`,
      `kw=${mentioned.length}/${c.must_mention.length}${missing.length ? `(missing:${missing.join(',')})` : ''}`,
      `area=${area}${areaOk ? '' : `≠${c.expected_area}`}`,
      `tags=${tagsOk ? 'ok' : `bad`}`,
      `words=${wordCount}`,
   ].join(' | ');

   return { pass: score >= 0.75, score, reason, rawScores };
}
