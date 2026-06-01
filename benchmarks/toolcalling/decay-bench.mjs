/**
 * Tool-calling session-length decay benchmark.
 *
 * Measures how tool-calling accuracy degrades as the conversation context grows.
 * Runs the same 10 tool-call cases but with an accumulating message history:
 *   - Round  5: ~5 prior tool-call turns already in context
 *   - Round 20: ~20 prior turns
 *   - Round 50: ~50 prior turns
 *
 * Each prior turn is a realistic tool call + result exchange to simulate a real
 * long-running MCP session. Reports accuracy per round bucket.
 *
 * Usage:
 *   OLLAMA_HOST=... node benchmarks/toolcalling/decay-bench.mjs [model] [max_rounds]
 */

import { ollamaClient } from '../../shared/ollama.mjs';

const OLLAMA_HOST = process.env.OLLAMA_HOST ?? 'http://192.168.1.120:11434';
const MODEL = process.argv[2] ?? 'qwen3.5:4b';
const MAX_ROUNDS = parseInt(process.argv[3] ?? '50', 10);

const client = ollamaClient(OLLAMA_HOST);

// ── Tool definitions (subset from toolcall-bench.mjs) ──────────────────────────
const TOOLS = [
   {
      type: 'function',
      function: {
         name: 'get_weather',
         description: 'Get the current weather for a city.',
         parameters: {
            type: 'object',
            properties: {
               city: { type: 'string' },
               unit: { type: 'string', enum: ['celsius', 'fahrenheit'] },
            },
            required: ['city'],
         },
      },
   },
   {
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
   {
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
];

// ── Filler turns — realistic prior tool exchanges to grow context ──────────────
// Each entry becomes: user → assistant(tool_call) → tool(result) in message history.
const FILLER_TURNS = [
   { user: 'What is the weather in London?', tool: 'get_weather', args: { city: 'London', unit: 'celsius' }, result: '{"temperature":15,"condition":"cloudy"}' },
   { user: 'Add 3 and 7.', tool: 'add_numbers', args: { numbers: [3, 7] }, result: '{"sum":10}' },
   { user: 'Weather in Paris in fahrenheit?', tool: 'get_weather', args: { city: 'Paris', unit: 'fahrenheit' }, result: '{"temperature":59,"condition":"sunny"}' },
   { user: 'Search for laptops in the catalog.', tool: 'search_db', args: { query: 'laptops' }, result: '[{"id":1,"name":"ThinkPad X1"},{"id":2,"name":"MacBook Pro"}]' },
   { user: 'Sum 10, 20, 30.', tool: 'add_numbers', args: { numbers: [10, 20, 30] }, result: '{"sum":60}' },
   { user: 'Tokyo weather?', tool: 'get_weather', args: { city: 'Tokyo' }, result: '{"temperature":22,"condition":"clear"}' },
   { user: 'Find keyboards in stock.', tool: 'search_db', args: { query: 'keyboards' }, result: '[{"id":5,"name":"HHKB Pro 2"}]' },
   { user: 'Calculate 100 + 200 + 300.', tool: 'add_numbers', args: { numbers: [100, 200, 300] }, result: '{"sum":600}' },
   { user: 'What\'s the weather like in Berlin?', tool: 'get_weather', args: { city: 'Berlin' }, result: '{"temperature":8,"condition":"rain"}' },
   { user: 'Search for monitors.', tool: 'search_db', args: { query: 'monitors' }, result: '[{"id":9,"name":"LG 27UK850"}]' },
];

// ── Probe cases — same 10 from toolcall-bench.mjs; only basic grading here ────
const PROBE_CASES = [
   { id: 'weather-basic', user: 'What is the weather in Tokyo right now?', expect: 'get_weather', check: (a) => /tokyo/i.test(a.city ?? '') },
   { id: 'add-list', user: 'Add up these numbers for me: 12, 30, and 8.', expect: 'add_numbers', check: (a) => Array.isArray(a.numbers) && [...a.numbers].sort((x, y) => x - y).join(',') === '8,12,30' },
   { id: 'search', user: 'Find wireless headphones in the catalog, show me 5.', expect: 'search_db', check: (a) => /headphone/i.test(a.query ?? '') },
   { id: 'no-tool', user: 'Thanks, that is all I needed. Have a good day!', expect: null, check: () => true },
   { id: 'missing-tool', user: 'Book me a flight from London to New York tomorrow.', expect: null, check: () => true },
];

const SYSTEM = `You are a helpful assistant with access to tools. Call a tool ONLY when needed. If no available tool fits, respond in plain text.`;

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
      history.push({ role: 'user', content: t.user });
      history.push({ role: 'assistant', content: null, tool_calls: [{ function: { name: t.tool, arguments: t.args } }] });
      history.push({ role: 'tool', content: t.result });
   }
   return history;
}

// ── Main ──────────────────────────────────────────────────────────────────────
const ROUND_BUCKETS = [0, 5, 20, 50].filter((r) => r <= MAX_ROUNDS);

console.log(`\nTool-calling decay — model=${MODEL}  max_rounds=${MAX_ROUNDS}`);
console.log(`Probe cases: ${PROBE_CASES.length}  |  Filler templates: ${FILLER_TURNS.length}\n`);

await client.unloadAll();
await client.warmup(MODEL, true);

const bucketResults = [];

for (const fillerCount of ROUND_BUCKETS) {
   const history = buildHistory(fillerCount);
   const ctxMsg = history.length;
   let pass = 0;
   const rows = [];

   process.stdout.write(`  ── Round ${fillerCount} (${ctxMsg} msgs in history) ──\n`);

   for (const c of PROBE_CASES) {
      const messages = [...history, { role: 'user', content: c.user }];
      try {
         const body = await client.chat({ model: MODEL, messages, think: false, tools: TOOLS, options: { temperature: 0.4, top_p: 0.9, num_ctx: 8192 } });
         const calls = body.message?.tool_calls ?? [];
         const g = gradeCall(c, calls);
         if (g.pass) pass++;
         process.stdout.write(`    ${c.id.padEnd(18)} ${g.pass ? 'ok' : `FAIL: ${g.why}`}\n`);
         rows.push({ id: c.id, pass: g.pass });
      } catch (e) {
         process.stdout.write(`    ${c.id.padEnd(18)} ERROR: ${e.message}\n`);
         rows.push({ id: c.id, pass: false });
      }
   }

   const acc = (pass / PROBE_CASES.length * 100).toFixed(1);
   process.stdout.write(`  Accuracy: ${pass}/${PROBE_CASES.length} (${acc}%)  context_msgs=${ctxMsg}\n\n`);
   bucketResults.push({ fillerCount, ctxMsg, pass, total: PROBE_CASES.length, acc });
}

// Summary
console.log(`\n${'═'.repeat(60)}\n  DECAY SUMMARY — ${MODEL}\n${'═'.repeat(60)}`);
console.log(`  ${'Filler turns'.padEnd(14)} ${'Ctx msgs'.padEnd(10)} ${'Accuracy'.padEnd(10)}`);
console.log(`  ${'─'.repeat(36)}`);
for (const r of bucketResults) {
   console.log(`  ${String(r.fillerCount).padEnd(14)} ${String(r.ctxMsg).padEnd(10)} ${(r.acc + '%').padEnd(10)}`);
}
console.log('\n--- DONE ---');
