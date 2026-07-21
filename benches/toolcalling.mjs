// Bench module: toolcalling. Reuses the validated cases + grader; the driving loop is
// the clean-slate part. Returns a wide "rawRow" (old-shape-compatible) that the
// orchestrator explodes via shared/tidy-schema.mjs — same path as backfill.
import toolGrader from '../benchmarks/toolcalling/grader.mjs';
import { CASES as TOOL_CASES, TOOLS_POOL } from '../benchmarks/toolcalling/toolcases.mjs';

const SYSTEM =
   'You are a helpful assistant with access to tools. Call a tool ONLY when needed. ' +
   'If no tool fits, respond in plain text WITHOUT calling any tool.';

export const bench = {
   name: 'toolcalling',
   thinkDependent: true,
   async run(client, { think, sampling, thinkControl }) {
      let pass = 0;
      for (const [caseId, tc] of Object.entries(TOOL_CASES)) {
         const userMsg = tc.user ?? caseId;
         const tools = (tc.tools ?? []).map((n) => TOOLS_POOL[n]).filter(Boolean);
         const messages = [
            { role: 'system', content: SYSTEM },
            { role: 'user', content: userMsg },
         ];
         let completion;
         try {
            ({ completion } = await client.chat(messages, {
               think,
               thinkControl,
               tools,
               max_tokens: think === true ? 2048 : 1024,
               ...sampling,
            }));
         } catch {
            continue;
         }
         const calls = completion.choices?.[0]?.message?.tool_calls ?? [];
         if (toolGrader(JSON.stringify(calls), { vars: { case_id: caseId } }).pass) {
            pass++;
         }
      }
      return { bench: 'toolcalling', toolcall_pass: pass, toolcall_total: Object.keys(TOOL_CASES).length, status: 'ok' };
   },
};
