// Bench module: agentic_loop (multi-step tool use + error recovery). Reuses the
// validated agentic cases/executor/graders; think-independent (probe think).
import { CASES, makeExecutor, TOOLS } from '../benchmarks/agentic/agentic-cases.mjs';

const SYSTEM =
   'You are a helpful assistant with access to tools. To answer questions about users, accounts and currencies, ' +
   'call the tools step by step — feed the result of one call into the next. When you have enough information, ' +
   'stop calling tools and reply with the final answer only. Do not call tools you do not need.';

export const bench = {
   name: 'agentic_loop',
   thinkDependent: false,
   async run(client, { think, thinkControl }) {
      let passed = 0,
         recTasks = 0,
         recOk = 0;
      for (const c of CASES) {
         const messages = [
            { role: 'system', content: SYSTEM },
            { role: 'user', content: c.prompt },
         ];
         let res = { content: '', steps: 0, allToolCalls: [] };
         try {
            res = await client.toolsLoop(messages, TOOLS, makeExecutor(), {
               maxSteps: 12,
               think,
               thinkControl,
               max_tokens: 1024,
               temperature: 0.0,
            });
         } catch {
            /* graded as fail */
         }
         let g = { pass: false };
         try {
            g = c.grade(res);
         } catch {
            g = { pass: false };
         }
         if (g.pass) passed++;
         if ('recovered' in g) {
            recTasks++;
            if (g.recovered) recOk++;
         }
      }
      return { bench: 'agentic_loop', score: CASES.length ? (passed / CASES.length) * 100 : 0, status: 'ok' };
   },
};
