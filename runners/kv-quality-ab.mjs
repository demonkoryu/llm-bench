#!/usr/bin/env node
/**
 * kv-quality-ab.mjs — does q4_0 KV cache hurt ANSWER QUALITY, and for which models?
 *
 * Production runs symmetric `q8_0` KV fleet-wide (it's what fits long contexts in
 * 20 GiB). q4_0 KV would roughly halve KV memory again — bigger ctx, or headroom
 * for a larger model — but only if the quality hit is tolerable. The existing
 * `kv-quant-sweep.mjs` answers the SPEED half (decode t/s f16→q8→q4); this answers
 * the QUALITY half, which the literature only ever measures on CUDA/HIP, never
 * Vulkan/RDNA3.
 *
 * Method (reuses quality-decay's needle-at-depth harness):
 *   - At each depth we plant the same 6 fixed needle questions (retrieval +
 *     arithmetic) and grade integer-answer accuracy; only the surrounding filler
 *     grows. Greedy (temp 0) so the run is deterministic.
 *   - KV-quant error ACCUMULATES over context, so the signal lives at depth, not at
 *     depth 0. We report accuracy at each depth for three KV states:
 *       q8_0       — production baseline (K high / V high)
 *       q4_0       — symmetric low (the aggressive VRAM play)
 *       q8_0/q4_0  — asymmetric, K-high / V-low (the "sweet spot": K is the
 *                    sensitive cache, so keeping K at q8 should recover most quality
 *                    while still cutting V to q4)
 *   - The decision metric is the per-model accuracy DELTA q4 (and asym) minus q8 at
 *     the deepest shared depth. "Doesn't regress much" = small negative (or zero).
 *
 * KV type is a server-launch flag, so each (model, state) is a fresh load. q8_0 is
 * the highest-VRAM state of the three — if it loads, q4 and asym load too. On a load
 * failure (OOM at the requested ctx) the cell is skipped, not fatal.
 *
 * Override lands because start-server.sh emits its `--cache-type-k q8_0
 * --cache-type-v q8_0` default BEFORE appending extra_flags, and llama.cpp takes the
 * last occurrence of a scalar flag.
 *
 * Usage:
 *   node runners/kv-quality-ab.mjs                       # default 4-model subset
 *   node runners/kv-quality-ab.mjs --models gemma-4-12b,LFM2.5 --ctx 32768
 *   node runners/kv-quality-ab.mjs --depths 0,12288,24576,40960 --reps 1
 *
 * Run with NO llama-server already running (VRAM conflict).
 */

import { writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseArgs } from 'node:util';
import { loadHostConfig } from '../shared/hosts-config.mjs';
import { loadModelsConfig } from '../shared/models-config.mjs';
import { extraFlagsToString, llamacppServer } from './llamacpp-server.mjs';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const { values: flags } = parseArgs({
   options: {
      models: { type: 'string', default: '' },
      ctx: { type: 'string', default: '49152' },
      depths: { type: 'string', default: '0,12288,24576,40960' },
      reps: { type: 'string', default: '1' },
      target: { type: 'string', default: 'rose' },
      out: { type: 'string', default: join(ROOT, 'results', 'kv-quality-ab.json') },
   },
});

const modelsCfg = loadModelsConfig(join(ROOT, 'config/models.yaml'));
const {
   llamaUrl: LLAMA_URL,
   sshHost: SSH_HOST,
   backend: BACKEND,
   gpu: GPU,
} = loadHostConfig(join(ROOT, 'config/hosts.yaml'), flags.target);

const CTX = Number(flags.ctx);
const DEPTHS = flags.depths.split(',').map(Number);
const REPS = Number(flags.reps);
const CHARS_PER_TOKEN = 2.8;

// The three KV states. q8_0 first so its VRAM (the highest) gates the cell — if it
// OOMs at this ctx, q4/asym would have loaded but the comparison is moot, so skip.
const KV_STATES = [
   { label: 'q8_0', ctk: 'q8_0', ctv: 'q8_0' }, // production baseline
   { label: 'q4_0', ctk: 'q4_0', ctv: 'q4_0' }, // symmetric low
   { label: 'q8_0/q4_0', ctk: 'q8_0', ctv: 'q4_0' }, // asym: K high / V low
];
const BASELINE = 'q8_0';

// Representative subset: one big MoE (q4 weights), one IQ4 MoE (+MTP), one dense
// mid-size, and a long-CoT reasoner (worst case for KV-quant — error compounds over
// a long reasoning trace). Substring-matched against label OR hf_file.
const DEFAULT_SUBSET = ['Qwen3-30B-2507 Q4_K_XL', 'Qwen3.6-35B IQ4_XS', 'Gemma4-12B Q5_K_M', 'LFM2.5-8B Q5_K_M'];
const filters = (flags.models ? flags.models.split(',') : DEFAULT_SUBSET).map((s) => s.trim()).filter(Boolean);

const wanted = modelsCfg.models.filter((m) => {
   const id = m.hf_file.replace(/\.gguf$/, '');
   return filters.some((f) => id.toLowerCase().includes(f.toLowerCase()) || (m.label ?? '').toLowerCase().includes(f.toLowerCase()));
});
if (!wanted.length) {
   console.error(`No models matched: ${filters.join(', ')}`);
   process.exit(1);
}

const { buildCodebase, buildQuestionBlock } = await import('../shared/codebase.mjs');
const srv = llamacppServer({ sshHost: SSH_HOST, llamaUrl: LLAMA_URL, backend: BACKEND, debug: !!process.env.BENCH_DEBUG });
const client = srv.client;

/** Grade the 6-question block: count integer answers matching planted probe values. */
function grade(text, probes) {
   let correct = 0;
   const ints = text.match(/-?\d+/g) ?? [];
   for (let i = 0; i < probes.length; i++) {
      const m = new RegExp(`A${i + 1}\\s*[:=]\\s*(-?\\d+)`, 'i').exec(text);
      const got = m ? m[1] : (ints[i] ?? null);
      if (got != null && String(got) === String(probes[i].answer)) {
         correct++;
      }
   }
   return (correct / probes.length) * 100;
}

const mean = (a) => (a.length ? a.reduce((s, x) => s + x, 0) / a.length : null);

/** Build extra_flags for a (model, KV state): model's own flags + KV override. */
function flagsFor(model, state) {
   const base = extraFlagsToString(model.extra_flags); // e.g. MTP for Qwen3.6
   return `${base} --cache-type-k ${state.ctk} --cache-type-v ${state.ctv}`.trim();
}

/** One needle measurement at a depth; returns accuracy % (mean of reps) or null. */
async function measureDepth(depth, maxTokens, think, thinkControl) {
   const targetChars = Math.max(3000, Math.floor(depth * CHARS_PER_TOKEN * 0.82));
   const accs = [];
   for (let rep = 0; rep < REPS; rep++) {
      const [codeText, probes] = buildCodebase(targetChars);
      const messages = [
         {
            role: 'system',
            content: 'You are a code analyzer. Answer each question using only the code above. Each answer is a single integer.',
         },
         { role: 'user', content: `${codeText}\n\n${buildQuestionBlock(probes)}` },
      ];
      try {
         const { completion } = await client.chat(messages, { think, thinkControl, max_tokens: maxTokens, temperature: 0.0 }, 900_000);
         accs.push(grade(completion?.choices?.[0]?.message?.content ?? '', probes));
      } catch (e) {
         console.log(`      depth ${depth} rep ${rep}: error ${e.message.slice(0, 60)}`);
      }
   }
   return mean(accs);
}

// A fixed sustained-generation prompt for the decode-speed probe — long enough to
// force steady-state token generation so predicted_per_second is a clean decode
// number (not dominated by a few tokens). Short context (no depth) isolates the
// KV-quant effect on the decode kernel itself.
const BURST_PROMPT =
   'Write a detailed, multi-paragraph technical explanation of how a modern CPU cache hierarchy works: L1/L2/L3, cache lines, associativity, write-back vs write-through, and coherence protocols. Be thorough.';

// Discard this many warmup bursts before measuring. A freshly (re)loaded server
// starts from idle GPU clocks, and the ramp outlasts a single short generation —
// the warmup-confound rule (results/int-dot-impact.md). One warmup left the FIRST
// state of each model reading low and faked a +32% q4 "win"; multiple warmups pin
// the clock to steady state so the q8/q4/asym deltas are real, not ramp.
const BURST_WARMUPS = 3;

/** Decode-speed probe for the loaded server: N warmups (discarded) + measured mean
 *  of 2 256-token bursts. Returns server-reported decode t/s (predicted_per_second),
 *  production-faithful — WITH the model's real flags, so MTP rides along. */
async function decodeBurst() {
   const msgs = [{ role: 'user', content: BURST_PROMPT }];
   const opts = { think: null, max_tokens: 256, temperature: 0.0 };
   try {
      for (let i = 0; i < BURST_WARMUPS; i++) {
         await client.chat(msgs, opts, 300_000); // warmup — ramp clocks, discarded
      }
      const tps = [];
      for (let i = 0; i < 2; i++) {
         const { timings } = await client.chat(msgs, opts, 300_000);
         if (timings?.predicted_per_second) {
            tps.push(timings.predicted_per_second);
         }
      }
      return mean(tps);
   } catch (e) {
      console.log(`     decode burst error: ${e.message.slice(0, 60)}`);
      return null;
   }
}

async function main() {
   console.log(
      `\n[kv-quality-ab] ${wanted.length} models · states ${KV_STATES.map((s) => s.label).join(', ')} · ctx ${CTX} · depths [${DEPTHS.join(', ')}] · reps ${REPS}`,
   );
   console.log(`host ${LLAMA_URL} · per state: VRAM@load + decode burst + quality needles/depth · greedy/temp0\n`);

   const report = {
      host: SSH_HOST,
      backend: BACKEND,
      gpu: GPU,
      ctx: CTX,
      depths: DEPTHS,
      reps: REPS,
      states: KV_STATES.map((s) => s.label),
      baseline: BASELINE,
      models: [],
   };

   for (const m of wanted) {
      const id = m.hf_file.replace(/\.gguf$/, '');
      const depths = DEPTHS.filter((d) => d + 512 < CTX);
      // Disable thinking on hybrids (think:optional) so the 6 answers land in budget;
      // always-reasoning models (LFM2.5 reasoning / required) keep thinking but get a
      // big budget so reasoning_content doesn't starve the answer. Mirrors quality-decay.
      const think = m.think === 'optional' ? false : null;
      const thinkControl = m.think_control ?? 'enable_thinking';
      const reasons = m.think === 'reasoning' || m.think === 'required';
      const maxTokens = reasons ? 8192 : 512;

      console.log(
         `\n══ ${m.label ?? id}  (ctx ${CTX.toLocaleString()}, depths ${depths.map((d) => `${Math.round(d / 1024)}k`).join(',')})`,
      );
      const entry = { label: m.label ?? id, hf_file: m.hf_file, byState: {} };

      for (const state of KV_STATES) {
         const extraFlags = flagsFor(m, state);
         console.log(`   · KV ${state.label}  (${extraFlags})`);
         await srv.killAll();
         await srv.waitVramClear(30_000);
         try {
            await srv.startServer({ hf_repo: m.hf_repo, hf_file: m.hf_file, ctx: CTX, extraFlags });
            await srv.waitHealthy(360_000);
         } catch (e) {
            console.log(`     load FAILED: ${e.message.slice(0, 90)} — skipping state`);
            entry.byState[state.label] = { error: e.message.slice(0, 120) };
            continue;
         }
         // VRAM at load (weights + full KV cache, allocated up-front at this ctx) —
         // the q8_0 vs q4_0 delta at identical ctx is the KV memory saving.
         const vramMib = await srv.snapshotVram();
         // Decode speed (short ctx, warmup discarded).
         const decodeTps = await decodeBurst();
         console.log(`     vram ${vramMib ?? '?'} MiB · decode ${decodeTps ? `${decodeTps.toFixed(1)} t/s` : '?'}`);
         // Quality: warmup (discarded) at depth 0, then measured depths.
         await measureDepth(0, maxTokens, think, thinkControl);
         const byDepth = {};
         for (const d of depths) {
            const acc = await measureDepth(d, maxTokens, think, thinkControl);
            byDepth[d] = acc;
            console.log(`     depth ${String(`${Math.round(d / 1024)}k`).padStart(4)}: ${acc == null ? '??' : `${acc.toFixed(0)}%`}`);
         }
         entry.byState[state.label] = { vramMib, decodeTps, depths: byDepth };
      }
      report.models.push(entry);
      writeReport(report); // incremental — survive a mid-run crash
   }

   await srv.killAll();
   await srv.waitVramClear(20_000);
   writeReport(report);
   console.log(`\n[kv-quality-ab] done → ${flags.out}`);
}

const acc = (st, d) => (st && !st.error && typeof st.depths?.[d] === 'number' ? st.depths[d] : null);

function deepestShared(entry) {
   // deepest depth where the baseline state has a numeric accuracy
   const b = entry.byState[BASELINE];
   if (!b || b.error) {
      return null;
   }
   const ds = DEPTHS.filter((d) => typeof b.depths?.[d] === 'number');
   return ds.length ? ds[ds.length - 1] : null;
}

function renderMarkdown(report) {
   const L = [];
   const num = (x, suffix = '') => (typeof x === 'number' ? `${x.toFixed(suffix === '%' ? 1 : 0)}${suffix}` : '—');
   const signed = (x, suffix = '') => (typeof x === 'number' ? `${x >= 0 ? '+' : ''}${x.toFixed(suffix === '%' ? 1 : 0)}${suffix}` : '—');

   L.push('# KV-cache q4 vs q8 — quality · speed · VRAM (Vulkan / RDNA3)');
   L.push('');
   L.push(
      `Host \`${report.host}\` · backend \`${report.backend}\` · ${report.gpu} · ctx ${report.ctx.toLocaleString()} · greedy (temp 0) · ${report.reps} rep(s). ` +
         'All three axes measured under one load per (model, KV state): **VRAM** at load (weights + full KV at this ctx), ' +
         '**decode t/s** from a warmup-discarded 256-token burst (production flags, so MTP is included where it applies), ' +
         'and **quality** = % of 6 planted integer needles correct at each context depth.',
   );
   L.push('');
   L.push(
      '> q4_0 KV roughly halves KV bytes/token vs q8_0 → the VRAM delta is the headroom you buy. KV-quant *quality* error accumulates with context, so the regression is read at the deepest depth, not depth 0. `q8_0/q4_0` is the **asymmetric** state (K high / V low): K is the sensitive cache, so it should recover most of what symmetric `q4_0` loses while keeping ~75% of the V saving.',
   );
   L.push('');
   // ── Headline: the three deltas vs q8_0, per model ──────────────────────────
   L.push('## Headline — q4 / asym vs q8_0 (Δ on each axis)');
   L.push('');
   L.push(
      'Quality Δ in accuracy points at the deepest shared depth; speed Δ and VRAM Δ as % change. Negative VRAM = memory saved (good); positive speed = faster.',
   );
   L.push('');
   L.push('| model | depth | Δqual q4 | Δqual asym | Δspeed q4 | Δspeed asym | ΔVRAM q4 | ΔVRAM asym |');
   L.push('| :--- | ---: | ---: | ---: | ---: | ---: | ---: | ---: |');
   for (const m of report.models) {
      const dd = deepestShared(m);
      const b = m.byState[BASELINE];
      const q4 = m.byState.q4_0;
      const as = m.byState['q8_0/q4_0'];
      const dQual = (st) => (dd != null && acc(st, dd) != null && acc(b, dd) != null ? acc(st, dd) - acc(b, dd) : null);
      const dPct = (st, key) =>
         st && !st.error && typeof st[key] === 'number' && typeof b?.[key] === 'number' && b[key]
            ? ((st[key] - b[key]) / b[key]) * 100
            : null;
      L.push(
         `| ${m.label} | ${dd != null ? `${Math.round(dd / 1024)}k` : '—'} | ${signed(dQual(q4))} | ${signed(dQual(as))} | ${signed(dPct(q4, 'decodeTps'), '%')} | ${signed(dPct(as, 'decodeTps'), '%')} | ${signed(dPct(q4, 'vramMib'), '%')} | ${signed(dPct(as, 'vramMib'), '%')} |`,
      );
   }
   L.push('');
   // ── Per-model detail: VRAM + decode + quality curve, rows = KV state ────────
   for (const m of report.models) {
      L.push(`## ${m.label}`);
      L.push('');
      const ds = report.depths;
      const head = ['KV state', 'VRAM MiB', 'decode t/s', ...ds.map((d) => `acc ${Math.round(d / 1024)}k`)];
      L.push(`| ${head.join(' | ')} |`);
      L.push(`| :--- | ${['---:', '---:', ...ds.map(() => '---:')].join(' | ')} |`);
      for (const s of report.states) {
         const st = m.byState[s];
         if (st?.error) {
            L.push(`| ${s} | <span title="${st.error}">err</span> | — | ${ds.map(() => '—').join(' | ')} |`);
            continue;
         }
         const cells = ds.map((d) => (acc(st, d) != null ? `${acc(st, d).toFixed(0)}%` : '—'));
         L.push(`| ${s === report.baseline ? `**${s}**` : s} | ${num(st?.vramMib)} | ${num(st?.decodeTps)} | ${cells.join(' | ')} |`);
      }
      L.push('');
   }
   return L.join('\n');
}

function writeReport(report) {
   writeFileSync(flags.out, JSON.stringify(report, null, 2));
   writeFileSync(flags.out.replace(/\.json$/, '.md'), renderMarkdown(report));
}

main().catch((e) => {
   console.error(e);
   process.exit(1);
});
