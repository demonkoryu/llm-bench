#!/usr/bin/env node
/**
 * Fleet / VRAM-packing analysis for agentic multi-model setups.
 *
 * Each model has two VRAM data points — at ctx=16384 (speed re-run) and at its
 * coherence-verified max ctx — which pin a linear VRAM(ctx) model:
 *   VRAM(c) = weights + kv_per_token · c
 * From that this reports:
 *   1. Footprint at max ctx as a fraction of the card (how many fit).
 *   2. VRAM-per-ctx-token: gross (vram@maxctx / maxctx) and marginal KV/token.
 *   3. Best fleets: one high-quality anchor (maxctx > 100k) at full ctx, plus
 *      whatever distinct models fit in the remaining VRAM at a usable agentic ctx.
 *
 * Models are grouped by architecture (quant stripped); each identity keeps its
 * best-quality benchmarked variant, and a fleet never contains the same model twice.
 *
 * Emits text + results/fleet.svg + results/fleet.png.
 *
 * Usage: node runners/fleet-analysis.mjs [--input results/<csv>] [--sec-ctx 32768]
 */

import { existsSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseArgs } from 'node:util';
import { aggregateModels, latestResultsFile, readTable } from '../shared/results-csv.mjs';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const RESULTS_DIR = join(ROOT, 'results');
const { values: flags } = parseArgs({
   options: {
      input: { type: 'string' },
      output: { type: 'string', default: join(RESULTS_DIR, 'fleet.svg') },
      'sec-ctx': { type: 'string', default: '32768' },
      reserve: { type: 'string', default: '512' },
      anchor: { type: 'string', default: '100000' },
   },
});

const CARD_TOTAL_MIB = 20464; // RX 7900 XT usable (see config/hosts.yaml)
const RESERVE = Number(flags.reserve);
const BUDGET = CARD_TOTAL_MIB - RESERVE;

const input = flags.input ?? latestResultsFile(RESULTS_DIR);
if (!existsSync(input)) {
   console.error(`Input not found: ${input}`);
   process.exit(1);
}
const rows = readTable(input);
const { models } = aggregateModels(rows);

// VRAM used at ctx=16384 by a SINGLE sequence, captured by the speed re-run
// (ctx_loaded == 16384). speed_pargen rows allocate KV for up to 8 concurrent
// slots, so their VRAM is inflated and must NOT seed the single-slot baseline —
// otherwise the KV/token slope (vramMax - v16) can go negative.
const vram16k = new Map();
for (const r of rows) {
   const bench = String(r.bench);
   if (bench.startsWith('speed') && !bench.startsWith('speed_pargen') && Number(r.ctx_loaded) === 16384) {
      const v = parseFloat(r.vram_mib);
      if (Number.isFinite(v)) vram16k.set(r.model.replace(/--(nothi|think)$/, ''), v);
   }
}

// Architecture identity = base model with the quant suffix stripped.
const identityOf = (base) => base.replace(/(-UD)?-I?Q\d[\w.]*$/i, '');

// Collapse to one entry per architecture: keep the best-quality benchmarked quant.
const byIdent = new Map();
for (const m of models) {
   if (m.maxctx == null || m.maxctxVram == null) continue;
   const id = identityOf(m.base_model);
   const cur = byIdent.get(id);
   if (!cur || m.score > cur.score) {
      byIdent.set(id, { id, base: m.base_model, score: m.score, maxctx: m.maxctx, vramMax: m.maxctxVram });
   }
}

const fleet = [];
for (const e of byIdent.values()) {
   const v16 = vram16k.get(e.base);
   let kv = 0;
   let weights = e.vramMax;
   if (v16 != null && e.maxctx > 16384) {
      // A negative slope is never physical — it means the 16k baseline and the
      // maxctx VRAM were measured under different server configs (e.g. mixing
      // -ub 512 maxctx rows with -ub 2048 16k rows inflates v16 above vramMax).
      // Clamp to 0 so a stale/mixed dataset degrades to "no KV growth" rather
      // than emitting nonsense weights > vramMax.
      kv = Math.max(0, (e.vramMax - v16) / (e.maxctx - 16384));
      weights = e.vramMax - kv * e.maxctx;
   }
   fleet.push({
      ...e,
      kv,
      weights,
      vramAt: (c) => weights + kv * Math.min(c, e.maxctx),
      footprintPct: (e.vramMax / CARD_TOTAL_MIB) * 100,
      grossPerTok: (e.vramMax / e.maxctx) * 1024,
      kvPerTokKiB: kv * 1024,
   });
}
fleet.sort((a, b) => b.score - a.score);

const r0 = (x) => (x == null ? '?' : Math.round(x).toLocaleString());
const gb = (mib) => (mib / 1024).toFixed(1);

// ── 1 & 2: per-model footprint + efficiency (text) ───────────────────────────
const pad = (s, n) => String(s).padEnd(n);
console.log(`\nCard: ${CARD_TOTAL_MIB} MiB (${gb(CARD_TOTAL_MIB)} GB) usable\n`);
console.log(`${pad('model', 28)} ${pad('qual', 5)} ${pad('maxctx', 9)} ${pad('vram@max', 9)} ${pad('%card', 6)} ${pad('KV KiB/t', 9)} fit×`);
for (const m of fleet) {
   console.log(
      `${pad(m.id, 28)} ${pad(m.score, 5)} ${pad(r0(m.maxctx), 9)} ${pad(r0(m.vramMax) + 'M', 9)} ${pad(m.footprintPct.toFixed(0) + '%', 6)} ${pad(m.kvPerTokKiB.toFixed(1), 9)} ${(CARD_TOTAL_MIB / m.vramMax).toFixed(1)}`,
   );
}

// ── 3: best SINGLE-model setups — weights paid once, 2 slots (main + scratch) ──
// One weight load serves N concurrent sequences from a shared KV pool, so
// VRAM = weights + KV·(Σ slot tokens). Running two *different* models would pay
// the weight tax twice; instead run ONE model with a full-ctx main slot + a
// smaller scratchpad slot. Per-slot ctx is capped at the coherence ceiling.
//
// VERIFIED on b9496 (gemma-4-E4B, --parallel 2): the shared pool needs
// `--kv-unified` (-kvu) — WITHOUT it the default SPLITS the window (each slot
// gets -c/n_parallel), which would waste KV on an asymmetric main+scratch.
// `--parallel 2` also adds ~0.4–0.5 GB overhead beyond weights+KV; PARALLEL_OH
// reserves for it so the scratchpad estimate stays safe.
//   recipe: llama-server --hf-repo … -c <main+scratch> --parallel 2 --kv-unified --no-mmproj
const SCRATCH_MIN = 4096; // a scratchpad smaller than this isn't worth a slot
const PARALLEL_OH = 512; // MiB extra overhead for running 2 slots (measured ~0.45 GB)
const setups = fleet
   .map((m) => {
      const tokenBudget = m.kv > 0 ? (BUDGET - PARALLEL_OH - m.weights) / m.kv : Infinity; // total KV tokens that fit (2 slots)
      const main = m.maxctx; // the "1 max ctx" slot
      const leftover = Math.max(0, tokenBudget - main);
      const scratch = Math.min(m.maxctx, leftover); // 2nd slot, capped at coherence ceiling
      const fullSlots = m.kv > 0 ? Math.floor(tokenBudget / m.maxctx) : 99; // how many full-ctx slots fit
      const vramUsed = m.weights + m.kv * (main + scratch);
      return { ...m, tokenBudget, main, scratch, fullSlots, vramUsed };
   })
   .sort((a, b) => b.score - a.score);

console.log(`\nBEST SINGLE-MODEL SETUPS — 1 model, weights paid ONCE, main @ max ctx + scratchpad slot`);
console.log(`(budget ${gb(BUDGET)} GB after ${RESERVE} MiB reserve; needs --parallel + unified KV; ranked by quality)\n`);
console.log(`${pad('model', 28)} ${pad('qual', 5)} ${pad('weights', 8)} ${pad('main ctx', 9)} ${pad('scratch', 9)} ${pad('full slots', 11)} note`);
for (const s of setups) {
   const note = s.scratch < SCRATCH_MIN ? 'VRAM-bound — no scratchpad' : s.fullSlots >= 3 ? `room for ${s.fullSlots}× full-ctx slots` : 'main + scratchpad';
   console.log(
      `${pad(s.id, 28)} ${pad(s.score, 5)} ${pad(gb(s.weights) + 'G', 8)} ${pad(r0(s.main), 9)} ${pad(s.scratch < SCRATCH_MIN ? '—' : r0(s.scratch), 9)} ${pad(s.fullSlots >= 99 ? 'many' : s.fullSlots, 11)} ${note}`,
   );
}

// ── SVG + PNG render ─────────────────────────────────────────────────────────
const BG = '#0f0f13';
const PANEL = '#18181f';
const TEXT = '#e0e0e0';
const DIM = '#888';
const ACCENT = '#c8b6ff';
const GOOD = '#82dc82';
const WARN = '#ffc850';
const esc = (s) => String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
const T = (x, y, s, { fill = TEXT, size = 12, w = 'normal', anchor = 'start', mono = false } = {}) =>
   `<text x="${x}" y="${y}" fill="${fill}" font-size="${size}" font-weight="${w}" text-anchor="${anchor}" font-family="${mono ? "'Consolas','Courier New',monospace" : "'Segoe UI',Arial,sans-serif"}">${esc(s)}</text>`;
const R = (x, y, w, h, fill, rx = 0) => `<rect x="${x}" y="${y}" width="${w}" height="${h}" fill="${fill}" rx="${rx}"/>`;

const W = 1120;
const tableTop = 92;
const tableRowH = 22;
const setupsTop = tableTop + 28 + fleet.length * tableRowH + 52;
const H = setupsTop + 28 + setups.length * tableRowH + 50;

let svg = `<svg xmlns="http://www.w3.org/2000/svg" width="${W}" height="${H}"><rect width="${W}" height="${H}" fill="${BG}"/>`;
svg += T(28, 38, 'LLM Fleet Planner — VRAM @ max ctx (RX 7900 XT · 20 GiB · Vulkan)', { fill: ACCENT, size: 18, w: '700' });
svg += T(28, 58, `Card ${gb(CARD_TOTAL_MIB)} GB usable · quality = weighted score · fit× = card ÷ footprint at max ctx`, { fill: DIM, size: 11 });

// ── Table 1: per-model footprint + efficiency ──
svg += T(28, tableTop - 8, 'Per-model footprint & memory efficiency at max ctx', { fill: '#a0a0c0', size: 13, w: '600' });
const cols = [
   { x: 28, label: 'Model', get: (m) => m.id, anchor: 'start' },
   { x: 330, label: 'Quality', get: (m) => m.score.toFixed(1), anchor: 'end' },
   { x: 430, label: 'Max ctx', get: (m) => r0(m.maxctx), anchor: 'end' },
   { x: 535, label: 'VRAM@max', get: (m) => `${r0(m.vramMax)}M`, anchor: 'end' },
   { x: 610, label: '% card', get: (m) => `${m.footprintPct.toFixed(0)}%`, anchor: 'end' },
   { x: 730, label: 'KV KiB/tok', get: (m) => m.kvPerTokKiB.toFixed(1), anchor: 'end' },
   { x: 800, label: 'fit×', get: (m) => (CARD_TOTAL_MIB / m.vramMax).toFixed(1), anchor: 'end' },
];
svg += R(20, tableTop, W - 40, 24 + fleet.length * tableRowH, PANEL, 8);
for (const c of cols) svg += T(c.x, tableTop + 18, c.label, { fill: DIM, size: 10, anchor: c.anchor });
fleet.forEach((m, i) => {
   const y = tableTop + 24 + (i + 1) * tableRowH - 6;
   if (i % 2) svg += R(24, y - 14, W - 48, tableRowH, '#1e1e2a', 0);
   const fpFill = m.footprintPct > 90 ? WARN : m.footprintPct < 35 ? GOOD : TEXT;
   for (const c of cols) {
      const fill = c.label === '% card' ? fpFill : c.label === 'Quality' ? ACCENT : TEXT;
      svg += T(c.x, y, c.get(m), { fill, size: 11, anchor: c.anchor, mono: c.label !== 'Model' });
   }
});

// ── Table 2: best single-model setups (weights once · main + scratchpad) ──
svg += T(28, setupsTop - 8, 'Best single-model setups — weights ONCE, main @ max ctx + scratchpad (REQUIRES --parallel + --kv-unified; default splits the window)', {
   fill: '#a0a0c0',
   size: 13,
   w: '600',
});
const scols = [
   { x: 28, label: 'Model', get: (s) => s.id, anchor: 'start' },
   { x: 330, label: 'Quality', get: (s) => s.score.toFixed(1), anchor: 'end' },
   { x: 430, label: 'Weights', get: (s) => `${gb(s.weights)}G`, anchor: 'end' },
   { x: 545, label: 'Main ctx', get: (s) => r0(s.main), anchor: 'end' },
   { x: 660, label: 'Scratchpad', get: (s) => (s.scratch < SCRATCH_MIN ? '—' : r0(s.scratch)), anchor: 'end' },
   { x: 760, label: 'Full slots', get: (s) => (s.fullSlots >= 99 ? 'many' : String(s.fullSlots)), anchor: 'end' },
   { x: 800, label: 'Note', get: (s) => (s.scratch < SCRATCH_MIN ? 'VRAM-bound' : s.fullSlots >= 3 ? `${s.fullSlots}× full slots` : 'main+scratch'), anchor: 'start' },
];
svg += R(20, setupsTop, W - 40, 24 + setups.length * tableRowH, PANEL, 8);
for (const c of scols) svg += T(c.x, setupsTop + 18, c.label, { fill: DIM, size: 10, anchor: c.anchor });
setups.forEach((s, i) => {
   const y = setupsTop + 24 + (i + 1) * tableRowH - 6;
   if (i % 2) svg += R(24, y - 14, W - 48, tableRowH, '#1e1e2a', 0);
   const scratchOK = s.scratch >= SCRATCH_MIN;
   for (const c of scols) {
      let fill = TEXT;
      if (c.label === 'Quality') fill = ACCENT;
      else if (c.label === 'Scratchpad') fill = scratchOK ? GOOD : WARN;
      else if (c.label === 'Note') fill = scratchOK ? DIM : WARN;
      svg += T(c.x, y, c.get(s), { fill, size: 11, anchor: c.anchor, mono: c.label !== 'Model' && c.label !== 'Note' });
   }
});
svg += '</svg>';

writeFileSync(flags.output, svg, 'utf-8');
console.log(`\nFleet chart: ${flags.output}  (${(svg.length / 1024).toFixed(1)} KB)`);
const pngPath = flags.output.replace(/\.svg$/, '.png');
try {
   const sharp = (await import('sharp')).default;
   await sharp(Buffer.from(svg), { density: 150 }).png().toFile(pngPath);
   console.log(`Fleet PNG:   ${pngPath}`);
} catch (e) {
   console.warn(`(PNG export skipped: ${e.message.slice(0, 80)})`);
}
