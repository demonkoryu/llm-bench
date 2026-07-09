// Bench module: summarization. Reuses benchmarks/summarization cases + grader.
import summGrader from '../benchmarks/summarization/grader.mjs';
import { SUMM_ITEMS } from '../benchmarks/summarization/summcases.mjs';
import { stripThink } from '../shared/llm/index.mjs';

const SYSTEM =
  'Summarize and categorize content for a personal knowledge vault.\nVault areas: craft (software, AI, hardware, PKM), finance (trading, markets), music (DJing, production), work (career, employer).\n\n' +
  'Respond with JSON only:\n{"summary": "<1-2 sentence factual summary>", "area": "<craft|finance|music|work>", "tags": ["<area/subtag>", ...]}';

export const bench = {
  name: 'summarization',
  thinkDependent: true,
  async run(client, { think, sampling, thinkControl }) {
    const totals = { kw: 0, area: 0, tags: 0, length: 0 };
    let count = 0;
    for (const [caseId, item] of Object.entries(SUMM_ITEMS)) {
      const messages = [{ role: 'system', content: SYSTEM }, { role: 'user', content: `Title: ${item.title}\n\n${item.content}` }];
      let completion;
      try { ({ completion } = await client.chat(messages, { think, thinkControl, max_tokens: think === true ? 4096 : 1024, ...sampling })); }
      catch { continue; }
      const raw = stripThink(completion.choices?.[0]?.message?.content ?? '');
      const rs = summGrader(raw, { vars: { case_id: caseId } }).rawScores ?? {};
      totals.kw += rs.kw ?? 0; totals.area += rs.area ?? 0; totals.tags += rs.tags ?? 0; totals.length += rs.length ?? 0;
      count++;
    }
    return {
      bench: 'summarization',
      summ_kw: count ? totals.kw / count : null, summ_area: count ? totals.area / count : null,
      summ_tags: count ? totals.tags / count : null, summ_length: count ? totals.length / count : null, status: 'ok',
    };
  },
};
