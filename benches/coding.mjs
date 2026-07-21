// Bench modules: coding_hard / coding_practical / coding_bugfix.
// Reuses the executable grader (benchmarks/coding/grader.mjs runs the tests) + case
// sets. Emits COUNTS (coding_pass_at_1 = #cases fully passing, coding_total = #cases);
// consumers derive the pass@1 rate as coding_pass_at_1/coding_total.
import { CASES as BUGFIX } from '../benchmarks/coding/cases-bugfix.mjs';
import { CASES as HARD } from '../benchmarks/coding/cases-hard.mjs';
import { CASES as PRACTICAL } from '../benchmarks/coding/cases-practical.mjs';
import { gradeCase as codingGradeCase } from '../benchmarks/coding/grader.mjs';

const defaultSystem = (c) =>
   `You are an expert programmer. Implement the requested function in JavaScript.\n` +
   `Respond with ONLY one JavaScript code block defining \`${c.entry}\` — no prose, no tests, no example calls, no console.log. The function must \`return\` its result.`;
const bugfixSystem = (c) =>
   `You are an expert programmer. The user will show you a JavaScript function with a bug. Fix it.\n` +
   `Respond with ONLY one JavaScript code block defining the corrected \`${c.entry}\` — no prose, no tests, no example calls, no console.log. The function must \`return\` its result. Do not repeat the original buggy code.`;

function codingBench(name, cases, buildSystem, maxTok, thinkTok) {
   return {
      name,
      thinkDependent: true,
      async run(client, { think, sampling, thinkControl }) {
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
            try {
               const { completion } = await client.chat(messages, {
                  think,
                  thinkControl,
                  max_tokens: think === true ? thinkTok : maxTok,
                  ...sampling,
               });
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
            status: 'ok',
         };
      },
   };
}

export const benches = [
   codingBench('coding_hard', HARD, defaultSystem, 4096, 8192),
   codingBench('coding_practical', PRACTICAL, defaultSystem, 4096, 8192),
   codingBench('coding_bugfix', BUGFIX, bugfixSystem, 8192, 16384),
];
