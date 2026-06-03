#!/usr/bin/env node
/**
 * Data-driven SVG chart renderer for llm-bench results.
 *
 * Reads results/results.tsv and renders:
 *   1. Overall weighted ranking (quality 25% · tool 20% · ctx 30% · speed 25%)
 *   2. Per-metric bar panels (decode speed, max context, triage, toolcalling, docqa, summarization)
 *   3. Score breakdown table
 *
 * Usage:
 *   node runners/render-chart.mjs
 *   node runners/render-chart.mjs --input results/my-results.tsv --output results/chart.svg
 *
 * Output: results/chart.svg
 */

import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseArgs } from 'node:util';

const __dir = dirname(fileURLToPath(import.meta.url));
const ROOT = join(__dir, '..');

const { values: flags } = parseArgs({
   options: {
      input: { type: 'string', default: join(ROOT, 'results/results.tsv') },
      output: { type: 'string', default: join(ROOT, 'results/chart.svg') },
   },
});

// ── Read & aggregate TSV ───────────────────────────────────────────────────────
if (!existsSync(flags.input)) {
   console.error(`Results file not found: ${flags.input}`);
   process.exit(1);
}
const rows = readFileSync(flags.input, 'utf8').split('\n').filter(Boolean);
const header = rows[0].split('\t');
const data = rows
   .slice(1)
   .map((line) => {
      const cells = line.split('\t');
      return Object.fromEntries(header.map((h, i) => [h, cells[i] ?? '']));
   })
   .filter((r) => r.status === 'ok' && r.bench !== 'load' && r.bench !== 'smoke');

// Group by model × think-state
const modelMap = new Map();
for (const row of data) {
   const key = `${row.model}|${row.think}`;
   if (!modelMap.has(key)) {
      modelMap.set(key, { model: row.model, think: row.think, rows: [] });
   }
   modelMap.get(key).rows.push(row);
}

// Extract best numeric value for a bench
function bestScore(rows, bench) {
   const matches = rows
      .filter((r) => r.bench === bench)
      .map((r) => parseFloat(r.score))
      .filter(Number.isFinite);
   return matches.length ? Math.max(...matches) : null;
}

// Build model summaries
const models = [...modelMap.values()]
   .map(({ model, think, rows }) => {
      const maxctx = bestScore(rows, 'maxctx');
      const triage = bestScore(rows, 'triage');
      const toolcall = bestScore(rows, 'toolcalling');
      const summ = bestScore(rows, 'summarization');
      const docqa = bestScore(rows, 'docqa');
      const speedTg =
         Math.max(bestScore(rows, 'speed_short') ?? 0, bestScore(rows, 'speed_long-32k') ?? 0, bestScore(rows, 'speed') ?? 0) || null;

      // Quality blend: triage (0-100), summ (0-100), docqa (0-10→*10)
      const qualParts = [triage, summ, docqa != null ? docqa * 10 : null].filter((v) => v != null);
      const qual = qualParts.length ? qualParts.reduce((a, b) => a + b, 0) / qualParts.length : null;

      return {
         label: `${model}${think !== 'n/a' ? ` [${think}]` : ''}`,
         model,
         think,
         maxctx,
         triage,
         toolcall,
         summ,
         docqa,
         speedTg,
         qual,
      };
   })
   .filter((m) => m.maxctx || m.triage || m.speedTg); // skip empty rows

if (!models.length) {
   console.error('No completed model results found in TSV. Run the benchmark first.');
   process.exit(0);
}

// Normalize for ranking
const maxCtx = Math.max(...models.map((m) => m.maxctx ?? 0)) || 1;
const maxSpeed = Math.max(...models.map((m) => m.speedTg ?? 0)) || 1;

// Weighted ranking: quality 25, tool 20, ctx 30, speed 25
function finalScore(m) {
   const qualN = m.qual != null ? m.qual / 100 : 0;
   const toolN = m.toolcall != null ? m.toolcall / 100 : 0;
   const ctxN = m.maxctx != null ? m.maxctx / maxCtx : 0;
   const speedN = m.speedTg != null ? m.speedTg / maxSpeed : 0;
   return 0.25 * qualN + 0.2 * toolN + 0.3 * ctxN + 0.25 * speedN;
}

// ── SVG constants ─────────────────────────────────────────────────────────────
const COLORS = [
   '#5ab4fa',
   '#82dc82',
   '#ffc850',
   '#c88cfa',
   '#f08264',
   '#a06ce0',
   '#6ec87e',
   '#d85040',
   '#e0c060',
   '#60c0e0',
   '#e06090',
   '#90e060',
];

models.forEach((m, i) => {
   m.score = Math.round(finalScore(m) * 1000) / 10;
   m.color = COLORS[i % COLORS.length];
});

const ranked = [...models].sort((a, b) => b.score - a.score);

const BG = '#0f0f13';
const PANEL = '#18181f';
const TRACK = '#252530';
const TEXT = '#e0e0e0';
const DIM = '#888';
// WARN color for future use (low-speed flags etc.)
// const WARN  = '#ffb347';
const ACCENT = '#c8b6ff';

const PAD = { top: 70, left: 20, right: 20, bottom: 40 };
const BAR_H = 18;
const ROW_GAP = 6;
const ROW_H = BAR_H + ROW_GAP;
const LABEL_W = 220;
const COL_W = 520;
const COL_GAP = 28;
const TITLE_H = 32;
const N = models.length;
const PANEL_H = N * ROW_H + 8;

const GRID_PANELS = 4;
const GRID_ROWS = Math.ceil(GRID_PANELS / 2);
const GRID_H = GRID_ROWS * (TITLE_H + PANEL_H + 28);
const TABLE_H = (N + 3) * 22 + 20;
const WIDE_W = 2 * COL_W + COL_GAP + 32;
const TOTAL_W = PAD.left + WIDE_W + PAD.right;
const TOTAL_H = PAD.top + TITLE_H + PANEL_H + 36 + GRID_H + TABLE_H + PAD.bottom;

function esc(s) {
   return String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}
function rect(x, y, w, h, fill, rx = 0, opacity = 1) {
   return `<rect x="${x}" y="${y}" width="${w}" height="${h}" fill="${fill}" rx="${rx}" opacity="${opacity}"/>`;
}
function svgText(x, y, content, { fill = TEXT, size = 11, anchor = 'start', weight = 'normal' } = {}) {
   return `<text x="${x}" y="${y}" fill="${fill}" font-size="${size}" text-anchor="${anchor}" font-weight="${weight}" font-family="'Segoe UI',Arial,sans-serif">${esc(content)}</text>`;
}

function barPanel(x, y, pw, title, subtitle, items) {
   const bx = x + LABEL_W + 8;
   const trackW = pw - LABEL_W - 8 - 12;
   const innerH = items.length * ROW_H + 8;
   const totalH = TITLE_H + innerH;

   let s = rect(x, y, pw, totalH, PANEL, 10);
   s += svgText(x + 12, y + 16, title, { fill: '#a0a0c0', size: 11, weight: '600' });
   s += svgText(x + 12, y + 28, subtitle, { fill: DIM, size: 9 });

   items.forEach((item, i) => {
      const barY = y + TITLE_H + i * ROW_H;
      const pct = trackW * Math.min(1, (item.value ?? 0) / (item.max || 1));
      s += svgText(x + 10, barY + 13, item.label, { fill: TEXT, size: 10 });
      s += rect(bx, barY, trackW, BAR_H, TRACK, 3);
      s += `<rect x="${bx}" y="${barY}" width="${Math.max(0, pct)}" height="${BAR_H}" fill="${item.color}" rx="3"/>`;
      s += svgText(bx + 6, barY + 13, item.displayVal, { fill: 'rgba(255,255,255,0.9)', size: 10, weight: '600' });
   });
   return s;
}

// ── Build SVG ─────────────────────────────────────────────────────────────────
let svg = `<svg xmlns="http://www.w3.org/2000/svg" width="${TOTAL_W}" height="${TOTAL_H}">`;
svg += rect(0, 0, TOTAL_W, TOTAL_H, BG);
svg += svgText(PAD.left + 4, 36, 'LLM Benchmark Results — Vulkan (RX 7900 XT, 20 GiB)', { fill: ACCENT, size: 17, weight: '700' });
svg += svgText(PAD.left + 4, 54, 'llama-server · Q8_0/Q8_0 KV · official openai SDK · llm-bench', { fill: '#666', size: 10 });

// ── Overall Ranking ────────────────────────────────────────────────────────────
const rankY = PAD.top;
const rankItems = ranked.map((r, i) => ({
   label: `#${i + 1} ${r.label}`,
   color: r.color,
   value: r.score,
   max: 100,
   displayVal: `${r.score.toFixed(1)}%`,
}));
svg += barPanel(PAD.left, rankY, WIDE_W, 'Overall Ranking', 'quality 25% · toolcalling 20% · max-ctx 30% · speed 25%', rankItems);

// ── 4-metric grid (2×2) ────────────────────────────────────────────────────────
const METRIC_PANELS = [
   {
      key: 'maxctx',
      title: 'Max Context (tokens, coherence-verified)',
      weight: '30%',
      getValue: (m) => m.maxctx,
      formatVal: (v) => (v != null ? (v >= 1000 ? `${(v / 1000).toFixed(0)}k` : String(v)) : '?'),
      getMax: () => maxCtx,
   },
   {
      key: 'speed',
      title: 'Decode Speed (tok/s)',
      weight: '25%',
      getValue: (m) => m.speedTg,
      formatVal: (v) => (v != null ? `${v.toFixed(0)} t/s` : '?'),
      getMax: () => maxSpeed,
   },
   {
      key: 'quality',
      title: 'Quality (triage+summ+docqa blend /100)',
      weight: '25%',
      getValue: (m) => m.qual,
      formatVal: (v) => (v != null ? `${v.toFixed(1)}` : '?'),
      getMax: () => 100,
   },
   {
      key: 'toolcall',
      title: 'Tool-call Accuracy',
      weight: '20%',
      getValue: (m) => m.toolcall,
      formatVal: (v) => (v != null ? `${v.toFixed(1)}%` : 'n/a'),
      getMax: () => 100,
   },
];

const gridStartY = rankY + TITLE_H + N * ROW_H + 8 + 28;
METRIC_PANELS.forEach((panel, pi) => {
   const col = pi % 2;
   const row = Math.floor(pi / 2);
   const px = PAD.left + col * (COL_W + COL_GAP + 16);
   const py = gridStartY + row * (TITLE_H + PANEL_H + 28);
   const max = panel.getMax();
   const items = models.map((m) => ({
      label: m.label,
      color: m.color,
      value: panel.getValue(m) ?? 0,
      max,
      displayVal: panel.formatVal(panel.getValue(m)),
   }));
   svg += barPanel(px, py, COL_W, panel.title, `weight ${panel.weight}`, items);
});

// ── Score Breakdown Table ──────────────────────────────────────────────────────
const tableY = gridStartY + GRID_H + 12;
svg += rect(PAD.left, tableY, WIDE_W, TABLE_H, PANEL, 10);
svg += svgText(PAD.left + 12, tableY + 20, 'Score Breakdown', { fill: '#a0a0c0', size: 11, weight: '600' });

const COLS = [
   { label: '#', x: 0, w: 22 },
   { label: 'Model', x: 38, w: 190 },
   { label: 'MaxCtx', x: 234, w: 65 },
   { label: 'Speed', x: 302, w: 55 },
   { label: 'Quality', x: 360, w: 55 },
   { label: 'Tools', x: 418, w: 48 },
   { label: 'Score', x: 470, w: 55 },
];
const tx0 = PAD.left + 12;
const tRowH = 22;
const tHdrY = tableY + 36;

svg += rect(PAD.left, tHdrY - 12, WIDE_W, 1, '#2a2a38');
for (const c of COLS) {
   svg += svgText(tx0 + c.x, tHdrY, c.label, { fill: DIM, size: 10 });
}
svg += rect(PAD.left, tHdrY + 4, WIDE_W, 1, '#2a2a38');

ranked.forEach((m, rank) => {
   const ty = tHdrY + 8 + (rank + 1) * tRowH;
   if (rank % 2 === 1) {
      svg += rect(PAD.left, ty - 14, WIDE_W, tRowH, '#1e1e2a', 0, 0.5);
   }

   svg += rect(tx0 + COLS[1].x - 2, ty - 9, 9, 9, m.color, 2);
   svg += svgText(tx0 + COLS[1].x + 12, ty, m.label, { fill: TEXT, size: 10 });

   const ctxStr = m.maxctx != null ? (m.maxctx >= 1000 ? `${Math.round(m.maxctx / 1000)}k` : String(m.maxctx)) : '?';
   const spdStr = m.speedTg != null ? `${m.speedTg.toFixed(0)} t/s` : '?';
   const qualStr = m.qual != null ? m.qual.toFixed(1) : '?';
   const toolStr = m.toolcall != null ? `${m.toolcall.toFixed(0)}%` : 'n/a';

   const vals = [
      { col: COLS[0], v: String(rank + 1), fill: '#777' },
      { col: COLS[2], v: ctxStr, fill: m.maxctx && m.maxctx >= maxCtx * 0.9 ? ACCENT : TEXT },
      { col: COLS[3], v: spdStr, fill: TEXT },
      { col: COLS[4], v: qualStr, fill: TEXT },
      { col: COLS[5], v: toolStr, fill: TEXT },
      { col: COLS[6], v: `${m.score.toFixed(1)}%`, fill: ACCENT, weight: '700' },
   ];
   for (const { col, v, fill, weight } of vals) {
      svg += svgText(tx0 + col.x, ty, v, { fill, size: 10, weight: weight ?? 'normal' });
   }
   svg += rect(PAD.left, ty + 8, WIDE_W, 1, '#1e1e2a');
});

svg += '</svg>';

writeFileSync(flags.output, svg, 'utf-8');
console.log(`Chart written: ${flags.output}  (${(svg.length / 1024).toFixed(1)} KB, ${models.length} models)`);
