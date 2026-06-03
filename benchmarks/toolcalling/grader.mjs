/**
 * promptfoo grader for the tool-calling benchmark.
 * Validation logic lives in toolcases.mjs to avoid YAML array expansion issues.
 * Output from the provider is a JSON-serialized tool_calls array.
 */

import { CASES } from './toolcases.mjs';

export default function (output, context) {
   const caseId = context?.vars?.case_id ?? '?';
   const c = CASES[caseId];
   if (!c) {
      return { pass: false, score: 0, reason: `Unknown case_id: ${caseId}` };
   }

   // Parse tool_calls from provider output
   let toolCalls = [];
   try {
      toolCalls = JSON.parse(output ?? '[]');
      if (!Array.isArray(toolCalls)) {
         toolCalls = [];
      }
   } catch {
      // Empty/non-JSON output = no tool called
   }

   // No-call cases
   if (c.expect === null) {
      if (toolCalls.length === 0) {
         return { pass: true, score: 1, reason: 'correctly no tool called' };
      }
      return { pass: false, score: 0, reason: `hallucinated call: ${toolCalls[0]?.function?.name}` };
   }

   if (toolCalls.length === 0) {
      return { pass: false, score: 0, reason: `no tool called, expected ${c.expect}` };
   }

   const call = toolCalls[0];
   const name = call.function?.name;
   if (name !== c.expect) {
      return { pass: false, score: 0, reason: `wrong tool: ${name}, expected ${c.expect}` };
   }

   let args = call.function?.arguments;
   if (typeof args === 'string') {
      try {
         args = JSON.parse(args);
      } catch {
         return { pass: false, score: 0, reason: 'args not valid JSON' };
      }
   }
   if (!args || typeof args !== 'object') {
      return { pass: false, score: 0, reason: 'no args object' };
   }

   try {
      return c.validate(args)
         ? { pass: true, score: 1, reason: `ok: ${c.expect}(${JSON.stringify(args).slice(0, 60)})` }
         : { pass: false, score: 0, reason: `bad args: ${JSON.stringify(args).slice(0, 80)}` };
   } catch (e) {
      return { pass: false, score: 0, reason: `validate error: ${e.message}` };
   }
}
