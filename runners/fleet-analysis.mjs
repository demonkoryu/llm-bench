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
const SEC_CTX = Number(flags['sec-ctx']);
const RESERVE = Number(flags.reserve);
const ANCHOR_MIN_CTX = Number(flags.anchor);
const BUDGET = CARD_TOTAL_MIB - RESERVE;

const input = flags.input ?? latestResultsFile(RESULTS_DIR);
if (!existsSync(input)) {
   console.error(`Input not found: ${input}`);
   process.exit(1);
}
const rows = readTable(input);
const { models } = aggregateModels(rows);

// VRAM used at ctx=16384, captured by the speed re-run (ctx_loaded == 16384).
const vram16k = new Map();
for (const r of rows) {
   if (String(r.bench).startsWith('speed') && Number(r.ctx_loaded) === 16384) {
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
      kv = (e.vramMax - v16) / (e.maxctx - 16384);
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

// ── 3: best fleets — 1 long-ctx anchor + distinct secondaries packed in ──────
const anchors = fleet.filter((m) => m.maxctx >= ANCHOR_MIN_CTX);
const combos = [];
for (const a of anchors) {
   const remaining = BUDGET - a.vramMax;
   const pool = fleet.filter((m) => m.id !== a.id).map((m) => ({ ...m, secVram: m.vramAt(SEC_CTX), secCtx: Math.min(SEC_CTX, m.maxctx) }));
   const n = pool.length;
   for (let mask = 0; mask < 1 << n; mask++) {
      let used = 0;
      const members = [];
      for (let i = 0; i < n; i++) {
         if (mask & (1 << i)) {
            used += pool[i].secVram;
            members.push(pool[i]);
         }
      }
      if (used > remaining) continue;
      combos.push({
         anchor: a,
         members,
         totalQ: a.score + members.reduce((s, m) => s + m.score, 0),
         totalVram: a.vramMax + used,
         totalCtx: a.maxctx + members.reduce((s, m) => s + m.secCtx, 0),
         count: 1 + members.length,
      });
   }
}
combos.sort((x, y) => y.totalQ - x.totalQ || y.totalCtx - x.totalCtx);
const seen = new Set();
const top = [];
for (const c of combos) {
   const key = [c.anchor.id, ...c.members.map((m) => m.id).sort()].join('+');
   if (seen.has(key)) continue;
   seen.add(key);
   top.push(c);
   if (top.length >= 10) break;
}

console.log(`\nBEST 10 FLEETS — anchor (maxctx≥${r0(ANCHOR_MIN_CTX)}) at full ctx + distinct secondaries @ ${r0(SEC_CTX)} ctx`);
console.log(`(budget ${gb(BUDGET)} GB after ${RESERVE} MiB reserve; ranked by total fleet quality)\n`);
top.forEach((c, i) => {
   console.log(`#${i + 1}  Σquality ${c.totalQ.toFixed(0)} · ${c.count} models · ${gb(c.totalVram)}/${gb(BUDGET)} GB · free ${gb(BUDGET - c.totalVram)} GB`);
   console.log(`     anchor ${pad(c.anchor.id, 26)} q${c.anchor.score}  ctx ${r0(c.anchor.maxctx)}`);
   for (const m of [...c.members].sort((a, b) => b.score - a.score)) {
      console.log(`       +    ${pad(m.id, 26)} q${m.score}  ctx ${r0(m.secCtx)}`);
   }
});

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

const W = 1080;
const fleetLineH = 15;
const fleetBlockH = (c) => 22 + c.count * fleetLineH + 10;
const tableTop = 92;
const tableRowH = 22;
const fleetsTop = tableTop + 28 + fleet.length * tableRowH + 46;
const fleetsH = top.reduce((s, c) => s + fleetBlockH(c), 0);
const H = fleetsTop + fleetsH + 30;

let svg = `<svg xmlns="http://www.w3.org/2000/svg" width="${W}" height="${H}"><rect width="${W}" height="${H}" fill="${BG}"/>`;
svg += T(28, 38, 'LLM Fleet Planner — VRAM packing @ max ctx (RX 7900 XT · 20 GiB · Vulkan)', { fill: ACCENT, size: 18, w: '700' });
svg += T(28, 58, `Card ${gb(CARD_TOTAL_MIB)} GB usable · quality = weighted score · fit× = card ÷ footprint at max ctx`, { fill: DIM, size: 11 });

// Per-model table
svg += T(28, tableTop - 8, 'Per-model footprint & memory efficiency at max ctx', { fill: '#a0a0c0', size: 13, w: '600' });
const cols = [
   { x: 28, label: 'Model', get: (m) => m.id, anchor: 'start' },
   { x: 300, label: 'Quality', get: (m) => m.score.toFixed(1), anchor: 'end' },
   { x: 400, label: 'Max ctx', get: (m) => r0(m.maxctx), anchor: 'end' },
   { x: 500, label: 'VRAM@max', get: (m) => `${r0(m.vramMax)}M`, anchor: 'end' },
   { x: 575, label: '% card', get: (m) => `${m.footprintPct.toFixed(0)}%`, anchor: 'end' },
   { x: 690, label: 'KV KiB/tok', get: (m) => m.kvPerTokKiB.toFixed(1), anchor: 'end' },
   { x: 760, label: 'fit×', get: (m) => (CARD_TOTAL_MIB / m.vramMax).toFixed(1), anchor: 'end' },
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

// Fleets
svg += T(28, fleetsTop - 14, `Best 10 fleets — 1 anchor (max ctx ≥ ${r0(ANCHOR_MIN_CTX)}) at full ctx + distinct models @ ${r0(SEC_CTX)} ctx`, {
   fill: '#a0a0c0',
   size: 13,
   w: '600',
});
let fy = fleetsTop;
top.forEach((c, i) => {
   const h = fleetBlockH(c);
   svg += R(20, fy, W - 40, h - 8, PANEL, 8);
   svg += T(32, fy + 18, `#${i + 1}`, { fill: ACCENT, size: 13, w: '700' });
   svg += T(70, fy + 18, `Σquality ${c.totalQ.toFixed(0)}`, { fill: GOOD, size: 12, w: '600' });
   svg += T(
      200,
      fy + 18,
      `${c.count} models · ${gb(c.totalVram)}/${gb(BUDGET)} GB · free ${gb(BUDGET - c.totalVram)} GB · Σctx ${r0(c.totalCtx)}`,
      { fill: DIM, size: 11 },
   );
   let ly = fy + 18 + fleetLineH;
   svg += T(48, ly, `⚓ ${c.anchor.id}`, { fill: TEXT, size: 11, w: '600' });
   svg += T(W - 40, ly, `q${c.anchor.score} · ${r0(c.anchor.maxctx)} ctx`, { fill: DIM, size: 11, anchor: 'end', mono: true });
   for (const m of [...c.members].sort((a, b) => b.score - a.score)) {
      ly += fleetLineH;
      svg += T(56, ly, `+ ${m.id}`, { fill: '#b8b8c8', size: 11 });
      svg += T(W - 40, ly, `q${m.score} · ${r0(m.secCtx)} ctx`, { fill: DIM, size: 11, anchor: 'end', mono: true });
   }
   fy += h;
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
