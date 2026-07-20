// Bench module: reasoning_expert — the hard, gradient-producing tier (multi-step math/
// logic with unambiguous answers). Reuses the reasoning grader (merges EXPERT_CASES).

import { EXPERT_CASES } from '../benchmarks/reasoning/cases-expert.mjs';
import reasoningGrader from '../benchmarks/reasoning/grader.mjs';
import { stripThink } from '../shared/llm/index.mjs';

const SYSTEM =
   'Solve the problem. Think step by step and show your work.\n' +
   'End your response with the final answer as JSON: {"answer": "<final answer>"}.';
const ANSWER_SCHEMA = { type: 'object', properties: { answer: { type: 'string' } }, required: ['answer'] };

export const bench = {
   name: 'reasoning_expert',
   thinkDependent: true,
   async run(client, { think, sampling, thinkControl, model }) {
      let correct = 0,
         errors = 0;
      for (const [caseId, c] of Object.entries(EXPERT_CASES)) {
         const messages = [
            { role: 'system', content: SYSTEM },
            { role: 'user', content: c.question },
         ];
         let completion;
         try {
            ({ completion } = await client.chat(messages, {
               think,
               thinkControl,
               // harder problems need room to work; no schema in think mode (grammar blocks think)
               responseFormat: think === true || model?.no_schema ? null : ANSWER_SCHEMA,
               max_tokens: think === true ? 8192 : 2048,
               ...sampling,
            }));
         } catch {
            errors++;
            continue;
         }
         const raw = completion.choices?.[0]?.message?.content ?? '';
         if (reasoningGrader(stripThink(raw), { vars: { case_id: caseId } }).pass) { correct++; }
      }
      return {
         bench: 'reasoning_expert',
         reasoning_correct: correct,
         reasoning_total: Object.keys(EXPERT_CASES).length,
         json_fail: errors,
         status: 'ok',
      };
   },
};
