#!/usr/bin/env node

/**
 * Standalone smoke test for the coding grader/sandbox — no llama-server required.
 *
 * The coding benchmark itself is now sourced entirely from benchmarks/coding/
 * cases-multipl.mjs (imported MultiPL-E / HumanEval-JS), so this smoke test no
 * longer exercises a fixed set of curated problems. Instead it feeds a few
 * self-contained cases (covering both the `{args,expected}` pure-fn form and the
 * `{call,expected}` stateful form) through the real grader to prove that
 * extraction, vm isolation, deep-equality, and the timeout path all work before
 * spending a model run. It also seeds negative cases (a wrong solution, an
 * infinite loop, a sandbox-escape attempt, and no-code prose) to confirm they
 * are scored 0 rather than passing or hanging.
 *
 *   npm run coding-smoke
 *
 * Exit 0 if every reference solution is pass@1 and every negative case fails.
 */

import { gradeCase } from '../benchmarks/coding/grader.mjs';

// Self-contained smoke cases — independent of the imported benchmark corpus.
// `fizzbuzz`/`sum-even`/`two-sum` use the {args,expected} pure-fn form; `counter`
// uses the {call,expected} stateful form so both grader paths are exercised.
const CASES = {
   fizzbuzz: {
      entry: 'fizzbuzz',
      tests: [
         { args: [3], expected: 'Fizz' },
         { args: [5], expected: 'Buzz' },
         { args: [15], expected: 'FizzBuzz' },
         { args: [7], expected: '7' },
      ],
   },
   'sum-even': {
      entry: 'sumEven',
      tests: [
         { args: [[1, 2, 3, 4]], expected: 6 },
         { args: [[]], expected: 0 },
         { args: [[2, 4, 6]], expected: 12 },
      ],
   },
   'two-sum': {
      entry: 'twoSum',
      tests: [
         { args: [[2, 7, 11, 15], 9], expected: [0, 1] },
         { args: [[3, 2, 4], 6], expected: [1, 2] },
      ],
   },
   counter: {
      entry: 'makeCounter',
      tests: [
         { call: '(() => { const c = makeCounter(); c(); c(); return c(); })()', expected: 3 },
         { call: '(() => { const c = makeCounter(10); return c(); })()', expected: 11 },
      ],
   },
};

// Reference solutions, returned the way a model would — inside a ```js block.
const SOLUTIONS = {
   fizzbuzz: `function fizzbuzz(n){let s='';if(n%3===0)s+='Fizz';if(n%5===0)s+='Buzz';return s||String(n);}`,
   'sum-even': `function sumEven(nums){return nums.filter(x=>x%2===0).reduce((a,b)=>a+b,0);}`,
   'two-sum': `function twoSum(nums,target){const m=new Map();for(let i=0;i<nums.length;i++){const c=target-nums[i];if(m.has(c))return [m.get(c),i];m.set(nums[i],i);}return [];}`,
   counter: `function makeCounter(start){let n=start||0;return ()=>++n;}`,
};

// Negative cases: must all score < 1.0 and must not hang the suite.
const NEGATIVES = [
   { id: 'fizzbuzz', label: 'wrong-answer', output: '```js\nfunction fizzbuzz(n){return String(n);}\n```' },
   { id: 'sum-even', label: 'infinite-loop', output: '```js\nfunction sumEven(nums){while(true){}return 0;}\n```' },
   { id: 'sum-even', label: 'sandbox-escape', output: "```js\nfunction sumEven(nums){return require('fs').readdirSync('.').length;}\n```" },
   { id: 'two-sum', label: 'no-code', output: 'I think the answer involves a hash map but here it is in prose only.' },
];

async function main() {
   let fails = 0;

   console.log('── reference solutions (expect pass@1) ──');
   for (const [id, caseObj] of Object.entries(CASES)) {
      const sol = SOLUTIONS[id];
      if (!sol) {
         console.log(`  ?? ${id.padEnd(20)} NO REFERENCE SOLUTION`);
         fails++;
         continue;
      }
      const r = await gradeCase(caseObj, `\`\`\`js\n${sol}\n\`\`\``);
      const ok = r.pass;
      if (!ok) {
         fails++;
      }
      console.log(`  ${ok ? 'OK' : 'XX'} ${id.padEnd(20)} ${r.reason}`);
   }

   console.log('\n── negative cases (expect failure, no hang) ──');
   for (const neg of NEGATIVES) {
      const t0 = Date.now();
      const r = await gradeCase(CASES[neg.id], neg.output, { timeoutMs: 3000 });
      const elapsed = Date.now() - t0;
      const ok = !r.pass; // a negative case is "ok" when it does NOT pass
      if (!ok) {
         fails++;
      }
      console.log(`  ${ok ? 'OK' : 'XX'} ${neg.label.padEnd(16)} ${r.reason}  (${elapsed}ms)`);
   }

   console.log(`\n${fails === 0 ? 'PASS' : `FAIL (${fails})`} — coding sandbox + grader`);
   process.exit(fails === 0 ? 0 : 1);
}

main();
