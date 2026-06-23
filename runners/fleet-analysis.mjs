#!/usr/bin/env node
/**
 * Fleet / VRAM-packing analysis for agentic multi-model setups.
 *
 * VRAM(ctx) is modeled linearly:
 *   VRAM(c) = weights + kv_per_token · c
 * The kv/token slope is MEASURED directly by runners/kv-probe.mjs (kv_per_tok
 * rows, KiB/token) — config kv_bytes_per_token estimates are not trusted. weights
 * is back-solved from the coherence-verified max-ctx VRAM point. A model with no
 * measured slope is omitted from the packing tables rather than guessed.
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
 * Usage: node runners/fleet-analysis.mjs [--input <run-id>] [--sec-ctx 32768]
 */

import { writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseArgs } from 'node:util';
import { aggregateModels, CARD_TOTAL_MIB, loadRuns, mergeResultRows } from '../shared/results-store.mjs';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const RESULTS_DIR = join(ROOT, 'results');
const { values: flags } = parseArgs({
   options: {
      input: { type: 'string', multiple: true },
      output: { type: 'string', default: join(RESULTS_DIR, 'fleet.svg') },
      'sec-ctx': { type: 'string', default: '32768' },
      reserve: { type: 'string', default: '512' },
      anchor: { type: 'string', default: '100000' },
   },
});

const RESERVE = Number(flags.reserve);
const BUDGET = CARD_TOTAL_MIB - RESERVE;

// Accepts one or more --input (run id | run dir | run.json). kv_per_tok now lives in
// its own kvprobe run, so merging the suite + the kv-probe run is the normal case here.
const runs = loadRuns(RESULTS_DIR, flags.input);
if (!runs.length) {
   console.error('No runs found. Run the suite + kv-probe first, or pass --input <run-id>.');
   process.exit(1);
}
const rows = mergeResultRows(runs.flatMap((r) => r.results));
const { models, ranking } = aggregateModels(rows);

// Directly-measured KV/token slope (MiB/token), from runners/kv-probe.mjs, which
// loads each model at two ctx sizes and differences the board VRAM. The CSV row
// stores KiB/token in `score`. No config fallback — a model without a measured
// slope is dropped from the packing analysis below rather than guessed.
const kvMeasMiB = new Map(); // base_model -> kv MiB/token
for (const r of rows) {
   if (String(r.bench) !== 'kv_per_tok') {
      continue;
   }
   const kib = parseFloat(r.score);
   if (Number.isFinite(kib) && kib > 0) {
      kvMeasMiB.set(r.model.replace(/--(nothi|think)$/, ''), kib / 1024);
   }
}

// Think-state display tag. VRAM, weights, KV and max ctx are QUANT-determined and
// mode-independent (same GGUF + KV cache; maxctx is probed once per base), so think
// vs no-think differ ONLY in quality — but they are kept as separate rows so the
// mode-specific quality and overall rank stay visible.
const thinkTag = (t) => (t === 'think' ? ' ·think' : t === 'no_think' ? ' ·no-think' : t === 'best-of' ? ' ·best-of' : '');

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
   if (m.maxctx == null || m.maxctxVram == null) {
      continue;
   }
   const vramMax = m.maxctxVram;
   const kv = kvMeasMiB.get(m.base_model); // measured KV/token (MiB); no fallback
   if (kv == null) {
      console.warn(`[fleet] no measured kv_per_tok for ${m.base_model} — run kv-probe; omitting from packing tables`);
      continue;
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
      `${pad(m.id, 42)} ${pad(m.score, 5)} ${pad(r0(m.maxctx), 9)} ${pad(`${r0(m.vramMax)}M`, 9)} ${pad(`${m.footprintPct.toFixed(0)}%`, 6)} ${pad(m.kvPerTokKiB.toFixed(1), 9)} ${(CARD_TOTAL_MIB / m.vramMax).toFixed(1)}`,
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
const WORKER_CTX = 65536; // "1 full + N×64k" layout: each worker slot gets a 64k window
const setups = fleet
   .map((m) => {
      // kv is a measured positive slope (models without one were dropped above).
      const tokenBudget = (BUDGET - PARALLEL_OH - m.weights) / m.kv; // total KV tokens that fit (2 slots)
      const main = m.maxctx; // the "1 max ctx" slot
      const leftover = Math.max(0, tokenBudget - main);
      const scratch = Math.min(m.maxctx, leftover); // 2nd slot, capped at coherence ceiling
      const fullSlots = Math.floor(tokenBudget / m.maxctx); // how many full-ctx slots fit
      // Agentic layout: ONE main slot at full ctx (the long-context lead) + as many
      // 64k worker slots as the remaining VRAM holds. Worker ctx is capped at the
      // model's coherence ceiling, so a model whose maxctx < 64k gets maxctx workers.
      const workerCtx = Math.min(WORKER_CTX, m.maxctx);
      const workers64 = Math.max(0, Math.floor((tokenBudget - main) / workerCtx));
      const vramUsed = m.weights + m.kv * (main + scratch);
      return { ...m, tokenBudget, main, scratch, fullSlots, workerCtx, workers64, vramUsed };
   })
   .sort((a, b) => b.score - a.score);

console.log(`\nBEST SINGLE-MODEL SETUPS — 1 model, weights paid ONCE, main @ max ctx + scratchpad slot`);
console.log(`(budget ${gb(BUDGET)} GB after ${RESERVE} MiB reserve; needs --parallel + unified KV; ranked by quality)\n`);
console.log(
   `${pad('model', 42)} ${pad('qual', 5)} ${pad('weights', 8)} ${pad('main ctx', 9)} ${pad('scratch', 9)} ${pad('full slots', 11)} ${pad('1full+64k', 11)} note`,
);
for (const s of setups) {
   const note =
      s.scratch < SCRATCH_MIN
         ? 'VRAM-bound — no scratchpad'
         : s.fullSlots >= 3
           ? `room for ${s.fullSlots}× full-ctx slots`
           : 'main + scratchpad';
   const w64 = s.workerCtx < WORKER_CTX ? `1+${s.workers64}×${r0(s.workerCtx / 1024)}k` : `1+${s.workers64}×64k`;
   console.log(
      `${pad(s.id, 42)} ${pad(s.score, 5)} ${pad(`${gb(s.weights)}G`, 8)} ${pad(r0(s.main), 9)} ${pad(s.scratch < SCRATCH_MIN ? '—' : r0(s.scratch), 9)} ${pad(s.fullSlots, 11)} ${pad(w64, 11)} ${note}`,
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
for (const c of cols) {
   svg += T(c.x, tableTop + 18, c.label, { fill: DIM, size: 10, anchor: c.anchor });
}
fleet.forEach((m, i) => {
   const y = tableTop + 24 + (i + 1) * tableRowH - 6;
   if (i % 2) {
      svg += R(24, y - 14, W - 48, tableRowH, '#1e1e2a', 0);
   }
   const fpFill = m.footprintPct > 90 ? WARN : m.footprintPct < 35 ? GOOD : TEXT;
   for (const c of cols) {
      const fill = c.label === '% card' ? fpFill : c.label === 'Quality' ? ACCENT : TEXT;
      svg += T(c.x, y, c.get(m), { fill, size: 11, anchor: c.anchor, mono: c.label !== 'Model' });
   }
   if (m.rankIdx != null) {
      svg += starBadge(W - 30, y - 3, 5 - m.rankIdx);
   }
});

// ── Table 2: best single-model setups (weights once · main + scratchpad) ──
svg += T(
   28,
   setupsTop - 8,
   'Best single-model setups — weights ONCE, main @ max ctx + scratchpad · 1full+64k = 1 lead @max + N×64k workers (REQUIRES --parallel + --kv-unified)',
   {
      fill: '#a0a0c0',
      size: 13,
      w: '600',
   },
);
const scols = [
   { x: 28, label: 'Model', get: (s) => s.id, anchor: 'start' },
   { x: 440, label: 'Quality', get: (s) => s.score.toFixed(1), anchor: 'end' },
   { x: 525, label: 'Weights', get: (s) => `${gb(s.weights)}G`, anchor: 'end' },
   { x: 615, label: 'Main ctx', get: (s) => r0(s.main), anchor: 'end' },
   { x: 705, label: 'Scratchpad', get: (s) => (s.scratch < SCRATCH_MIN ? '—' : r0(s.scratch)), anchor: 'end' },
   { x: 775, label: 'Full slots', get: (s) => String(s.fullSlots), anchor: 'end' },
   {
      x: 885,
      label: '1full+64k',
      get: (s) => (s.workerCtx < WORKER_CTX ? `1+${s.workers64}×${r0(s.workerCtx / 1024)}k` : `1+${s.workers64}×64k`),
      anchor: 'end',
   },
   {
      x: 897,
      label: 'Note',
      get: (s) => (s.scratch < SCRATCH_MIN ? 'VRAM-bound' : s.fullSlots >= 3 ? `${s.fullSlots}× full slots` : 'main+scratch'),
      anchor: 'start',
   },
];
svg += R(20, setupsTop, W - 40, 24 + setups.length * tableRowH, PANEL, 8);
for (const c of scols) {
   svg += T(c.x, setupsTop + 18, c.label, { fill: DIM, size: 10, anchor: c.anchor });
}
setups.forEach((s, i) => {
   const y = setupsTop + 24 + (i + 1) * tableRowH - 6;
   if (i % 2) {
      svg += R(24, y - 14, W - 48, tableRowH, '#1e1e2a', 0);
   }
   const scratchOK = s.scratch >= SCRATCH_MIN;
   for (const c of scols) {
      let fill = TEXT;
      if (c.label === 'Quality') {
         fill = ACCENT;
      } else if (c.label === 'Scratchpad') {
         fill = scratchOK ? GOOD : WARN;
      } else if (c.label === '1full+64k') {
         fill = s.workers64 > 0 ? GOOD : WARN;
      } else if (c.label === 'Note') {
         fill = scratchOK ? DIM : WARN;
      }
      svg += T(c.x, y, c.get(s), { fill, size: 11, anchor: c.anchor, mono: c.label !== 'Model' && c.label !== 'Note' });
   }
   if (s.rankIdx != null) {
      svg += starBadge(W - 30, y - 3, 5 - s.rankIdx);
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
