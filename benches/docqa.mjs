// Bench module: docqa. Reuses benchmarks/docqa cases.json + gradeAll grader.
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { gradeAll as docqaGradeAll } from '../benchmarks/docqa/grader.mjs';
import { stripThink } from '../shared/llm/index.mjs';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const docqaCases = JSON.parse(readFileSync(join(ROOT, 'benchmarks/docqa/cases.json'), 'utf8'));

export const bench = {
   name: 'docqa',
   samplingProfile: 'docqa',
   thinkDependent: true,
   async run(client, { think, sampling, thinkControl }) {
      const { docs, questions } = docqaCases;
      const docMap = Object.fromEntries((docs ?? []).map((d) => [d.id, d.source]));
      const answers = {};
      for (const q of questions ?? []) {
         const context = (q.doc_ids ?? [])
            .map((id) => docMap[id] ?? '')
            .filter(Boolean)
            .join('\n\n');
         const messages = [
            {
               role: 'system',
               content:
                  'Answer the question using ONLY the provided documents. Be precise and concise. Show your numerical work if needed.',
            },
            { role: 'user', content: `Documents:\n${context}\n\nQuestion: ${q.question}` },
         ];
         let completion;
         try {
            ({ completion } = await client.chat(messages, {
               think,
               thinkControl,
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
            answers[q.id] = '';
            continue;
         }
         answers[q.id] = stripThink(completion.choices?.[0]?.message?.content ?? '');
      }
      const { per_question } = docqaGradeAll(questions ?? [], answers);
      const n = per_question.length || 1;
      const avgOf = (f) => per_question.reduce((s, q) => s + (q[f] ?? 0), 0) / n;
      return {
         bench: 'docqa',
         docqa_correctness: avgOf('correctness'),
         docqa_coverage: avgOf('coverage'),
         docqa_faithfulness: avgOf('faithfulness'),
         halls: per_question.filter((r) => r.trap_hits?.length > 0).length,
         status: 'ok',
      };
   },
};
