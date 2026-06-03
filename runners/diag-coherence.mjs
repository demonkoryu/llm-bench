#!/usr/bin/env node
/**
 * Coherence-probe diagnostic.
 *
 * The max-ctx binary search calls checkCoherence() with a SINGLE needle, ONE
 * sample, and a different codebase at every ctx size — so a single retrieval
 * miss collapses the whole context size to "incoherent" and the search cuts
 * there. This tool isolates whether a low coherence ceiling is the MODEL or the
 * PROBE: it loads the model once at a high ctx, then asks ALL 6 needles (across
 * depths 8%→90%) at several fill sizes and reports per-depth retrieval accuracy.
 *
 * Usage:
 *   node runners/diag-coherence.mjs --repo unsloth/gemma-4-12b-it-GGUF \
 *        --file gemma-4-12b-it-Q5_K_M.gguf --ctx 131072 --fills 40000,64000,96000,120000
 */

import { parseArgs } from 'node:util';
import { llamacppServer } from './llamacpp-server.mjs';
import { buildCodebase, buildQuestionBlock } from '../shared/codebase.mjs';

const { values: f } = parseArgs({
   options: {
      repo: { type: 'string', default: 'unsloth/gemma-4-12b-it-GGUF' },
      file: { type: 'string', default: 'gemma-4-12b-it-Q5_K_M.gguf' },
      ctx: { type: 'string', default: '131072' },
      fills: { type: 'string', default: '40000,64000,96000,120000' },
      think: { type: 'string', default: 'false' }, // false | null | true
   },
});

const CTX = Number(f.ctx);
const FILLS = f.fills.split(',').map((s) => Number(s.trim()));
const THINK = f.think === 'true' ? true : f.think === 'null' ? null : false;
const CHARS_PER_TOKEN = 2.8; // matches shared/codebase.mjs

const LLAMA_URL = process.env.LLAMA_URL ?? 'http://192.168.1.120:8090';
const SSH_HOST = process.env.SSH_HOST ?? 'llm2';

const srv = llamacppServer({ sshHost: SSH_HOST, llamaUrl: LLAMA_URL, backend: 'vulkan', debug: !!process.env.BENCH_DEBUG });

/** Pull "A<n>: <int>" answers out of the model output; fall back to nth integer. */
function parseAnswers(text, n) {
   const out = [];
   for (let i = 1; i <= n; i++) {
      const m = new RegExp(`A${i}\\s*[:=]\\s*(-?\\d+)`, 'i').exec(text);
      out.push(m ? m[1] : null);
   }
   // Fallback: if the model ignored the A<n>: format, grab integers in order.
   if (out.every((x) => x === null)) {
      const ints = text.match(/-?\d+/g) ?? [];
      for (let i = 0; i < n; i++) out[i] = ints[i] ?? null;
   }
   return out;
}

console.log(`\n[diag-coherence] ${f.file}  ctx=${CTX}  think=${THINK}  fills=[${FILLS.join(', ')}]\n`);

await srv.killAll();
await srv.waitVramClear(30_000);
await srv.startServer({ hf_repo: f.repo, hf_file: f.file, ctx: CTX });
await srv.waitHealthy(360_000);
const vram = await srv.snapshotVram();
console.log(`[diag-coherence] loaded at ctx=${CTX}  vram=${vram ?? '?'}MiB\n`);

const rows = [];
try {
   for (const fill of FILLS) {
      const targetChars = Math.floor(fill * CHARS_PER_TOKEN * 0.9);
      const [codeText, probes] = buildCodebase(targetChars);
      const qBlock = buildQuestionBlock(probes);
      const messages = [
         { role: 'system', content: 'You are a code analyzer. Answer questions about the provided code using only the code given.' },
         { role: 'user', content: `${codeText}\n\n${qBlock}` },
      ];

      let text = '';
      let err = null;
      try {
         // Large prefills (96k–120k tokens) take several minutes on this GPU —
         // generous client timeout so we measure retrieval, not a client abort.
         const { completion } = await srv.client.chat(messages, { think: THINK, temperature: 0.0, max_tokens: 512 }, 900_000);
         text = completion?.choices?.[0]?.message?.content ?? '';
      } catch (e) {
         err = e.message;
      }

      if (err) {
         console.log(`fill≈${fill}t: REQUEST ERROR — ${err}`);
         rows.push({ fill, pass: 0, total: probes.length, err });
         continue;
      }

      const got = parseAnswers(text, probes.length);
      let pass = 0;
      const perDepth = probes.map((p, i) => {
         const ok = got[i] != null && String(got[i]) === String(p.answer);
         if (ok) pass++;
         return `${Math.round(p.depth * 100)}%:${ok ? '✓' : `✗(${got[i] ?? '∅'}≠${p.answer})`}`;
      });
      console.log(`fill≈${fill}t  ${pass}/${probes.length} correct   ${perDepth.join('  ')}`);
      rows.push({ fill, pass, total: probes.length });
   }
} finally {
   await srv.stopServer();
   await srv.waitVramClear(20_000);
}

console.log('\n[diag-coherence] summary');
for (const r of rows) {
   console.log(`  fill≈${r.fill}t: ${r.err ? `ERROR (${r.err})` : `${r.pass}/${r.total}`}`);
}
const anyHigh = rows.find((r) => r.fill >= 64000 && !r.err && r.pass >= Math.ceil(r.total * 0.5));
console.log(
   anyHigh
      ? `\n⇒ Model retrieves at ≥64k (e.g. ${anyHigh.pass}/${anyHigh.total} at ${anyHigh.fill}t). The 43k ceiling is PROBE NOISE, not a model/VRAM limit.`
      : `\n⇒ Model genuinely degrades at long context — the low ceiling is real, not just probe noise.`,
);
