#!/usr/bin/env node
import { parseArgs } from 'node:util';
import { ensureSchema, insertRows } from '../analysis/pg-store.mjs';
// Standalone bench runner for an already-running vLLM/v100-skinny server.
// Bypasses llama.cpp server lifecycle; pushes results to the same Postgres store.
import { BENCHES } from '../benches/index.mjs';
import { createClient } from '../shared/llm/index.mjs';
import { metricRowsFromResult } from '../shared/tidy-schema.mjs';

const { values: flags } = parseArgs({
   options: {
      benches: { type: 'string', default: 'triage,reasoning,toolcalling,summarization,docqa,coding_hard,coding_practical,coding_bugfix' },
      think: { type: 'string', default: 'both' },
      url: { type: 'string', default: process.env.LLAMA_URL ?? 'http://127.0.0.1:8000' },
   },
});

const MODEL_ID = 'qwen3.8-27b';
const benchNames = flags.benches
   .split(',')
   .map((s) => s.trim())
   .filter((b) => BENCHES[b]);
const thinkModes = flags.think === 'both' ? [false, true] : flags.think === 'think' ? [true] : [false];

const client = createClient(flags.url, { model: MODEL_ID, timeout: 600_000 });

// Verify server
try {
   const r = await globalThis.fetch(`${flags.url}/v1/models`, { signal: AbortSignal.timeout(5000) });
   if (!r.ok) {
      throw new Error(`HTTP ${r.status}`);
   }
   const body = await r.json();
   console.log(`[vllm-bench] server up — models: ${body.data?.map((m) => m.id).join(', ')}`);
} catch (e) {
   console.error(`[vllm-bench] server not reachable at ${flags.url}: ${e.message}`);
   process.exit(1);
}

await ensureSchema();

const TS = new Date().toISOString();
const RUN_ID = `v100-skinny-${TS.replace(/[:.]/g, '').slice(0, 15)}`;

const dims = {
   run_id: RUN_ID,
   run_kind: 'bench',
   ts: TS,
   family: 'qwen3.8',
   type: 'dense',
   total_params: 27,
   active_params: 27,
   quant: 'NVFP4',
   kv_quant: 'fp16',
   spec_decode: 'mtp-k7',
   gpu: 'V100',
   host: 'rose',
   backend: 'vllm-skinny',
   engine_version: 'v100-skinny-1.2.2',
   ctx: 32768,
};

const SAMPLING = { temperature: 0.6, top_p: 0.95, top_k: 20, min_p: 0, presence_penalty: 0 };

const allRows = [];

console.log(`\n=== Quality benchmarks ===`);
for (const benchName of benchNames) {
   const bench = BENCHES[benchName];
   if (!bench) {
      continue;
   }

   for (const think of thinkModes) {
      if (!bench.thinkDependent && think) {
         continue;
      }
      const thinkLabel = think ? 'think' : 'no_think';

      try {
         const result = await bench.run(client, {
            ctx: 32768,
            think,
            sampling: { ...SAMPLING },
            thinkControl: 'enable_thinking',
         });

         const rows = metricRowsFromResult(result, { ...dims, think_mode: thinkLabel });
         allRows.push(...rows);

         const display = JSON.stringify(
            Object.fromEntries(
               Object.entries(result)
                  .filter(([k]) => !['bench', 'status', 'notes'].includes(k))
                  .slice(0, 4),
            ),
         );
         console.log(`  ${benchName.padEnd(20)} ${thinkLabel.padEnd(10)} => ${display}`);
      } catch (e) {
         console.error(`  ${benchName.padEnd(20)} ${thinkLabel.padEnd(10)} => ERROR: ${e.message}`);
      }
   }
}

// Speed measurements
console.log(`\n=== Speed measurements ===`);
const speedTests = [
   { label: 'short', prompt: 'Count from 1 to 50, one per line.', maxTok: 256 },
   { label: 'medium', prompt: 'Count from 1 to 200, one number per line.', maxTok: 1024 },
   {
      label: 'long',
      prompt:
         'Write a detailed essay about the history of computing, covering all major milestones from the abacus to modern AI. Make it at least 1500 words.',
      maxTok: 2048,
   },
];

for (const t of speedTests) {
   const start = Date.now();
   const { completion } = await client.chat([{ role: 'user', content: t.prompt }], { max_tokens: t.maxTok, temperature: 0, think: false });
   const wallMs = Date.now() - start;
   const compTok = completion.usage?.completion_tokens ?? 0;
   const promptTok = completion.usage?.prompt_tokens ?? 0;
   const tps = compTok / (wallMs / 1000);

   console.log(`  ${t.label.padEnd(20)} prompt=${promptTok} gen=${compTok} wall=${wallMs}ms => ${tps.toFixed(1)} tok/s`);

   allRows.push(
      ...metricRowsFromResult(
         { bench: 'speed', [`decode_tps_${t.label}`]: tps, prompt_tokens: promptTok, completion_tokens: compTok, wall_ms: wallMs },
         { ...dims, think_mode: 'no_think' },
      ),
   );
}

// Prefill
console.log(`\n=== Prefill measurements ===`);
const sentence = 'The quick brown fox jumps over the lazy dog. ';
for (const targetTok of [500, 2000, 8000]) {
   const reps = Math.ceil(targetTok / 10);
   const text = sentence.repeat(reps);
   const start = Date.now();
   const { completion } = await client.chat([{ role: 'user', content: `Summarize in one word: ${text}` }], {
      max_tokens: 8,
      temperature: 0,
      think: false,
   });
   const wallMs = Date.now() - start;
   const promptTok = completion.usage?.prompt_tokens ?? 0;
   const prefillTps = promptTok / (wallMs / 1000);

   console.log(`${`  prefill_${targetTok}`.padEnd(22)} prompt=${promptTok} wall=${wallMs}ms => ${prefillTps.toFixed(0)} tok/s`);

   allRows.push(
      ...metricRowsFromResult(
         { bench: 'speed', [`prefill_tps_${targetTok}`]: prefillTps, prompt_tokens: promptTok, wall_ms: wallMs },
         { ...dims, think_mode: 'no_think' },
      ),
   );
}

if (allRows.length > 0) {
   await insertRows(allRows);
   console.log(`\n[vllm-bench] wrote ${allRows.length} rows to Postgres (run ${RUN_ID})`);
} else {
   console.log(`\n[vllm-bench] no rows to write`);
}
