// Bench module: instruction_following. Reuses benchmarks/instruction-following cases
// (each case = a prompt + a list of literal check predicates). Think-independent.
import { CASES } from '../benchmarks/instruction-following/ifcases.mjs';

const SYSTEM = 'Follow the user instruction exactly. Obey every formatting and length constraint literally.';

export const bench = {
   name: 'instruction_following',
   thinkDependent: false,
   async run(client, { think, thinkControl }) {
      let totalChecks = 0,
         passedChecks = 0;
      for (const c of CASES) {
         const messages = [
            { role: 'system', content: SYSTEM },
            { role: 'user', content: c.prompt },
         ];
         let text = '';
         try {
            const { completion } = await client.chat(messages, { think, thinkControl, max_tokens: 1024, temperature: 0.0 }, 300000);
            text = completion?.choices?.[0]?.message?.content ?? '';
         } catch {
            /* empty → fails checks */
         }
         for (const chk of c.checks) {
            let ok = false;
            try {
               ok = !!chk.test(text);
            } catch {
               ok = false;
            }
            if (ok) { passedChecks++; }
            totalChecks++;
         }
      }
      return { bench: 'instruction_following', score: totalChecks ? (passedChecks / totalChecks) * 100 : 0, status: 'ok' };
   },
};
