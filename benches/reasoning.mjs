// Bench module: reasoning. Reuses benchmarks/reasoning cases + grader.

import { CASES as REASON_CASES } from '../benchmarks/reasoning/cases.mjs';
import reasoningGrader from '../benchmarks/reasoning/grader.mjs';
import { stripThink } from '../shared/llm/index.mjs';

const ANSWER_SCHEMA = { type: 'object', properties: { answer: { type: 'string' } }, required: ['answer'] };
const SYSTEM =
   'Solve the reasoning problem. Think step by step.\n' + 'Respond ONLY with JSON: {"answer": "<final answer — a number or single word>"}.';

export const bench = {
   name: 'reasoning',
   thinkDependent: true,
   async run(client, { think, sampling, thinkControl, model }) {
      let correct = 0,
         errors = 0;
      const tps = [];
      for (const [caseId, caseData] of Object.entries(REASON_CASES)) {
         const q = caseData.question ?? caseData;
         const messages = [
            { role: 'system', content: SYSTEM },
            { role: 'user', content: q },
         ];
         let completion;
         try {
            ({ completion } = await client.chat(messages, {
               think,
               thinkControl,
               responseFormat: think === true || model?.no_schema ? null : ANSWER_SCHEMA,
               max_tokens: think === true ? 4096 : 1024,
               ...sampling,
            }));
         } catch {
            errors++;
            continue;
         }
         const t = client.tokPerSec();
         if (t) { tps.push(t); }
         const raw = completion.choices?.[0]?.message?.content ?? '';
         if (reasoningGrader(stripThink(raw), { vars: { case_id: caseId } }).pass) { correct++; }
      }
      const total = Object.keys(REASON_CASES).length;
      return {
         bench: 'reasoning',
         reasoning_correct: correct,
         reasoning_total: total,
         json_fail: errors,
         tok_s: tps.length ? tps.reduce((a, b) => a + b, 0) / tps.length : null,
         status: 'ok',
      };
   },
};
