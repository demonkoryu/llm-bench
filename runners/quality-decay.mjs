#!/usr/bin/env node
/**
 * Quality degradation under context load + time-to-first-token (TTFT).
 *
 * speed-decay showed how fast decode stays under context; this shows whether the
 * model still ANSWERS CORRECTLY deep in context. At each depth it plants the same
 * 6 needle questions (retrieval + arithmetic, fixed seeds — identical across
 * depths, only the surrounding filler grows) and grades accuracy, so accuracy
 * retention = acc@depth ÷ acc@0 isolates context effect from baseline ability.
 * Also records prompt_ms (TTFT — prefill latency the agent feels) at each depth.
 *
 * Writes quality_decay-<k>k (accuracy %) and ttft-<k>k (ms) rows.
 *
 * Usage: node runners/quality-decay.mjs [--input results/<csv>] [--models a,b]
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
      depths: { type: 'string', default: '16384,32768,65536,98304' },
      target: { type: 'string', default: 'rose' },
   },
});

const modelsCfg = loadModelsConfig(join(ROOT, 'config/models.yaml'));
const { llamaUrl: LLAMA_URL, sshHost: SSH_HOST, backend: BACKEND } = loadHostConfig(join(ROOT, 'config/hosts.yaml'), flags.target);
const DEPTHS = flags.depths.split(',').map(Number);
const CHARS_PER_TOKEN = 2.8;

const input = flags.input ?? latestResultsFile(join(ROOT, 'results'));
if (!existsSync(input)) {
   console.error(`Input not found: ${input}`);
   process.exit(1);
}
ensureHeader(input);

const maxctxByModel = new Map();
for (const r of readTable(input)) {
   if (r.bench === 'maxctx' && Number.isFinite(parseFloat(r.score))) maxctxByModel.set(r.model, parseFloat(r.score));
}

const filter = flags.models ? flags.models.split(',').map((s) => s.trim()) : [];
const wanted = modelsCfg.models.filter((m) => {
   const id = m.hf_file.replace(/\.gguf$/, '');
   return !filter.length || filter.some((f) => id.includes(f) || (m.label ?? '').includes(f));
});

const { buildCodebase, buildQuestionBlock } = await import('../shared/codebase.mjs');
const srv = llamacppServer({ sshHost: SSH_HOST, llamaUrl: LLAMA_URL, backend: BACKEND, debug: !!process.env.BENCH_DEBUG });
const client = srv.client;

/** Grade the 6-question block: count answers matching the planted probe values. */
function grade(text, probes) {
   let correct = 0;
   const ints = text.match(/-?\d+/g) ?? [];
   for (let i = 0; i < probes.length; i++) {
      const m = new RegExp(`A${i + 1}\\s*[:=]\\s*(-?\\d+)`, 'i').exec(text);
      const got = m ? m[1] : (ints[i] ?? null);
      if (got != null && String(got) === String(probes[i].answer)) correct++;
   }
   return (correct / probes.length) * 100;
}

console.log(`\n[quality-decay] ${wanted.length} models · depths [0, ${DEPTHS.join(', ')}] · ${LLAMA_URL}\n`);
for (const m of wanted) {
   const id = m.hf_file.replace(/\.gguf$/, '');
   const maxctx = maxctxByModel.get(id);
   if (!maxctx) {
      console.log(`  ${id}: no maxctx — skipping`);
      continue;
   }
   const depths = [0, ...DEPTHS.filter((d) => d + 512 < maxctx)];
   // Disable thinking on hybrid models so the 6 answers land in `content` within
   // budget (think:null would default thinking ON → reasoning eats the budget → 0%).
   const probeThink = m.think === 'optional' ? false : null;
   const thinkControl = m.think_control ?? 'enable_thinking';
   console.log(`\n══ ${m.label ?? id}  (ctx ${maxctx.toLocaleString()}, depths ${depths.map((d) => Math.round(d / 1024) + 'k').join(',')})`);
   await srv.killAll();
   await srv.waitVramClear(30_000);
   try {
      await srv.startServer({ hf_repo: m.hf_repo, hf_file: m.hf_file, ctx: maxctx, extraFlags: extraFlagsToString(m.extra_flags) });
      await srv.waitHealthy(360_000);
   } catch (e) {
      console.log(`  load failed: ${e.message.slice(0, 70)} — skipping`);
      continue;
   }
   let base = null;
   for (const d of depths) {
      // targetChars grows the filler so the 6 fixed probes sit within a ~d-token
      // context; depth 0 = minimal context baseline.
      const targetChars = Math.max(3000, Math.floor(d * CHARS_PER_TOKEN * 0.82));
      const [codeText, probes] = buildCodebase(targetChars);
      const messages = [
         { role: 'system', content: 'You are a code analyzer. Answer each question using only the code above. Each answer is a single integer.' },
         { role: 'user', content: `${codeText}\n\n${buildQuestionBlock(probes)}` },
      ];
      let acc, ttft;
      try {
         const { completion, timings } = await client.chat(messages, { think: probeThink, thinkControl, max_tokens: 512, temperature: 0.0 }, 900_000);
         acc = grade(completion?.choices?.[0]?.message?.content ?? '', probes);
         ttft = timings?.prompt_ms ?? null;
      } catch (e) {
         console.log(`  depth ${d}: error ${e.message.slice(0, 60)}`);
         continue;
      }
      if (d === 0) base = acc;
      const ret = base ? `${((acc / base) * 100).toFixed(0)}%` : '?';
      console.log(`  depth ${String(Math.round(d / 1024) + 'k').padStart(4)}: accuracy ${acc.toFixed(0).padStart(3)}%  (ret ${ret})  TTFT ${ttft ? (ttft / 1000).toFixed(1) + 's' : '?'}`);
      appendRow(input, { target: flags.target, backend: BACKEND, model: id, think: 'n/a', bench: `quality_decay-${Math.round(d / 1024)}k`, score: acc.toFixed(1), vram_mib: '?', ctx_loaded: maxctx, status: 'ok', notes: `acc@${d}` });
      if (ttft != null)
         appendRow(input, { target: flags.target, backend: BACKEND, model: id, think: 'n/a', bench: `ttft-${Math.round(d / 1024)}k`, score: ttft.toFixed(0), vram_mib: '?', ctx_loaded: maxctx, status: 'ok', notes: `prompt_ms@${d}` });
   }
}
await srv.stopServer();
await srv.waitVramClear(20_000);
console.log(`\n[quality-decay] done → rows appended to ${input}`);
