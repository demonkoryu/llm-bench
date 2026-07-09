// Bench module: reasoning_hard — the gradient-producing tier for the dense-vs-MoE
// "smarter" axis (base reasoning is ceiling-bound). Reuses the reasoning grader
// (which merges HARD_CASES) over the harder case set.
import reasoningGrader from '../benchmarks/reasoning/grader.mjs';
import { HARD_CASES } from '../benchmarks/reasoning/cases-hard.mjs';
import { stripThink } from '../shared/llm/index.mjs';

const SYSTEM =
  'Solve the reasoning problem. Think step by step.\n' +
  'Respond ONLY with JSON: {"answer": "<final answer — a number, fraction, or single word>"}.';
const ANSWER_SCHEMA = { type: 'object', properties: { answer: { type: 'string' } }, required: ['answer'] };

export const bench = {
  name: 'reasoning_hard',
  thinkDependent: true,
  async run(client, { think, sampling, thinkControl, model }) {
    let correct = 0, errors = 0;
    for (const [caseId, c] of Object.entries(HARD_CASES)) {
      const messages = [{ role: 'system', content: SYSTEM }, { role: 'user', content: c.question }];
      let completion;
      try {
        ({ completion } = await client.chat(messages, {
          think, thinkControl,
          responseFormat: think === true || model?.no_schema ? null : ANSWER_SCHEMA,
          max_tokens: think === true ? 4096 : 1024, ...sampling,
        }));
      } catch { errors++; continue; }
      const raw = completion.choices?.[0]?.message?.content ?? '';
      if (reasoningGrader(stripThink(raw), { vars: { case_id: caseId } }).pass) correct++;
    }
    return { bench: 'reasoning_hard', reasoning_correct: correct, reasoning_total: Object.keys(HARD_CASES).length, json_fail: errors, status: 'ok' };
  },
};
