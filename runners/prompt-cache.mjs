#!/usr/bin/env node
/**
 * Prompt-cache / prefix-reuse TTFT.
 *
 * Agentic loops re-send a large, mostly-identical prefix every turn (system prompt
 * + tool schemas + growing transcript). llama.cpp's server keeps a per-slot KV
 * cache, so a re-sent prefix skips prefill and the second turn's time-to-first-token
 * collapses. This bench quantifies that benefit directly:
 *
 *   COLD  — send a fixed prefix with a UNIQUE leading nonce → guaranteed cache miss
 *           → full prefill. Record TTFT (timings.prompt_ms).
 *   WARM  — immediately re-send the IDENTICAL prompt (same nonce) → the slot still
 *           holds that prefix → prefill skipped. Record TTFT.
 *
 * speedup = cold_ms ÷ warm_ms. Each rep uses a fresh nonce so its COLD is truly
 * cold (a prior rep's warm cache can't leak in); we take the median across reps.
 * max_tokens is tiny — only the prefill latency matters, not generation.
 *
 * Writes per base model (think-independent — a server/KV property), at one
 * reference depth:
 *   prefix_cache_cold_ms     median cold TTFT
 *   prefix_cache_warm_ms     median warm TTFT   (notes carry cold + speedup)
 *   prefix_cache_speedup     cold ÷ warm
 *
 * Report-only — does NOT enter the multiplicative composite score.
 *
 * Usage: node runners/prompt-cache.mjs [--input results/<runId>] [--models a,b]
 *                                      [--depth 8192] [--reps 3]
 */

import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseArgs } from 'node:util';
import { loadHostConfig } from '../shared/hosts-config.mjs';
import { loadModelsConfig } from '../shared/models-config.mjs';
import { openSecondaryRun } from '../shared/results-store.mjs';
import { extraFlagsToString, llamacppServer } from './llamacpp-server.mjs';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const { values: flags } = parseArgs({
   options: {
      input: { type: 'string' },
      models: { type: 'string', default: '' },
      target: { type: 'string', default: 'rose' },
      depth: { type: 'string', default: '8192' },
      reps: { type: 'string', default: '3' },
   },
});

const modelsCfg = loadModelsConfig(join(ROOT, 'config/models.yaml'));
const {
   llamaUrl: LLAMA_URL,
   sshHost: SSH_HOST,
   backend: BACKEND,
   gpu: GPU,
} = loadHostConfig(join(ROOT, 'config/hosts.yaml'), flags.target);
const DEPTH = Number(flags.depth);
const REPS = Math.max(1, Number(flags.reps));

const { run, seedRows } = openSecondaryRun(join(ROOT, 'results'), {
   target: flags.target,
   gpu: GPU,
   backend: BACKEND,
   kind: 'prompt-cache',
   inputFlag: flags.input,
});
if (!seedRows.length) {
   console.error('Seed run has no result rows — run the suite (maxctx ladder) first.');
   process.exit(1);
}

const maxctxByModel = new Map();
for (const r of seedRows) {
   if (r.bench === 'maxctx' && Number.isFinite(parseFloat(r.score))) {
      maxctxByModel.set(r.model, parseFloat(r.score));
   }
}

const filter = flags.models ? flags.models.split(',').map((s) => s.trim()) : [];
const wanted = modelsCfg.models.filter((m) => {
   const id = m.hf_file.replace(/\.gguf$/, '');
   return !filter.length || filter.some((f) => id.includes(f) || (m.label ?? '').includes(f));
});

const { makeFillPrompt } = await import('../shared/codebase.mjs');
const srv = llamacppServer({ sshHost: SSH_HOST, llamaUrl: LLAMA_URL, backend: BACKEND, debug: !!process.env.BENCH_DEBUG });
const client = srv.client;
let nonce = 0;

const median = (xs) => {
   const s = xs.filter(Number.isFinite).sort((a, b) => a - b);
   const n = s.length;
   if (!n) {
      return null;
   }
   return n % 2 ? s[(n - 1) / 2] : (s[n / 2 - 1] + s[n / 2]) / 2;
};

/** One TTFT (prompt_ms) for `messages`; tiny generation — only prefill matters. */
async function ttftOf(messages) {
   const { timings } = await client.chat(messages, { think: null, max_tokens: 8, temperature: 0.0 }, 300_000);
   const pm = timings?.prompt_ms;
   if (!Number.isFinite(pm)) {
      throw new Error('no prompt_ms');
   }
   return pm;
}

console.log(`\n[prompt-cache] ${wanted.length} models · depth ${DEPTH} · reps ${REPS} · ${LLAMA_URL}\n`);
for (const m of wanted) {
   const id = m.hf_file.replace(/\.gguf$/, '');
   const maxctx = maxctxByModel.get(id);
   if (!maxctx) {
      console.log(`  ${id}: no maxctx in seed — skipping`);
      continue;
   }
   const depth = Math.min(DEPTH, Math.max(1024, maxctx - 1024));
   console.log(`\n══ ${m.label ?? id}  (ctx ${maxctx.toLocaleString()}, prefix ~${Math.round(depth / 1024)}k)`);
   await srv.killAll();
   await srv.waitVramClear(30_000);
   try {
      await srv.startServer({ hf_repo: m.hf_repo, hf_file: m.hf_file, ctx: maxctx, extraFlags: extraFlagsToString(m.extra_flags) });
      await srv.waitHealthy(360_000);
   } catch (e) {
      console.log(`  load failed: ${e.message.slice(0, 70)} — skipping`);
      continue;
   }

   const colds = [];
   const warms = [];
   for (let r = 0; r < REPS; r++) {
      // Fresh nonce → this rep's prefix has never been seen → COLD is a true miss.
      const built = makeFillPrompt(depth);
      const um = built.messages[built.messages.length - 1];
      um.content = `// prompt-cache probe ${++nonce}\n${um.content}`;
      try {
         const cold = await ttftOf(built.messages); // miss: full prefill
         const warm = await ttftOf(built.messages); // hit: identical prefix, prefill skipped
         colds.push(cold);
         warms.push(warm);
         if (process.env.BENCH_DEBUG) {
            console.log(`  rep ${r}: cold ${(cold / 1000).toFixed(2)}s  warm ${(warm / 1000).toFixed(2)}s  (${(cold / warm).toFixed(1)}×)`);
         }
      } catch (e) {
         console.log(`  rep ${r}: error ${e.message.slice(0, 50)}`);
      }
   }
   if (!colds.length) {
      console.log('  no samples — skipping');
      continue;
   }
   const cold = median(colds);
   const warm = median(warms);
   const speedup = warm > 0 ? cold / warm : null;
   console.log(
      `  → cold ${(cold / 1000).toFixed(2)}s  warm ${(warm / 1000).toFixed(2)}s  speedup ${speedup ? `${speedup.toFixed(1)}×` : '?'}  (n=${colds.length})`,
   );
   const common = { target: flags.target, backend: BACKEND, model: id, think: 'n/a', vram_mib: '?', ctx_loaded: maxctx, status: 'ok' };
   run.append({ ...common, bench: 'prefix_cache_cold_ms', score: cold.toFixed(0), notes: `cold prompt_ms@${depth} n=${colds.length}` });
   run.append({
      ...common,
      bench: 'prefix_cache_warm_ms',
      score: warm.toFixed(0),
      notes: `warm prompt_ms@${depth} cold ${cold.toFixed(0)} speedup ${speedup ? speedup.toFixed(2) : '?'} n=${warms.length}`,
   });
   if (speedup != null) {
      run.append({ ...common, bench: 'prefix_cache_speedup', score: speedup.toFixed(2), notes: `cold÷warm@${depth}` });
   }
}
await srv.stopServer();
await srv.waitVramClear(20_000);
run.finalize('complete');
console.log(`\n[prompt-cache] done → ${run.dir}`);
