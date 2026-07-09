// Bench module: triage. Reuses the shared rubric (triage-golden/prompt/rubric).
import { GOLDEN } from '../shared/triage-golden.mjs';
import { TRIAGE_SCHEMA, TRIAGE_STATIC_PROMPT } from '../shared/triage-prompt.mjs';
import { computeScore as triageComputeScore, gradeOne as triageGradeOne } from '../shared/triage-rubric.mjs';

export const bench = {
  name: 'triage',
  thinkDependent: true,
  async run(client, { think, sampling, thinkControl, model }) {
    const itemResults = [];
    let halls = 0, jsonFail = 0;
    for (const item of GOLDEN) {
      const messages = [
        { role: 'system', content: TRIAGE_STATIC_PROMPT },
        { role: 'user', content: `Title: ${item.title}\nContent preview:\n${item.content_preview}` },
      ];
      let completion;
      try {
        ({ completion } = await client.chat(messages, {
          think, thinkControl,
          responseFormat: think === true || model?.no_schema ? null : TRIAGE_SCHEMA,
          max_tokens: think === true ? 4096 : 1024, ...sampling,
        }));
      } catch { itemResults.push({ item, grade: { scores: {}, parsedOk: false, anchorHallucination: false } }); jsonFail++; continue; }
      const raw = completion.choices?.[0]?.message?.content ?? '';
      const grade = triageGradeOne(item, raw);
      if (grade.anchorHallucination) halls++;
      if (!grade.parsedOk) jsonFail++;
      itemResults.push({ item, grade });
    }
    const { perRule } = triageComputeScore(itemResults);
    return {
      bench: 'triage',
      triage_R1: perRule.R1 ?? null, triage_R2: perRule.R2 ?? null, triage_R3: perRule.R3 ?? null,
      triage_R4: perRule.R4 ?? null, triage_R5: perRule.R5 ?? null, triage_R6: perRule.R6 ?? null,
      triage_R7: perRule.R7 ?? null, triage_C1: perRule.C1 ?? null, triage_C2: perRule.C2 ?? null,
      halls, json_fail: jsonFail, status: 'ok',
    };
  },
};
