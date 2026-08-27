// Bench module: reasoning. Reuses benchmarks/reasoning cases + grader.

import { CASES as REASON_CASES } from '../benchmarks/reasoning/cases.mjs';
import reasoningGrader from '../benchmarks/reasoning/grader.mjs';
import { stripThink } from '../shared/llm/index.mjs';

const ANSWER_SCHEMA = { type: 'object', properties: { answer: { type: 'string' } }, required: ['answer'] };
const SYSTEM =
   'Solve the reasoning problem. Think step by step.\n' + 'Respond ONLY with JSON: {"answer": "<final answer — a number or single word>"}.';

export const bench = {
   name: 'reasoning',
   samplingProfile: 'reasoning',
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
               // Flat budget (2026-08-27). The `reasons(model, think) ? big : small` shape gave the pass LEAST able
               // to afford truncation the SMALLER budget, and a truncated or empty reply is scored as a parse
               // failure or a wrong answer — the harness measuring itself. struct_output quantified it on
               // Muse-Glimmer-30B: 256 -> 41.67%, 1024 -> 91.67%, 4096 -> 100%, "not one malformed JSON at any
               // budget". Same shape produced Qwen3.6-27B's triage json_fail=18/18. A model that stops early costs
               // nothing here; only one that needed the room is affected.
               max_tokens: 4096,
               ...sampling,
            }));
         } catch {
            errors++;
            continue;
         }
         const t = client.tokPerSec();
         if (t) {
            tps.push(t);
         }
         const raw = completion.choices?.[0]?.message?.content ?? '';
         if (reasoningGrader(stripThink(raw), { vars: { case_id: caseId } }).pass) {
            correct++;
         }
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
