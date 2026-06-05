#!/usr/bin/env node
/**
 * Measure KV-cache VRAM growth per token — empirically, not from config.
 *
 * The fleet planner models VRAM(ctx) = weights + kv·ctx. The kv slope was
 * previously taken from config (kv_bytes_per_token), but those declared sizes are
 * estimates that don't reflect the actual on-device KV layout. This probes it
 * directly: load the server at two context sizes under identical production flags
 * and read board VRAM at each. llama.cpp allocates the FULL KV cache at load, so
 * no requests are needed — VRAM(ctx) is fixed once the server is healthy.
 *
 *   kv_per_token = (vram@cHigh - vram@cLow) / (cHigh - cLow)
 *
 * Compute/overhead buffers depend on ubatch (constant across the two loads), not
 * ctx, so they cancel in the delta — what remains is pure KV/token.
 *
 * cHigh defaults to each model's coherence-verified maxctx (read from the input
 * CSV) for the widest, cleanest signal; cLow is a small fixed ctx. Writes one
 * kv_per_tok row per model (value in KiB/token). The fleet analysis consumes
 * these with NO fallback — a model without a measured slope is omitted from the
 * packing tables rather than guessed.
 *
 * Usage: node runners/kv-probe.mjs [--input results/<csv>] [--models a,b] [--low 8192]
 */

import { existsSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseArgs } from 'node:util';
import { loadHostConfig } from '../shared/hosts-config.mjs';
import { loadModelsConfig } from '../shared/models-config.mjs';
import { aggregateModels, appendRow, ensureHeader, latestResultsFile, readTable } from '../shared/results-csv.mjs';
import { extraFlagsToString, llamacppServer } from './llamacpp-server.mjs';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const { values: flags } = parseArgs({
   options: {
      input: { type: 'string' },
      models: { type: 'string', default: '' },
      target: { type: 'string', default: 'rose' },
      low: { type: 'string', default: '8192' },
   },
});

const C_LOW = Number(flags.low);
const modelsCfg = loadModelsConfig(join(ROOT, 'config/models.yaml'));
const { llamaUrl: LLAMA_URL, sshHost: SSH_HOST } = loadHostConfig(join(ROOT, 'config/hosts.yaml'), flags.target);

const input = flags.input ?? latestResultsFile(join(ROOT, 'results'));
if (!existsSync(input)) {
   console.error(`Input not found: ${input}`);
   process.exit(1);
}
ensureHeader(input);

// maxctx (cHigh) + base_model come from the already-probed ladder rows in the CSV.
const { models: aggregated } = aggregateModels(readTable(input));
const maxctxByBase = new Map();
for (const m of aggregated) {
   if (m.maxctx != null) maxctxByBase.set(m.base_model, m.maxctx);
}

const filter = flags.models ? flags.models.split(',').map((s) => s.trim()) : [];
const wanted = modelsCfg.models.filter((m) => {
   const id = m.hf_file.replace(/\.gguf$/, '');
   return !filter.length || filter.some((f) => id.includes(f) || (m.label ?? '').includes(f));
});

const srv = llamacppServer({ sshHost: SSH_HOST, llamaUrl: LLAMA_URL, backend: 'vulkan', debug: !!process.env.BENCH_DEBUG });

/** Load at `ctx`, wait healthy, return board VRAM (MiB) with the full KV allocated. */
async function vramAtCtx(m, ctx) {
   await srv.killAll();
   await srv.waitVramClear(30_000);
   await srv.startServer({ hf_repo: m.hf_repo, hf_file: m.hf_file, ctx, extraFlags: extraFlagsToString(m.extra_flags) });
   await srv.waitHealthy(360_000);
   const vram = await srv.snapshotVram();
   return vram;
}

console.log(`\n[kv-probe] ${wanted.length} models · cLow=${C_LOW} · cHigh=maxctx · ${LLAMA_URL}\n`);
for (const m of wanted) {
   const id = m.hf_file.replace(/\.gguf$/, '');
   const cHigh = maxctxByBase.get(id);
   console.log(`\n══ ${m.label ?? id}`);
   if (cHigh == null) {
      console.log(`  no maxctx in CSV — run the ladder first; skipping`);
      continue;
   }
   if (cHigh <= C_LOW) {
      console.log(`  maxctx ${cHigh} ≤ cLow ${C_LOW} — gap too small to measure; skipping`);
      continue;
   }
   try {
      const vLow = await vramAtCtx(m, C_LOW);
      const vHigh = await vramAtCtx(m, cHigh);
      if (vLow == null || vHigh == null) {
         console.log(`  VRAM read failed (lo=${vLow} hi=${vHigh}) — skipping`);
         continue;
      }
      const kvPerTokMiB = (vHigh - vLow) / (cHigh - C_LOW);
      const kvKiB = kvPerTokMiB * 1024;
      console.log(`  lo ${C_LOW}=${vLow}MiB · hi ${cHigh}=${vHigh}MiB → ${kvKiB.toFixed(2)} KiB/token`);
      if (kvKiB <= 0) {
         console.log(`  non-positive slope — not physical, not recording`);
         continue;
      }
      appendRow(input, {
         target: flags.target,
         backend: 'vulkan',
         model: id,
         think: 'n/a',
         bench: 'kv_per_tok',
         score: kvKiB.toFixed(3),
         vram_mib: vHigh,
         ctx_loaded: cHigh,
         status: 'ok',
         notes: `lo=${C_LOW}:${vLow}MiB hi=${cHigh}:${vHigh}MiB`,
      });
   } catch (e) {
      console.log(`  probe failed: ${e.message.slice(0, 80)} — skipping`);
   }
}
await srv.stopServer();
await srv.waitVramClear(20_000);
console.log(`\n[kv-probe] done → rows appended to ${input}`);
