#!/usr/bin/env node
/**
 * Fleet / VRAM-packing analysis for agentic multi-model setups.
 *
 * VRAM(ctx) is modeled linearly:
 *   VRAM(c) = weights + kv_per_token · c
 * The kv/token slope comes from config (kv_bytes_per_token, the physical
 * whole-model KV size); an empirical slope is used instead only when the dataset
 * carries a second VRAM measurement at a ctx strictly below maxctx. weights is
 * then back-solved from the coherence-verified max-ctx VRAM point.
 * From that this reports:
 *   1. Footprint at max ctx as a fraction of the card (how many fit).
 *   2. VRAM-per-ctx-token: gross (vram@maxctx / maxctx) and marginal KV/token.
 *   3. Best fleets: one high-quality anchor (maxctx > 100k) at full ctx, plus
 *      whatever distinct models fit in the remaining VRAM at a usable agentic ctx.
 *
 * One row per quant × think-state: weights size differs by quant, so VRAM, max ctx
 * and slot capacity differ by quant. think vs no-think share VRAM/ctx (same GGUF +
 * KV; maxctx probed once per base) and differ only in quality.
 *
 * Emits text + results/fleet.svg + results/fleet.png.
 *
 * Usage: node runners/fleet-analysis.mjs [--input results/<csv>] [--sec-ctx 32768]
 */

import { existsSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseArgs } from 'node:util';
import { loadModelsConfig } from '../shared/models-config.mjs';
import { aggregateModels, CARD_TOTAL_MIB, latestResultsFile, readTable } from '../shared/results-csv.mjs';

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

const RESERVE = Number(flags.reserve);
const BUDGET = CARD_TOTAL_MIB - RESERVE;

const input = flags.input ?? latestResultsFile(RESULTS_DIR);
if (!existsSync(input)) {
   console.error(`Input not found: ${input}`);
   process.exit(1);
}
const rows = readTable(input);
const { models, ranking } = aggregateModels(rows);

// VRAM(ctx) is modeled linearly as weights + kv·ctx. Fitting kv empirically needs
// a SECOND VRAM point below maxctx. The speed re-run used to load at a fixed
// ctx=16384 and supplied that point; it now reuses the maxctx-loaded server, so
// its VRAM equals the maxctx point and carries no slope. Collect the LOWEST-ctx
// single-slot speed VRAM point per model and use it only if it sits strictly
// below maxctx. speed_pargen rows allocate KV for up to 8 slots, so their VRAM is
// inflated and must NOT seed the single-slot baseline.
const vramLow = new Map(); // base_model -> { ctx, vram } at the smallest measured ctx
for (const r of rows) {
   const bench = String(r.bench);
   if (!bench.startsWith('speed') || bench.startsWith('speed_pargen')) continue;
   const ctx = Number(r.ctx_loaded);
   const v = parseFloat(r.vram_mib);
   if (!Number.isFinite(ctx) || !Number.isFinite(v)) continue;
   const base = r.model.replace(/--(nothi|think)$/, '');
   const cur = vramLow.get(base);
   if (!cur || ctx < cur.ctx) vramLow.set(base, { ctx, vram: v });
}

// Authoritative per-token KV size (whole-model, all layers) from config — the
// physical VRAM(ctx) slope. This is the fallback (now the common case) whenever
// the dataset lacks a second measured VRAM point below maxctx.
const kvCfgMiB = new Map();
try {
   const cfg = loadModelsConfig(join(ROOT, 'config/models.yaml'));
   for (const cm of cfg.models ?? []) {
      const base = String(cm.hf_file ?? '').replace(/\.gguf$/i, '');
      const bpt = Number(cm.kv_bytes_per_token);
      if (base && Number.isFinite(bpt) && bpt > 0) kvCfgMiB.set(base, bpt / (1024 * 1024));
   }
} catch {
   /* fall back to measured slope only */
}

// Think-state display tag. VRAM, weights, KV and max ctx are QUANT-determined and
// mode-independent (same GGUF + KV cache; maxctx is probed once per base), so think
// vs no-think differ ONLY in quality — but they are kept as separate rows so the
// mode-specific quality and overall rank stay visible.
const thinkTag = (t) => (t === 'think' ? ' ·think' : t === 'no_think' ? ' ·no-think' : '');

// Top-5 overall finishers (variant-level, same as the main chart) get the star badge.
ranking.slice(0, 5).forEach((m, i) => {
   m.rankIdx = i;
});

// One entry PER QUANT × think-state. Different quants have different weights size,
// hence different VRAM, max ctx, and slot/ctx capacity — so each is its own row.
// (Previously this collapsed to one row per architecture, keeping only the best
// quant, which hid that capacity tradeoff entirely.)
const fleet = [];
for (const m of models) {
   if (m.maxctx == null || m.maxctxVram == null) continue;
   const vramMax = m.maxctxVram;
   const low = vramLow.get(m.base_model);
   let kv = kvCfgMiB.get(m.base_model) ?? 0; // physical KV/token (MiB) from config
   // Prefer an empirical slope when a genuine second VRAM point exists below
   // maxctx (two distinct ctx). A non-positive slope is non-physical — it means
   // the two points were measured under different server configs (e.g. mixing
   // -ub 512 maxctx rows with -ub 2048 low-ctx rows inflates the low point) — so
   // ignore it and keep the config KV size rather than emitting nonsense.
   if (low != null && low.ctx < m.maxctx) {
      const measured = (vramMax - low.vram) / (m.maxctx - low.ctx);
      if (measured > 0) kv = measured;
   }
   const weights = Math.max(0, vramMax - kv * m.maxctx);
   fleet.push({
      id: m.base_model + thinkTag(m.think),
      base: m.base_model,
      think: m.think,
      rankIdx: m.rankIdx,
      score: m.score,
      maxctx: m.maxctx,
      vramMax,
      kv,
      weights,
      vramAt: (c) => weights + kv * Math.min(c, m.maxctx),
      footprintPct: (vramMax / CARD_TOTAL_MIB) * 100,
      grossPerTok: (vramMax / m.maxctx) * 1024,
      kvPerTokKiB: kv * 1024,
   });
}
fleet.sort((a, b) => b.score - a.score);

const r0 = (x) => (x == null ? '?' : Math.round(x).toLocaleString());
const gb = (mib) => (mib / 1024).toFixed(1);

// ── 1 & 2: per-model footprint + efficiency (text) ───────────────────────────
const pad = (s, n) => String(s).padEnd(n);
console.log(`\nCard: ${CARD_TOTAL_MIB} MiB (${gb(CARD_TOTAL_MIB)} GB) usable\n`);
console.log(
   `${pad('model', 42)} ${pad('qual', 5)} ${pad('maxctx', 9)} ${pad('vram@max', 9)} ${pad('%card', 6)} ${pad('KV KiB/t', 9)} fit×`,
);
for (const m of fleet) {
   console.log(
      `${pad(m.id, 42)} ${pad(m.score, 5)} ${pad(r0(m.maxctx), 9)} ${pad(r0(m.vramMax) + 'M', 9)} ${pad(m.footprintPct.toFixed(0) + '%', 6)} ${pad(m.kvPerTokKiB.toFixed(1), 9)} ${(CARD_TOTAL_MIB / m.vramMax).toFixed(1)}`,
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
console.log(
   `${pad('model', 42)} ${pad('qual', 5)} ${pad('weights', 8)} ${pad('main ctx', 9)} ${pad('scratch', 9)} ${pad('full slots', 11)} note`,
);
for (const s of setups) {
   const note =
      s.scratch < SCRATCH_MIN
         ? 'VRAM-bound — no scratchpad'
         : s.fullSlots >= 3
           ? `room for ${s.fullSlots}× full-ctx slots`
           : 'main + scratchpad';
   console.log(
      `${pad(s.id, 42)} ${pad(s.score, 5)} ${pad(gb(s.weights) + 'G', 8)} ${pad(r0(s.main), 9)} ${pad(s.scratch < SCRATCH_MIN ? '—' : r0(s.scratch), 9)} ${pad(s.fullSlots >= 99 ? 'many' : s.fullSlots, 11)} ${note}`,
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
const STAR_GOLD = '#ffd54a';
const STAR_DIM = '#4a4a57';
// 5-star overall-rank badge (gold = 5 - rankIdx), right-aligned on a dark pill.
const starBadge = (rightX, midY, earned) => {
   const step = 10;
   const padX = 5;
   const w = 5 * step + padX * 2 - 2;
   const x0 = rightX - w;
   let s = R(x0, midY - 9, w, 17, '#0a0a0e', 4);
   for (let k = 0; k < 5; k++) {
      s += T(x0 + padX + k * step, midY + 4, '★', { fill: k < earned ? STAR_GOLD : STAR_DIM, size: 12 });
   }
   return s;
};

const W = 1120;
const tableTop = 92;
const tableRowH = 22;
const setupsTop = tableTop + 28 + fleet.length * tableRowH + 52;
const H = setupsTop + 28 + setups.length * tableRowH + 50;

let svg = `<svg xmlns="http://www.w3.org/2000/svg" width="${W}" height="${H}"><rect width="${W}" height="${H}" fill="${BG}"/>`;
svg += T(28, 38, 'LLM Fleet Planner — VRAM @ max ctx (RX 7900 XT · 20 GiB · Vulkan)', { fill: ACCENT, size: 18, w: '700' });
svg += T(
   28,
   58,
   `Card ${gb(CARD_TOTAL_MIB)} GB · one row per quant×mode (VRAM/ctx is quant-determined; think vs no-think differ only in quality) · fit× = card ÷ footprint · ★★★★★ = top-5 overall (gold = rank)`,
   {
      fill: DIM,
      size: 11,
   },
);

// ── Table 1: per-model footprint + efficiency ──
svg += T(28, tableTop - 8, 'Per-model footprint & memory efficiency at max ctx', { fill: '#a0a0c0', size: 13, w: '600' });
const cols = [
   { x: 28, label: 'Model', get: (m) => m.id, anchor: 'start' },
   { x: 470, label: 'Quality', get: (m) => m.score.toFixed(1), anchor: 'end' },
   { x: 560, label: 'Max ctx', get: (m) => r0(m.maxctx), anchor: 'end' },
   { x: 670, label: 'VRAM@max', get: (m) => `${r0(m.vramMax)}M`, anchor: 'end' },
   { x: 745, label: '% card', get: (m) => `${m.footprintPct.toFixed(0)}%`, anchor: 'end' },
   { x: 875, label: 'KV KiB/tok', get: (m) => m.kvPerTokKiB.toFixed(1), anchor: 'end' },
   { x: 945, label: 'fit×', get: (m) => (CARD_TOTAL_MIB / m.vramMax).toFixed(1), anchor: 'end' },
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
   if (m.rankIdx != null) svg += starBadge(W - 30, y - 3, 5 - m.rankIdx);
});

// ── Table 2: best single-model setups (weights once · main + scratchpad) ──
svg += T(
   28,
   setupsTop - 8,
   'Best single-model setups — weights ONCE, main @ max ctx + scratchpad (REQUIRES --parallel + --kv-unified; default splits the window)',
   {
      fill: '#a0a0c0',
      size: 13,
      w: '600',
   },
);
const scols = [
   { x: 28, label: 'Model', get: (s) => s.id, anchor: 'start' },
   { x: 470, label: 'Quality', get: (s) => s.score.toFixed(1), anchor: 'end' },
   { x: 560, label: 'Weights', get: (s) => `${gb(s.weights)}G`, anchor: 'end' },
   { x: 660, label: 'Main ctx', get: (s) => r0(s.main), anchor: 'end' },
   { x: 765, label: 'Scratchpad', get: (s) => (s.scratch < SCRATCH_MIN ? '—' : r0(s.scratch)), anchor: 'end' },
   { x: 845, label: 'Full slots', get: (s) => (s.fullSlots >= 99 ? 'many' : String(s.fullSlots)), anchor: 'end' },
   {
      x: 855,
      label: 'Note',
      get: (s) => (s.scratch < SCRATCH_MIN ? 'VRAM-bound' : s.fullSlots >= 3 ? `${s.fullSlots}× full slots` : 'main+scratch'),
      anchor: 'start',
   },
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
   if (s.rankIdx != null) svg += starBadge(W - 30, y - 3, 5 - s.rankIdx);
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
