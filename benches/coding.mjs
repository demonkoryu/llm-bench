// Bench modules: coding_hard / coding_practical / coding_bugfix.
// Reuses the executable grader (benchmarks/coding/grader.mjs runs the tests) + case
// sets. Emits COUNTS (coding_pass_at_1 = #cases fully passing, coding_total = #cases);
// consumers derive the pass@1 rate as coding_pass_at_1/coding_total.
import { CASES as BUGFIX } from '../benchmarks/coding/cases-bugfix.mjs';
import { CASES as HARD } from '../benchmarks/coding/cases-hard.mjs';
import { CASES as PRACTICAL } from '../benchmarks/coding/cases-practical.mjs';
import { gradeCase as codingGradeCase } from '../benchmarks/coding/grader.mjs';
import { reasons } from '../shared/llm/think.mjs';

const defaultSystem = (c) =>
   `You are an expert programmer. Implement the requested function in JavaScript.\n` +
   `Respond with ONLY one JavaScript code block defining \`${c.entry}\` — no prose, no tests, no example calls, no console.log. The function must \`return\` its result.`;
const bugfixSystem = (c) =>
   `You are an expert programmer. The user will show you a JavaScript function with a bug. Fix it.\n` +
   `Respond with ONLY one JavaScript code block defining the corrected \`${c.entry}\` — no prose, no tests, no example calls, no console.log. The function must \`return\` its result. Do not repeat the original buggy code.`;

function codingBench(name, cases, buildSystem, maxTok, thinkTok) {
   return {
      name,
      // All three coding benches share one sampling profile: declared here, in the factory, so a
      // fourth coding bench inherits it instead of silently falling back to family defaults.
      samplingProfile: 'coding',
      thinkDependent: true,
      async run(client, { think, sampling, thinkControl, model }) {
         let passAt1 = 0,
            testsPassed = 0,
            testsTotal = 0,
            noCode = 0;
         for (const [, c] of Object.entries(cases)) {
            const messages = [
               { role: 'system', content: buildSystem(c) },
               { role: 'user', content: `${c.prompt}\n\nSignature: ${c.signature}` },
            ];
            let raw = '';
            const budget = reasons(model, think) ? thinkTok : maxTok;
            try {
               // The request deadline must be derived from the BUDGET, not left at the client's
               // 600s default. At the ~25 tok/s a 27B reasoner decodes on a V100, 600s buys about
               // 15k tokens — so a 32768 budget was unreachable by construction: the AbortSignal
               // fired first, chat() threw, the catch below swallowed it, and the case was graded
               // 'no-code' exactly as if the model had emitted nothing. That made the timeout
               // indistinguishable from budget starvation in coding_no_code, and it is why raising
               // thinkTok to 32768 alone still left occasional no-code cases whose longest observed
               // completion was only ~12.6k tokens.
               // SLOWEST_TPS is deliberately pessimistic (the slowest config measured on this fleet);
               // over-waiting costs wall-clock on a rare long case, under-waiting destroys the
               // measurement. +120s covers prefill and server-side queueing.
               const SLOWEST_TPS = 20;
               const timeoutMs = Math.ceil((budget / SLOWEST_TPS) * 1000) + 120_000;
               const { completion } = await client.chat(
                  messages,
                  {
                     think,
                     thinkControl,
                     max_tokens: budget,
                     ...sampling,
                  },
                  timeoutMs,
               );
               raw = completion.choices?.[0]?.message?.content ?? '';
            } catch {
               /* no-code → fails */
            }
            const g = await codingGradeCase(c, raw);
            if (g.pass) {
               passAt1++;
            }
            testsPassed += g.passed ?? 0;
            testsTotal += g.total ?? 0;
            if (/^no-code/.test(g.reason ?? '')) {
               noCode++;
            }
         }
         return {
            bench: name,
            coding_pass_at_1: passAt1,
            coding_total: Object.keys(cases).length,
            coding_tests_passed: testsPassed,
            coding_tests_total: testsTotal,
            coding_no_code: noCode,
            // A no-code case is a HARNESS failure, not a wrong answer: the model emitted no
            // extractable code block, which at think-time means the reasoning trace ate the
            // max_tokens budget before any code was written. Scoring that as 0/N grades the
            // budget, not the model — it is how Qwen3.8's think rows published a coding grade
            // ~14 points under its own no_think rows. So the whole bench result is INVALID:
            // `invalid` is excluded from $LATEST (analysis/pg-store.mjs) and from resume's
            // status='ok' done-set, so the combo neither publishes nor counts as measured.
            // NOTE this is a LOWER BOUND on budget damage — a trace that truncates mid-function
            // yields a `define-error`, not 'no-code', and is indistinguishable from a wrong answer.
            status: noCode > 0 ? 'invalid' : 'ok',
         };
      },
   };
}

// thinkTok is 32768 across all three (raised 2026-08-28 from 8192/8192/16384). The old budgets
// were sized for models that emit a short trace; a reasoning-only model spends them entirely on
// the trace and never reaches the code fence. See the status:'invalid' note above.
export const benches = [
   codingBench('coding_hard', HARD, defaultSystem, 4096, 32768),
   codingBench('coding_practical', PRACTICAL, defaultSystem, 4096, 32768),
   codingBench('coding_bugfix', BUGFIX, bugfixSystem, 8192, 32768),
];
