// Bench module: reasoning_hard — the gradient-producing tier for the dense-vs-MoE
// "smarter" axis (base reasoning is ceiling-bound). Reuses the reasoning grader
// (which merges HARD_CASES) over the harder case set.

import { HARD_CASES } from '../benchmarks/reasoning/cases-hard.mjs';
import reasoningGrader from '../benchmarks/reasoning/grader.mjs';
import { stripThink } from '../shared/llm/index.mjs';
import { reasons } from '../shared/llm/think.mjs';

const SYSTEM =
   'Solve the reasoning problem. Think step by step.\n' +
   'Respond ONLY with JSON: {"answer": "<final answer — a number, fraction, or single word>"}.';
const ANSWER_SCHEMA = { type: 'object', properties: { answer: { type: 'string' } }, required: ['answer'] };

export const bench = {
   name: 'reasoning_hard',
   // No samplingProfile — deliberately unresolved, not an oversight. Under the old bench-name
   // lookup only `reasoning` matched, so this bench has always run at family defaults; declaring
   // 'reasoning' here would change qwen3 no_think sampling (0.7/0.8 → 0.6/0.95) and re-baseline
   // its rows. Worth deciding on purpose — same question applies to reasoning_expert.
   thinkDependent: true,
   async run(client, { think, sampling, thinkControl, model }) {
      let correct = 0,
         errors = 0;
      for (const [caseId, c] of Object.entries(HARD_CASES)) {
         const messages = [
            { role: 'system', content: SYSTEM },
            { role: 'user', content: c.question },
         ];
         let completion;
         try {
            ({ completion } = await client.chat(messages, {
               think,
               thinkControl,
               responseFormat: think === true || model?.no_schema ? null : ANSWER_SCHEMA,
               max_tokens: reasons(model, think) ? 4096 : 1024,
               ...sampling,
            }));
         } catch {
            errors++;
            continue;
         }
         const raw = completion.choices?.[0]?.message?.content ?? '';
         if (reasoningGrader(stripThink(raw), { vars: { case_id: caseId } }).pass) {
            correct++;
         }
      }
      return {
         bench: 'reasoning_hard',
         reasoning_correct: correct,
         reasoning_total: Object.keys(HARD_CASES).length,
         json_fail: errors,
         status: 'ok',
      };
   },
};
