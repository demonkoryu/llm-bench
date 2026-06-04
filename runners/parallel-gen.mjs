#!/usr/bin/env node
/**
 * Parallel-generation throughput — how decode scales with concurrent slots.
 *
 * `--parallel N` lets llama-server batch the decode step across N sequences, so
 * aggregate tok/s (summed over slots) typically rises sublinearly with N before
 * plateauing. This is what decides how many agent slots one model can usefully
 * serve at once. Starts each model with --parallel 8 and fires K = 1/2/4/8
 * concurrent generations, measuring aggregate throughput = Σ tokens ÷ wall time.
 *
 * Writes speed_pargen-<K> rows (aggregate tok/s) for scoring.
 *
 * Usage: node runners/parallel-gen.mjs [--input results/<csv>] [--models a,b] [--conc 1,2,4,8]
 */

import { existsSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseArgs } from 'node:util';
import { appendRow, ensureHeader, latestResultsFile } from '../shared/results-csv.mjs';
import { extraFlagsToString, llamacppServer } from './llamacpp-server.mjs';
import { loadModelsConfig } from '../shared/models-config.mjs';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const { values: flags } = parseArgs({
   options: {
      input: { type: 'string' },
      models: { type: 'string', default: '' },
      conc: { type: 'string', default: '1,2,4,8' },
      target: { type: 'string', default: 'rose' },
      gen: { type: 'string', default: '256' },
   },
});

const yaml = (await import('js-yaml')).default;
const modelsCfg = loadModelsConfig(join(ROOT, 'config/models.yaml'));
const hostsCfg = yaml.load(readFileSync(join(ROOT, 'config/hosts.yaml'), 'utf8'));
const host = hostsCfg[flags.target];
const resolve = (s) => String(s ?? '').replace(/\$\{([^}]+)\}/g, (_, e) => process.env[e.split(':-')[0]] ?? e.split(':-')[1] ?? '');
const LLAMA_URL = resolve(host.llamacpp);
const SSH_HOST = resolve(host.ssh_host);
const BACKEND = 'vulkan';
const GEN = Number(flags.gen);
const CONC = flags.conc.split(',').map(Number);
const MAXP = Math.max(...CONC);

const input = flags.input ?? latestResultsFile(join(ROOT, 'results'));
if (!existsSync(input)) {
   console.error(`Input not found: ${input}`);
   process.exit(1);
}
ensureHeader(input);

const filter = flags.models ? flags.models.split(',').map((s) => s.trim()) : [];
const wanted = modelsCfg.models.filter((m) => {
   const id = m.hf_file.replace(/\.gguf$/, '');
   return !filter.length || filter.some((f) => id.includes(f) || (m.label ?? '').includes(f));
});

const srv = llamacppServer({ sshHost: SSH_HOST, llamaUrl: LLAMA_URL, backend: BACKEND, debug: !!process.env.BENCH_DEBUG });
const client = srv.client;
// Wall-clock timestamp helper (Date.now is fine here — plain node, not a workflow).
const now = () => Date.now();
const PROMPTS = [
   'Write a detailed technical essay about the history of computing.',
   'Explain how transformers work, step by step, in depth.',
   'Describe the design of a distributed key-value store.',
   'Walk through building a compiler front-end in detail.',
];

console.log(`\n[parallel-gen] ${wanted.length} models · concurrency [${CONC.join(', ')}] · gen ${GEN} · --parallel ${MAXP} · ${LLAMA_URL}\n`);
for (const m of wanted) {
   const id = m.hf_file.replace(/\.gguf$/, '');
   console.log(`\n══ ${m.label ?? id}`);
   await srv.killAll();
   await srv.waitVramClear(30_000);
   try {
      // Modest ctx; with --parallel MAXP the default split gives ctx/MAXP per slot,
      // ample for a ${GEN}-token generation. extra_flags carries gemma --no-mmproj.
      const extra = `--parallel ${MAXP} ${extraFlagsToString(m.extra_flags)}`.trim();
      await srv.startServer({ hf_repo: m.hf_repo, hf_file: m.hf_file, ctx: 16384, extraFlags: extra });
      await srv.waitHealthy(360_000);
   } catch (e) {
      console.log(`  load failed: ${e.message.slice(0, 80)} — skipping`);
      continue;
   }
   const vram = await srv.snapshotVram();
   let base = null;
   for (const k of CONC) {
      const t0 = now();
      const reqs = Array.from({ length: k }, (_, i) =>
         client
            .chat([{ role: 'user', content: `(${i}-${t0}) ${PROMPTS[i % PROMPTS.length]}` }], { think: null, max_tokens: GEN, temperature: 0.7 }, 300_000)
            .then((r) => r.completion?.usage?.completion_tokens ?? 0)
            .catch(() => 0),
      );
      const toks = await Promise.all(reqs);
      const wallS = (now() - t0) / 1000;
      const total = toks.reduce((s, t) => s + t, 0);
      const aggTps = total / wallS;
      const perSlot = aggTps / k;
      if (k === 1) base = aggTps;
      const speedup = base ? (aggTps / base).toFixed(2) : '?';
      console.log(`  K=${String(k).padStart(2)}: agg ${aggTps.toFixed(0).padStart(5)} tok/s  (${perSlot.toFixed(0)}/slot · ${speedup}× vs K=1)  [${total} toks / ${wallS.toFixed(1)}s]`);
      appendRow(input, {
         target: flags.target,
         backend: BACKEND,
         model: id,
         think: 'n/a',
         bench: `speed_pargen-${k}`,
         score: aggTps.toFixed(1),
         tok_s: aggTps.toFixed(1),
         vram_mib: vram ?? '?',
         ctx_loaded: 16384,
         status: 'ok',
         notes: `parallel=${MAXP} conc=${k} per_slot=${perSlot.toFixed(1)}`,
      });
   }
}
await srv.stopServer();
await srv.waitVramClear(20_000);
console.log(`\n[parallel-gen] done → rows appended to ${input}`);
