#!/usr/bin/env node
/**
 * Generation-speed degradation under context load.
 *
 * The speed bench measures decode tok/s with a tiny prompt (~0 context). But
 * decode slows as the KV cache fills (each new token attends to more keys), which
 * is what actually bites agentic loops as the conversation grows. This loads each
 * model at its measured max ctx and measures decode tok/s at increasing context
 * depths, writing speed_decay-<k>k rows so degradation can be scored.
 *
 * Reuses the model's known max ctx (from the input CSV) to start the server
 * directly — no slow binary search.
 *
 * Usage: node runners/speed-decay.mjs [--input results/<csv>] [--models a,b]
 */

import { existsSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseArgs } from 'node:util';
import { appendRow, ensureHeader, latestResultsFile, readTable } from '../shared/results-csv.mjs';
import { extraFlagsToString, llamacppServer } from './llamacpp-server.mjs';
import { loadModelsConfig } from '../shared/models-config.mjs';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const { values: flags } = parseArgs({
   options: {
      input: { type: 'string' },
      models: { type: 'string', default: '' },
      depths: { type: 'string', default: '16384,32768,65536,98304' },
      target: { type: 'string', default: 'rose' },
      gen: { type: 'string', default: '128' },
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
const DEPTHS = flags.depths.split(',').map(Number);

const input = flags.input ?? latestResultsFile(join(ROOT, 'results'));
if (!existsSync(input)) {
   console.error(`Input not found: ${input}`);
   process.exit(1);
}
ensureHeader(input);

// Per-model measured max ctx (and vram) from the maxctx rows.
const maxctxByModel = new Map();
for (const r of readTable(input)) {
   if (r.bench === 'maxctx' && Number.isFinite(parseFloat(r.score))) maxctxByModel.set(r.model, parseFloat(r.score));
}

const filter = flags.models ? flags.models.split(',').map((s) => s.trim()) : [];
const wanted = modelsCfg.models.filter((m) => {
   const id = m.hf_file.replace(/\.gguf$/, '');
   return !filter.length || filter.some((f) => id.includes(f) || (m.label ?? '').includes(f));
});

const srv = llamacppServer({ sshHost: SSH_HOST, llamaUrl: LLAMA_URL, backend: BACKEND, debug: !!process.env.BENCH_DEBUG });
const client = srv.client;
const SHORT = 'Tell me about the history and future of computing in detail.';
const { makeFillPrompt } = await import('../shared/codebase.mjs');
let nonce = 0;

/** Decode tok/s after prefilling `depth` tokens (depth 0 = tiny prompt). */
async function decodeAtDepth(depth) {
   let messages;
   if (depth === 0) {
      messages = [{ role: 'user', content: `(${++nonce}) ${SHORT}` }];
   } else {
      const built = makeFillPrompt(depth);
      const um = built.messages[built.messages.length - 1];
      um.content = `// decay ${++nonce}\n${um.content}`;
      messages = built.messages;
   }
   const { completion } = await client.chat(messages, { think: null, max_tokens: GEN, temperature: 0.0 }, 900_000);
   return { decode: client.tokPerSec(), prefill: client.prefillTokPerSec(), gen: completion?.usage?.completion_tokens ?? 0 };
}

console.log(`\n[speed-decay] ${wanted.length} models · depths [0, ${DEPTHS.join(', ')}] · gen ${GEN} · ${LLAMA_URL}\n`);
for (const m of wanted) {
   const id = m.hf_file.replace(/\.gguf$/, '');
   const maxctx = maxctxByModel.get(id);
   if (!maxctx) {
      console.log(`  ${id}: no maxctx in CSV — skipping`);
      continue;
   }
   const ctx = maxctx; // known to load (it's the coherence ceiling)
   const depths = [0, ...DEPTHS.filter((d) => d + GEN + 256 < maxctx)];
   console.log(`\n══ ${m.label ?? id}  (ctx ${ctx.toLocaleString()}, depths ${depths.map((d) => Math.round(d / 1024) + 'k').join(',')})`);
   await srv.killAll();
   await srv.waitVramClear(30_000);
   try {
      await srv.startServer({ hf_repo: m.hf_repo, hf_file: m.hf_file, ctx, extraFlags: extraFlagsToString(m.extra_flags) });
      await srv.waitHealthy(360_000);
   } catch (e) {
      console.log(`  load failed: ${e.message.slice(0, 80)} — skipping`);
      continue;
   }
   const vram = await srv.snapshotVram();
   let base = null;
   for (const d of depths) {
      let res;
      try {
         res = await decodeAtDepth(d);
      } catch (e) {
         console.log(`  depth ${d}: error ${e.message.slice(0, 60)}`);
         continue;
      }
      if (d === 0) base = res.decode;
      const pct = base ? ((res.decode / base) * 100).toFixed(0) : '?';
      console.log(`  depth ${String(Math.round(d / 1024) + 'k').padStart(4)}: decode ${res.decode?.toFixed(1).padStart(6)} tok/s  (${pct}% of base)  prefill ${res.prefill?.toFixed(0)} t/s`);
      appendRow(input, {
         target: flags.target,
         backend: BACKEND,
         model: id,
         think: 'n/a',
         bench: `speed_decay-${Math.round(d / 1024)}k`,
         score: res.decode?.toFixed(1) ?? '-',
         tok_s: res.decode?.toFixed(1) ?? '-',
         prefill_tps: res.prefill?.toFixed(1) ?? '-',
         vram_mib: vram ?? '?',
         ctx_loaded: ctx,
         status: 'ok',
         notes: `decode@${d}`,
      });
   }
}
await srv.stopServer();
await srv.waitVramClear(20_000);
console.log(`\n[speed-decay] done → rows appended to ${input}`);
