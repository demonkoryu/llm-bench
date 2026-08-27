// Bench module: triage. Reuses the shared rubric (triage-golden/prompt/rubric).

import { GOLDEN } from '../shared/triage-golden.mjs';
import { TRIAGE_SCHEMA, TRIAGE_STATIC_PROMPT } from '../shared/triage-prompt.mjs';
import { computeScore as triageComputeScore, gradeOne as triageGradeOne } from '../shared/triage-rubric.mjs';

export const bench = {
   name: 'triage',
   thinkDependent: true,
   async run(client, { think, sampling, thinkControl, model }) {
      const itemResults = [];
      const reqFails = [];
      let parseSampleShown = false;
      let halls = 0,
         jsonFail = 0;
      for (const item of GOLDEN) {
         const messages = [
            { role: 'system', content: TRIAGE_STATIC_PROMPT },
            { role: 'user', content: `Title: ${item.title}\nContent preview:\n${item.content_preview}` },
         ];
         let completion;
         try {
            ({ completion } = await client.chat(messages, {
               think,
               thinkControl,
               responseFormat: think === true || model?.no_schema ? null : TRIAGE_SCHEMA,
               // Flat 4096 for BOTH passes. The two conditions above and below used to move together:
               // `think === true` turned the schema OFF and simultaneously bought 4096 tokens, so the
               // schema-constrained pass — the one that MUST emit the required `reasoning`,
               // `suggested_title` and `suggested_summary` strings, none of which carry a maxLength —
               // was the pass given 1024. That is what scored Qwen3.6-27B IQ4_XS no_think at
               // json_fail=18/18 with every rubric metric 0 (2026-08-26), and nemotron3-4b at 8/18 on
               // the same pass against 3/18 on the free-text one. Same mechanism struct_output hit:
               // the budget is spent before the object closes, so a complete-but-truncated reply is
               // counted as malformed JSON and the number measures the harness, not the model.
               // The think pass already ran at 4096, so this changes the constrained pass only.
               max_tokens: 4096,
               ...sampling,
            }));
         } catch (e) {
            // A request that never returned is NOT a parse failure, but it lands in the same counter,
            // because the store has no column for the distinction — and `json_fail=18` has already been
            // published once for what may have been 18 rejected requests (Qwen3.6-27B IQ4_XS no_think,
            // 2026-08-26). Counting is unchanged; the cause is named on stderr, where the run log keeps
            // it. An all-cases json_fail whose log carries no [triage] req-fail line is a real parse
            // problem; one that carries a line per case is not.
            reqFails.push(`${item.id}: ${e?.status ?? '-'} ${(e?.message ?? String(e)).replace(/\s+/g, ' ').slice(0, 160)}`);
            itemResults.push({ item, grade: { scores: {}, parsedOk: false, anchorHallucination: false } });
            jsonFail++;
            continue;
         }
         const choice = completion.choices?.[0];
         const raw = choice?.message?.content ?? '';
         const grade = triageGradeOne(item, raw);
         if (grade.anchorHallucination) {
            halls++;
         }
         if (!grade.parsedOk) {
            jsonFail++;
            // The counterpart to the req-fail line above: a reply that arrived but did not parse. One
            // sample is enough to tell a truncation (no closing brace) from a reasoning preamble the
            // grader chokes on, and keeps a 18/18 failure from being a number with no explanation.
            if (!parseSampleShown) {
               parseSampleShown = true;
               // finish_reason is the field that settles it: `length` means the budget ran out — the
               // struct_output precedent, where 256 tok spent inside the reasoning trace returned
               // EMPTY content on 7 of 12 tasks and not one malformed JSON — while `stop` means the
               // model really did emit something the grader cannot read.
               console.error(
                  `  [triage] first unparseable reply (${item.id}, finish=${choice?.finish_reason}, ${raw.length} chars): ` +
                     `${raw.replace(/\s+/g, ' ').slice(0, 200)}`,
               );
            }
         }
         itemResults.push({ item, grade });
      }
      if (reqFails.length) {
         const schema = think === true || model?.no_schema ? 'off' : 'on';
         console.error(
            `  [triage] ${reqFails.length}/${GOLDEN.length} requests failed outright (counted in json_fail) · response_format=${schema}`,
         );
         for (const f of reqFails.slice(0, 4)) {
            console.error(`  [triage]   ${f}`);
         }
         if (reqFails.length > 4) {
            console.error(`  [triage]   … ${reqFails.length - 4} more`);
         }
      }
      const { perRule } = triageComputeScore(itemResults);
      return {
         bench: 'triage',
         triage_R1: perRule.R1 ?? null,
         triage_R2: perRule.R2 ?? null,
         triage_R3: perRule.R3 ?? null,
         triage_R4: perRule.R4 ?? null,
         triage_R5: perRule.R5 ?? null,
         triage_R6: perRule.R6 ?? null,
         triage_R7: perRule.R7 ?? null,
         triage_C1: perRule.C1 ?? null,
         triage_C2: perRule.C2 ?? null,
         halls,
         json_fail: jsonFail,
         status: 'ok',
      };
   },
};
