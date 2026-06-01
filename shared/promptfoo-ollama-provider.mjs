/**
 * Custom promptfoo provider for Ollama.
 *
 * Handles three Ollama call patterns transparently:
 *   chat        — plain messages (reasoning, summarization)
 *   chat+format — structured JSON output (triage)
 *   chat+tools  — native tools API (toolcalling)
 *
 * Config is passed via environment variables set by run-suite.mjs:
 *   BENCH_MODEL       Ollama model tag
 *   BENCH_THINK       "true" | "false" | "" (omit)
 *   BENCH_BENCH       bench name → determines call pattern
 *   BENCH_OPTS_JSON   JSON string of Ollama options (temperature, etc.)
 *   OLLAMA_HOST       Ollama endpoint (default http://192.168.1.120:11434)
 *
 * promptfoo calls callApi(prompt, context) where prompt is a JSON string
 * of [{role, content}, ...] messages (chat format) or a plain string.
 *
 * Returns { output, tokenUsage, metadata }
 *   output   — model's text content (JSON string for triage; text for others)
 *   metadata — { tool_calls, tok_per_sec, think_chars } for downstream graders
 */

import { TRIAGE_SCHEMA } from './triage-prompt.mjs';

const OLLAMA_HOST = process.env.OLLAMA_HOST ?? 'http://192.168.1.120:11434';
const TIMEOUT_MS = 600_000;

// Tool definitions (same pool as toolcall-bench.mjs)
const TOOLS_POOL = {
   get_weather: {
      type: 'function',
      function: {
         name: 'get_weather',
         description: 'Get the current weather for a city.',
         parameters: {
            type: 'object',
            properties: {
               city: { type: 'string', description: 'City name' },
               unit: { type: 'string', enum: ['celsius', 'fahrenheit'] },
            },
            required: ['city'],
         },
      },
   },
   add_numbers: {
      type: 'function',
      function: {
         name: 'add_numbers',
         description: 'Add a list of numbers and return the sum.',
         parameters: {
            type: 'object',
            properties: { numbers: { type: 'array', items: { type: 'number' } } },
            required: ['numbers'],
         },
      },
   },
   send_email: {
      type: 'function',
      function: {
         name: 'send_email',
         description: 'Send an email.',
         parameters: {
            type: 'object',
            properties: {
               to: { type: 'string' },
               subject: { type: 'string' },
               body: { type: 'string' },
            },
            required: ['to', 'subject', 'body'],
         },
      },
   },
   convert_currency: {
      type: 'function',
      function: {
         name: 'convert_currency',
         description: 'Convert an amount from one currency to another.',
         parameters: {
            type: 'object',
            properties: {
               amount: { type: 'number' },
               from: { type: 'string' },
               to: { type: 'string' },
            },
            required: ['amount', 'from', 'to'],
         },
      },
   },
   search_db: {
      type: 'function',
      function: {
         name: 'search_db',
         description: 'Search the product database by query string.',
         parameters: {
            type: 'object',
            properties: { query: { type: 'string' }, limit: { type: 'integer' } },
            required: ['query'],
         },
      },
   },
};

function parseMessages(prompt) {
   try {
      const parsed = JSON.parse(prompt);
      if (Array.isArray(parsed)) return parsed;
   } catch {}
   return [{ role: 'user', content: prompt }];
}

export default class OllamaProvider {
   id() { return `ollama-bench:${process.env.BENCH_MODEL ?? 'unknown'}`; }

   async callApi(prompt, context) {
      return callApi(prompt, context);
   }
}

async function callApi(prompt, context) {
   const model = process.env.BENCH_MODEL ?? 'qwen3.5:4b';
   const bench = process.env.BENCH_BENCH ?? 'chat';
   const thinkEnv = process.env.BENCH_THINK ?? '';
   const think = thinkEnv === 'true' ? true : thinkEnv === 'false' ? false : null;
   const opts = process.env.BENCH_OPTS_JSON ? JSON.parse(process.env.BENCH_OPTS_JSON) : { temperature: 0.1 };

   const messages = parseMessages(prompt);

   const body = { model, messages, stream: false, options: opts };
   if (think !== null) body.think = think;

   // Bench-specific additions
   if (bench === 'triage') {
      body.format = TRIAGE_SCHEMA;
   } else if (bench === 'toolcalling') {
      const toolsSubset = context?.vars?.tools_subset;
      const toolNames = Array.isArray(toolsSubset) ? toolsSubset : (toolsSubset ?? '').split(',').map((s) => s.trim()).filter(Boolean);
      body.tools = toolNames.map((n) => TOOLS_POOL[n]).filter(Boolean);
   }

   const t0 = Date.now();
   let resp;
   try {
      const res = await fetch(`${OLLAMA_HOST}/api/chat`, {
         method: 'POST',
         headers: { 'Content-Type': 'application/json' },
         signal: AbortSignal.timeout(TIMEOUT_MS),
         body: JSON.stringify(body),
      });
      resp = await res.json();
   } catch (e) {
      return { error: `fetch failed: ${e.message}` };
   }

   if (resp.error) {
      return { error: resp.error };
   }

   const wallMs = Date.now() - t0;
   const content = resp.message?.content ?? '';
   const toolCalls = resp.message?.tool_calls ?? [];
   const thinkChars = resp.message?.thinking?.length
      ?? content.match(/<think>([\s\S]*?)<\/think>/)?.[1]?.length ?? 0;
   const tokPerSec = resp.eval_count && resp.eval_duration
      ? (resp.eval_count / (resp.eval_duration / 1e9)).toFixed(1)
      : null;

   // For toolcalling: output is the serialized tool_calls array so the grader
   // can inspect it; also pass via metadata for forward-compat
   const output = bench === 'toolcalling'
      ? JSON.stringify(toolCalls)
      : content;

   return {
      output,
      tokenUsage: {
         total: (resp.prompt_eval_count ?? 0) + (resp.eval_count ?? 0),
         prompt: resp.prompt_eval_count ?? 0,
         completion: resp.eval_count ?? 0,
      },
      metadata: {
         tool_calls: toolCalls,
         tok_per_sec: tokPerSec,
         think_chars: thinkChars,
         wall_ms: wallMs,
      },
   };
}
