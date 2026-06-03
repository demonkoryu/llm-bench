/**
 * Tool-calling session-length decay benchmark.
 *
 * Measures accuracy degradation as conversation context grows.
 * Rounds: 0 / 5 / 20 / 50 accumulated filler tool-call turns.
 *
 * Uses llama.cpp OpenAI-compat endpoint (LLAMA_URL env var).
 *
 * Usage:
 *   LLAMA_URL=http://192.168.1.120:8090 node benchmarks/toolcalling/decay-bench.mjs [model_tag] [max_rounds]
 */

import { openaiCompatClient } from '../../shared/openai-compat.mjs';

const LLAMA_URL  = process.env.LLAMA_URL ?? 'http://192.168.1.120:8090';
const MODEL_TAG  = process.argv[2] ?? 'qwen3.5:4b';
const MAX_ROUNDS = parseInt(process.argv[3] ?? '50', 10);

const client = openaiCompatClient(LLAMA_URL);

const TOOLS = [
   {
      type: 'function',
      function: {
         name: 'get_weather',
         description: 'Get the current weather for a city.',
         parameters: { type: 'object', properties: { city: { type: 'string' }, unit: { type: 'string', enum: ['celsius', 'fahrenheit'] } }, required: ['city'] },
      },
   },
   {
      type: 'function',
      function: {
         name: 'add_numbers',
         description: 'Add a list of numbers and return the sum.',
         parameters: { type: 'object', properties: { numbers: { type: 'array', items: { type: 'number' } } }, required: ['numbers'] },
      },
   },
   {
      type: 'function',
      function: {
         name: 'search_db',
         description: 'Search the product database by query string.',
         parameters: { type: 'object', properties: { query: { type: 'string' }, limit: { type: 'integer' } }, required: ['query'] },
      },
   },
];

const FILLER_TURNS = [
   { user: 'What is the weather in London?', tool: 'get_weather', args: { city: 'London', unit: 'celsius' }, result: '{"temperature":15,"condition":"cloudy"}' },
   { user: 'Add 3 and 7.', tool: 'add_numbers', args: { numbers: [3, 7] }, result: '{"sum":10}' },
   { user: 'Weather in Paris in fahrenheit?', tool: 'get_weather', args: { city: 'Paris', unit: 'fahrenheit' }, result: '{"temperature":59,"condition":"sunny"}' },
   { user: 'Search for laptops in the catalog.', tool: 'search_db', args: { query: 'laptops' }, result: '[{"id":1,"name":"ThinkPad X1"}]' },
   { user: 'Sum 10, 20, 30.', tool: 'add_numbers', args: { numbers: [10, 20, 30] }, result: '{"sum":60}' },
   { user: 'Tokyo weather?', tool: 'get_weather', args: { city: 'Tokyo' }, result: '{"temperature":22,"condition":"clear"}' },
   { user: 'Find keyboards in stock.', tool: 'search_db', args: { query: 'keyboards' }, result: '[{"id":5,"name":"HHKB Pro 2"}]' },
   { user: 'Calculate 100 + 200 + 300.', tool: 'add_numbers', args: { numbers: [100, 200, 300] }, result: '{"sum":600}' },
   { user: "What's the weather like in Berlin?", tool: 'get_weather', args: { city: 'Berlin' }, result: '{"temperature":8,"condition":"rain"}' },
   { user: 'Search for monitors.', tool: 'search_db', args: { query: 'monitors' }, result: '[{"id":9,"name":"LG 27UK850"}]' },
];

const PROBE_CASES = [
   { id: 'weather-basic',  user: 'What is the weather in Tokyo right now?',               expect: 'get_weather', check: (a) => /tokyo/i.test(a.city ?? '') },
   { id: 'add-list',       user: 'Add up these numbers for me: 12, 30, and 8.',           expect: 'add_numbers', check: (a) => Array.isArray(a.numbers) && [...a.numbers].sort((x, y) => x - y).join(',') === '8,12,30' },
   { id: 'search',         user: 'Find wireless headphones in the catalog, show me 5.',   expect: 'search_db',   check: (a) => /headphone/i.test(a.query ?? '') },
   { id: 'no-tool',        user: 'Thanks, that is all I needed. Have a good day!',         expect: null,          check: () => true },
   { id: 'missing-tool',   user: 'Book me a flight from London to New York tomorrow.',     expect: null,          check: () => true },
];

const SYSTEM = 'You are a helpful assistant with access to tools. Call a tool ONLY when needed. If no available tool fits, respond in plain text.';

function gradeCall(c, calls) {
   if (c.expect === null) {
      return calls.length === 0 ? { pass: true } : { pass: false, why: `hallucinated: ${calls[0]?.function?.name}` };
   }
   if (!calls.length) return { pass: false, why: 'no call' };
   const name = calls[0].function?.name;
   if (name !== c.expect) return { pass: false, why: `wrong tool: ${name}` };
   let args = calls[0].function?.arguments;
   if (typeof args === 'string') { try { args = JSON.parse(args); } catch { return { pass: false, why: 'bad args JSON' }; } }
   return c.check(args ?? {}) ? { pass: true } : { pass: false, why: `bad args: ${JSON.stringify(args).slice(0, 60)}` };
}

function buildHistory(fillerCount) {
   const history = [{ role: 'system', content: SYSTEM }];
   for (let i = 0; i < fillerCount; i++) {
      const t = FILLER_TURNS[i % FILLER_TURNS.length];
      history.push({ role: 'user',      content: t.user });
      history.push({ role: 'assistant', content: null, tool_calls: [{ function: { name: t.tool, arguments: t.args } }] });
      history.push({ role: 'tool',      content: t.result });
   }
   return history;
}

const ROUND_BUCKETS = [0, 5, 20, 50].filter((r) => r <= MAX_ROUNDS);
const bucketResults = [];

console.log(`\nTool-calling decay — ${MODEL_TAG}  max_rounds=${MAX_ROUNDS}  endpoint=${LLAMA_URL}`);

for (const fillerCount of ROUND_BUCKETS) {
   const history = buildHistory(fillerCount);
   let pass = 0;

   process.stdout.write(`  ── Round ${fillerCount} (${history.length} msgs) ──\n`);

   for (const c of PROBE_CASES) {
      const messages = [...history, { role: 'user', content: c.user }];
      try {
         const resp = await client.chat(messages, { think: false, tools: TOOLS, temperature: 0.4, top_p: 0.9 });
         const calls = client.toolCalls(resp);
         const g = gradeCall(c, calls);
         if (g.pass) pass++;
         process.stdout.write(`    ${c.id.padEnd(18)} ${g.pass ? 'ok' : `FAIL: ${g.why}`}\n`);
      } catch (e) {
         process.stdout.write(`    ${c.id.padEnd(18)} ERROR: ${e.message}\n`);
      }
   }

   const acc = (pass / PROBE_CASES.length * 100).toFixed(1);
   process.stdout.write(`  Accuracy: ${pass}/${PROBE_CASES.length} (${acc}%)\n\n`);
   bucketResults.push({ fillerCount, ctxMsg: history.length, pass, total: PROBE_CASES.length, acc });
}

console.log(`\n${'═'.repeat(60)}\n  DECAY SUMMARY — ${MODEL_TAG}\n${'═'.repeat(60)}`);
console.log(`  ${'Filler turns'.padEnd(14)} ${'Ctx msgs'.padEnd(10)} ${'Accuracy'.padEnd(10)}`);
console.log(`  ${'─'.repeat(36)}`);
for (const r of bucketResults) {
   console.log(`  ${String(r.fillerCount).padEnd(14)} ${String(r.ctxMsg).padEnd(10)} ${(r.acc + '%').padEnd(10)}`);
}
console.log('\n--- DONE ---');
