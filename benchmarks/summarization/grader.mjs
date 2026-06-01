/**
 * promptfoo grader for the summarization/categorization benchmark.
 *
 * Checks:
 *   - JSON parseable
 *   - summary: 1-2 sentences, mentions required keywords (must_mention)
 *   - area: matches expected_area
 *   - tags: array of strings with expected_tags_prefix prefix
 *
 * Score breakdown (0-1):
 *   0.40  keyword coverage (must_mention / total)
 *   0.25  area correct
 *   0.20  tag prefix discipline
 *   0.15  summary length ok (10-100 words)
 */

export default function(output, context) {
   const caseId = context?.vars?.case_id ?? '?';
   const expectedArea = context?.vars?.expected_area ?? null;
   const expectedTagsPrefix = context?.vars?.expected_tags_prefix ?? null;
   const mustMention = context?.vars?.must_mention ?? [];

   let parsed = null;
   try {
      parsed = JSON.parse(output.replace(/<think>[\s\S]*?<\/think>/g, '').trim());
   } catch {
      return { pass: false, score: 0, reason: `${caseId}: JSON parse failed` };
   }

   const summary = String(parsed.summary ?? '');
   const area = parsed.area ?? null;
   const tags = Array.isArray(parsed.tags) ? parsed.tags : [];

   // Keyword coverage
   const summaryLower = summary.toLowerCase();
   const mentioned = mustMention.filter((kw) => summaryLower.includes(kw.toLowerCase()));
   const kwScore = mustMention.length ? mentioned.length / mustMention.length : 1;

   // Area correctness
   const areaOk = area === expectedArea;

   // Tag prefix discipline
   const tagsOk = tags.length > 0 && tags.every((t) => typeof t === 'string' && t.startsWith(`${expectedTagsPrefix}/`));

   // Summary length (10-100 words)
   const wordCount = summary.trim().split(/\s+/).length;
   const lengthOk = wordCount >= 10 && wordCount <= 100;

   const score = kwScore * 0.40 + (areaOk ? 0.25 : 0) + (tagsOk ? 0.20 : 0) + (lengthOk ? 0.15 : 0);
   const pass = score >= 0.75;

   const missing = mustMention.filter((kw) => !summaryLower.includes(kw.toLowerCase()));
   const reason = [
      `score=${(score * 100).toFixed(0)}/100`,
      `kw=${mentioned.length}/${mustMention.length}${missing.length ? `(missing:${missing.join(',')})` : ''}`,
      `area=${area}${areaOk ? '' : `≠${expectedArea}`}`,
      `tags=${tagsOk ? 'ok' : `bad(${tags.slice(0, 3).join(',')})`}`,
      `words=${wordCount}`,
   ].join(' | ');

   return { pass, score, reason };
}
