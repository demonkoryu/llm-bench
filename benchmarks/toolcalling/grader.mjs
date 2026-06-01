/**
 * promptfoo grader for the tool-calling benchmark.
 *
 * context.vars.expect_tool   — expected tool name, or null for no-call traps
 * context.vars.validate_args — comma-separated validation rules:
 *   city_contains=X      args.city matches /X/i
 *   unit_eq=X            args.unit === X
 *   amount_eq=N          args.amount === N (numeric)
 *   from_contains=X      args.from matches /X/i
 *   to_contains=X        args.to matches /X/i
 *   to_contains=X        args.to matches /X/i
 *   subject_contains=X   args.subject matches /X/i
 *   body_contains=X      args.body matches /X/i
 *   query_contains=X     args.query matches /X/i
 *   numbers_sorted_eq=X  [...args.numbers].sort() joined === X
 *
 * output is the raw Ollama response body JSON string (from promptfoo's
 * custom provider, which serializes the response body for the grader).
 * When using the standard Ollama provider, output is the assistant message text
 * and tool_calls are not directly accessible — run-suite.mjs uses a custom
 * provider wrapper that injects tool_calls into context.metadata instead.
 */

export default function(_output, context) {
   const expectTool = context?.vars?.expect_tool ?? null;
   const validateSpec = context?.vars?.validate_args ?? '';
   const caseId = context?.vars?.case_id ?? '?';

   // Tool calls injected by the custom provider wrapper via context.metadata
   const toolCalls = context?.metadata?.tool_calls ?? [];

   // No-call trap
   if (expectTool === null) {
      if (toolCalls.length === 0) {
         return { pass: true, score: 1, reason: 'correctly no tool called' };
      }
      return { pass: false, score: 0, reason: `hallucinated call: ${toolCalls[0]?.function?.name}` };
   }

   // Expected a specific tool
   if (toolCalls.length === 0) {
      return { pass: false, score: 0, reason: `no tool called, expected ${expectTool}` };
   }

   const call = toolCalls[0];
   const name = call.function?.name;
   if (name !== expectTool) {
      return { pass: false, score: 0, reason: `wrong tool: ${name}, expected ${expectTool}` };
   }

   let args = call.function?.arguments;
   if (typeof args === 'string') {
      try { args = JSON.parse(args); } catch {
         return { pass: false, score: 0, reason: 'args not valid JSON' };
      }
   }
   if (!args || typeof args !== 'object') {
      return { pass: false, score: 0, reason: 'no args object' };
   }

   // Run validate_args rules
   if (validateSpec) {
      for (const rule of validateSpec.split(',')) {
         const [key, val] = rule.split('=');
         const fail = (why) => ({ pass: false, score: 0, reason: `${caseId}: ${why} (args=${JSON.stringify(args).slice(0, 80)})` });

         if (key === 'city_contains') {
            if (!new RegExp(val, 'i').test(args.city ?? '')) return fail(`city "${args.city}" doesn't contain "${val}"`);
         } else if (key === 'unit_eq') {
            if (args.unit !== val) return fail(`unit "${args.unit}" != "${val}"`);
         } else if (key === 'amount_eq') {
            if (args.amount !== Number(val)) return fail(`amount ${args.amount} != ${val}`);
         } else if (key === 'from_contains') {
            if (!new RegExp(val, 'i').test(args.from ?? '')) return fail(`from "${args.from}" doesn't contain "${val}"`);
         } else if (key === 'to_contains') {
            if (!new RegExp(val, 'i').test(args.to ?? '')) return fail(`to "${args.to}" doesn't contain "${val}"`);
         } else if (key === 'subject_contains') {
            if (!new RegExp(val, 'i').test(args.subject ?? '')) return fail(`subject doesn't contain "${val}"`);
         } else if (key === 'body_contains') {
            if (!new RegExp(val, 'i').test(args.body ?? '')) return fail(`body doesn't contain "${val}"`);
         } else if (key === 'query_contains') {
            if (!new RegExp(val, 'i').test(args.query ?? '')) return fail(`query "${args.query}" doesn't contain "${val}"`);
         } else if (key === 'numbers_sorted_eq') {
            if (!Array.isArray(args.numbers)) return fail(`numbers not an array`);
            const sorted = [...args.numbers].sort((a, b) => a - b).join(',');
            if (sorted !== val) return fail(`numbers sorted "${sorted}" != "${val}"`);
         }
      }
   }

   return { pass: true, score: 1, reason: `ok: ${expectTool}(${JSON.stringify(args).slice(0, 60)})` };
}
