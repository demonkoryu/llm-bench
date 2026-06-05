#!/usr/bin/env node
/**
 * Directly-measured end-to-end throughput + time-to-first-token (TTFT).
 *
 * This replaces the SYNTHETIC `totalE2E` metric, which combined two *separately
 * measured* runs (a prefill probe and a decode probe) through a formula and fell
 * back to raw decode tok/s when the prefill probe was missing — a fallback that
 * made models with LESS data look FASTER. Here every number comes from a single
 * real request, read straight from llama.cpp's server-side `timings`:
 *
 *   TTFT (ms)        = timings.prompt_ms                         (prefill latency)
 *   E2E tok/s        = (prompt_n + predicted_n)
 *                       ÷ ((prompt_ms + predicted_ms) / 1000)    (one request)
 *
 * No formula across runs, no fallback, no network noise — prompt_ms/predicted_ms
 * are the server's own compute timings for that exact generation.
 *
 * `--ignore-eos` (forwarded as the llama.cpp `ignore_eos` sampling flag) forces a
 * fixed GEN-token decode regardless of when the model would naturally stop, so the
 * decode workload — and therefore the throughput — is identical across models.
 * A unique leading nonce busts the server KV prefix cache so every rep is a fresh
 * full prefill (makeFillPrompt is deterministic and would otherwise cache-hit).
 *
 * Writes, per base model (think-independent — throughput is a hardware property):
 *   e2e-<k>k    score = median end-to-end tok/s   (tok_s = decode, prefill_tps = prefill)
 *   ttft-<k>k   score = median prompt_ms          (decoupled from quality-decay)
 *
 * Quick by design: a few short fixed-length requests per depth. Reuses the model's
 * known max ctx from the input CSV — no binary search.
 *
 * Usage: node runners/throughput-ttft.mjs [--input results/<csv>] [--models a,b]
 *                                         [--depths 2048,8192,32768] [--gen 256] [--reps 3]
 */

import { existsSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseArgs } from 'node:util';
import { appendRow, ensureHeader, latestResultsFile, readTable } from '../shared/results-csv.mjs';
import { extraFlagsToString, llamacppServer } from './llamacpp-server.mjs';
import { loadModelsConfig } from '../shared/models-config.mjs';
import { loadHostConfig } from '../shared/hosts-config.mjs';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const { values: flags } = parseArgs({
   options: {
      input: { type: 'string' },
      models: { type: 'string', default: '' },
      depths: { type: 'string', default: '2048,8192,32768' },
      target: { type: 'string', default: 'rose' },
      gen: { type: 'string', default: '256' },
      reps: { type: 'string', default: '3' },
   },
});

const modelsCfg = loadModelsConfig(join(ROOT, 'config/models.yaml'));
const { llamaUrl: LLAMA_URL, sshHost: SSH_HOST, backend: BACKEND } = loadHostConfig(join(ROOT, 'config/hosts.yaml'), flags.target);
const GEN = Number(flags.gen);
const REPS = Math.max(1, Number(flags.reps));
const DEPTHS = flags.depths.split(',').map(Number);

const input = flags.input ?? latestResultsFile(join(ROOT, 'results'));
if (!existsSync(input)) {
   console.error(`Input not found: ${input}`);
   process.exit(1);
}
ensureHeader(input);

// Per-model measured max ctx from the maxctx rows (used to start the server and
// to drop depths that wouldn't fit).
const maxctxByModel = new Map();
for (const r of readTable(input)) {
   if (r.bench === 'maxctx' && Number.isFinite(parseFloat(r.score))) maxctxByModel.set(r.model, parseFloat(r.score));
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
   if (!n) return null;
   return n % 2 ? s[(n - 1) / 2] : (s[n / 2 - 1] + s[n / 2]) / 2;
};

/**
 * One real request at `depth` prompt tokens generating exactly GEN tokens.
 * Returns the server-side timings broken into the numbers we report.
 */
async function measureOnce(depth) {
   const built = makeFillPrompt(depth);
   const um = built.messages[built.messages.length - 1];
   // Unique nonce → fresh full prefill (defeat the KV prefix cache).
   um.content = `// throughput probe ${++nonce}\n${um.content}`;
   const { timings } = await client.chat(
      built.messages,
      { think: null, max_tokens: GEN, temperature: 0.0, ignore_eos: true },
      900_000,
   );
   const pn = timings?.prompt_n;
   const pm = timings?.prompt_ms;
   const gn = timings?.predicted_n;
   const gm = timings?.predicted_ms;
   if (![pn, pm, gn, gm].every(Number.isFinite) || pm + gm <= 0) {
      throw new Error('incomplete timings');
   }
   return {
      ttftMs: pm,
      e2eTps: ((pn + gn) / (pm + gm)) * 1000,
      decodeTps: timings.predicted_per_second ?? gn / (gm / 1000),
      prefillTps: timings.prompt_per_second ?? pn / (pm / 1000),
      genTokens: gn,
   };
}

console.log(`\n[throughput-ttft] ${wanted.length} models · depths [${DEPTHS.join(', ')}] · gen ${GEN} · reps ${REPS} · ${LLAMA_URL}\n`);
for (const m of wanted) {
   const id = m.hf_file.replace(/\.gguf$/, '');
   const maxctx = maxctxByModel.get(id);
   if (!maxctx) {
      console.log(`  ${id}: no maxctx in CSV — skipping`);
      continue;
   }
   const depths = DEPTHS.filter((d) => d + GEN + 512 < maxctx);
   if (!depths.length) {
      console.log(`  ${id}: maxctx ${maxctx} too small for any depth — skipping`);
      continue;
   }
   console.log(`\n══ ${m.label ?? id}  (ctx ${maxctx.toLocaleString()}, depths ${depths.map((d) => Math.round(d / 1024) + 'k').join(',')})`);
   await srv.killAll();
   await srv.waitVramClear(30_000);
   try {
      await srv.startServer({ hf_repo: m.hf_repo, hf_file: m.hf_file, ctx: maxctx, extraFlags: extraFlagsToString(m.extra_flags) });
      await srv.waitHealthy(360_000);
   } catch (e) {
      console.log(`  load failed: ${e.message.slice(0, 80)} — skipping`);
      continue;
   }
   const vram = await srv.snapshotVram();
   for (const d of depths) {
      const samples = [];
      for (let r = 0; r < REPS; r++) {
         try {
            samples.push(await measureOnce(d));
         } catch (e) {
            console.log(`  depth ${Math.round(d / 1024)}k rep ${r}: error ${e.message.slice(0, 50)}`);
         }
      }
      if (!samples.length) {
         continue;
      }
      const e2e = median(samples.map((s) => s.e2eTps));
      const ttft = median(samples.map((s) => s.ttftMs));
      const decode = median(samples.map((s) => s.decodeTps));
      const prefill = median(samples.map((s) => s.prefillTps));
      const kLabel = `${Math.round(d / 1024)}k`;
      console.log(
         `  depth ${kLabel.padStart(4)}: e2e ${e2e.toFixed(1).padStart(6)} tok/s` +
            `  TTFT ${(ttft / 1000).toFixed(2)}s  (decode ${decode.toFixed(0)} · prefill ${prefill.toFixed(0)} t/s · n=${samples.length})`,
      );
      appendRow(input, {
         target: flags.target,
         backend: BACKEND,
         model: id,
         think: 'n/a',
         bench: `e2e-${kLabel}`,
         score: e2e.toFixed(1),
         tok_s: decode.toFixed(1),
         prefill_tps: prefill.toFixed(1),
         vram_mib: vram ?? '?',
         ctx_loaded: maxctx,
         status: 'ok',
         notes: `e2e@${d} gen${GEN} n=${samples.length}`,
      });
      appendRow(input, {
         target: flags.target,
         backend: BACKEND,
         model: id,
         think: 'n/a',
         bench: `ttft-${kLabel}`,
         score: ttft.toFixed(0),
         vram_mib: vram ?? '?',
         ctx_loaded: maxctx,
         status: 'ok',
         notes: `prompt_ms@${d} n=${samples.length}`,
      });
   }
}
await srv.stopServer();
await srv.waitVramClear(20_000);
console.log(`\n[throughput-ttft] done → rows appended to ${input}`);
