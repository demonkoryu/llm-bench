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
 * Output: results/chart.svg (+ a PNG alongside it, best-effort via sharp, since
 *         many viewers render PNG inline but not SVG)
 */

import { existsSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseArgs } from 'node:util';
import { aggregateModels, latestResultsFile, loadCapabilities, readTable } from '../shared/results-csv.mjs';

const __dir = dirname(fileURLToPath(import.meta.url));
const ROOT = join(__dir, '..');
const RESULTS_DIR = join(ROOT, 'results');

const { values: flags } = parseArgs({
   options: {
      input: { type: 'string' },
      output: { type: 'string', default: join(RESULTS_DIR, 'chart.svg') },
   },
});

// ── Read & aggregate ────────────────────────────────────────────────────────────
const inputPath = flags.input ?? latestResultsFile(RESULTS_DIR);
if (!existsSync(inputPath)) {
   console.error(`Results file not found: ${inputPath}`);
   process.exit(1);
}
const { models, ranking, maxCtx, maxSpeed } = aggregateModels(readTable(inputPath));
const CAPS = loadCapabilities(join(ROOT, 'config/models.yaml'));

if (!models.length) {
   console.error('No completed model results found. Run the benchmark first.');
   process.exit(0);
}

// Panel scales for the new speed metrics (prefill + end-to-end total).
const maxPrefill = Math.max(...models.map((m) => Math.max(m.prefill4k ?? 0, m.prefill12k ?? 0)), 1);
const maxTotal = Math.max(...models.map((m) => Math.max(m.total4k ?? 0, m.total12k ?? 0)), 1);
// Usable VRAM on the benchmark card (RX 7900 XT; see config/hosts.yaml). Free
// VRAM at max ctx = this − used; high = model/coherence-bound, low = VRAM-bound.
const CARD_TOTAL_MIB = 20464;
const vramFree = (m) => (m.maxctxVram != null ? CARD_TOTAL_MIB - m.maxctxVram : null);
// Decode-speed degradation under context load.
const maxDecodeRef = Math.max(...models.map((m) => m.decodeRef ?? 0), 1);
const maxRetention = Math.max(...models.map((m) => m.decodeRetentionPct ?? 0), 100);

// Colors are presentation-only; assign per model after aggregation.
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
   m.color = COLORS[i % COLORS.length];
});
const ranked = ranking;

// ── SVG constants ─────────────────────────────────────────────────────────────
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

const GRID_PANELS = 14; // one per metric panel (must match METRIC_PANELS.length below)
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
svg += barPanel(
   PAD.left,
   rankY,
   WIDE_W,
   'Overall Ranking',
   'max-ctx 30% · reasoning 15% · docqa 12% · triage 10% · toolcalling 10% · summarization 8% · speed 15%',
   rankItems,
);

// ── Per-metric grid (one panel per scored metric — no blending) ──────────────────
const METRIC_PANELS = [
   {
      title: 'Reasoning accuracy',
      weight: '15%',
      getValue: (m) => m.reasoning,
      formatVal: (v) => (v != null ? `${v.toFixed(0)}%` : '–'),
      getMax: () => 100,
   },
   {
      title: 'Triage score (/100)',
      weight: '10%',
      getValue: (m) => m.triage,
      formatVal: (v) => (v != null ? v.toFixed(0) : '–'),
      getMax: () => 100,
   },
   {
      title: 'Tool-call accuracy',
      weight: '10%',
      getValue: (m) => m.toolcall,
      formatVal: (v) => (v != null ? `${v.toFixed(0)}%` : 'n/a'),
      getMax: () => 100,
   },
   {
      title: 'DocQA comprehension (/10)',
      weight: '12%',
      getValue: (m) => m.docqa,
      formatVal: (v) => (v != null ? v.toFixed(1) : '–'),
      getMax: () => 10,
   },
   {
      title: 'Summarization score (/100)',
      weight: '8%',
      getValue: (m) => m.summ,
      formatVal: (v) => (v != null ? v.toFixed(0) : '–'),
      getMax: () => 100,
   },
   {
      title: 'Max Context (tokens, coherence-verified)',
      weight: '30%',
      getValue: (m) => m.maxctx,
      formatVal: (v) => (v != null ? (v >= 1000 ? `${(v / 1000).toFixed(0)}k` : String(v)) : '?'),
      getMax: () => maxCtx,
   },
   {
      title: 'Generation / Decode Speed (tok/s)',
      weight: '15%',
      getValue: (m) => m.speedTg,
      formatVal: (v) => (v != null ? `${v.toFixed(0)} t/s` : '?'),
      getMax: () => maxSpeed,
   },
   {
      title: 'Prefill Speed — 4k prompt (tok/s)',
      weight: '—',
      getValue: (m) => m.prefill4k,
      formatVal: (v) => (v != null ? `${v.toFixed(0)} t/s` : '?'),
      getMax: () => maxPrefill,
   },
   {
      title: 'Prefill Speed — 12k prompt (tok/s)',
      weight: '—',
      getValue: (m) => m.prefill12k,
      formatVal: (v) => (v != null ? `${v.toFixed(0)} t/s` : '?'),
      getMax: () => maxPrefill,
   },
   {
      title: 'Total / End-to-End — 4k+512 (tok/s)',
      weight: '—',
      getValue: (m) => m.total4k,
      formatVal: (v) => (v != null ? `${v.toFixed(0)} t/s` : '?'),
      getMax: () => maxTotal,
   },
   {
      title: 'Total / End-to-End — 12k+512 (tok/s)',
      weight: '—',
      getValue: (m) => m.total12k,
      formatVal: (v) => (v != null ? `${v.toFixed(0)} t/s` : '?'),
      getMax: () => maxTotal,
   },
   {
      title: 'Free VRAM at max ctx (MiB)',
      weight: 'headroom',
      getValue: (m) => vramFree(m),
      formatVal: (v) => (v != null ? `${(v / 1024).toFixed(1)} GB` : '?'),
      getMax: () => CARD_TOTAL_MIB,
   },
   {
      title: 'Decode @ ~32k ctx (tok/s) — under load',
      weight: 'degrade',
      getValue: (m) => m.decodeRef,
      formatVal: (v) => (v != null ? `${v.toFixed(0)} t/s` : '?'),
      getMax: () => maxDecodeRef,
   },
   {
      title: 'Decode retention @ ~32k ctx (% of base)',
      weight: 'degrade',
      getValue: (m) => m.decodeRetentionPct,
      formatVal: (v) => (v != null ? `${v.toFixed(0)}%` : '?'),
      getMax: () => maxRetention,
   },
];

const gridStartY = rankY + TITLE_H + N * ROW_H + 8 + 28;
METRIC_PANELS.forEach((panel, pi) => {
   const col = pi % 2;
   const row = Math.floor(pi / 2);
   const px = PAD.left + col * (COL_W + COL_GAP + 16);
   const py = gridStartY + row * (TITLE_H + PANEL_H + 28);
   const max = panel.getMax();
   const items = models
      // Each category panel is its own leaderboard: sort by this metric's score,
      // descending. Models that didn't run the metric (null) sink to the bottom.
      .map((m) => ({ m, raw: panel.getValue(m) }))
      .sort((a, b) => (b.raw ?? -Infinity) - (a.raw ?? -Infinity))
      .map(({ m, raw }) => ({
         label: m.label,
         color: m.color,
         value: raw ?? 0,
         max,
         displayVal: panel.formatVal(raw),
      }));
   svg += barPanel(px, py, COL_W, panel.title, `weight ${panel.weight}`, items);
});

// ── Score Breakdown Table ──────────────────────────────────────────────────────
const tableY = gridStartY + GRID_H + 12;
svg += rect(PAD.left, tableY, WIDE_W, TABLE_H, PANEL, 10);
svg += svgText(PAD.left + 12, tableY + 20, 'Score Breakdown', { fill: '#a0a0c0', size: 11, weight: '600' });

// Individual metric columns — no blended "quality". Each shows the achieved score.
const COLS = [
   { label: '#', x: 0 },
   { label: 'Model', x: 28 },
   { label: 'Reason', x: 320 },
   { label: 'Triage', x: 374 },
   { label: 'Tools', x: 428 },
   { label: 'DocQA', x: 482 },
   { label: 'Summ', x: 536 },
   { label: 'MaxCtx', x: 590 },
   { label: 'Speed', x: 650 },
   { label: 'Score', x: 712 },
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

   const num = (v, suffix = '', d = 0) => (v != null ? v.toFixed(d) + suffix : '–');
   const ctxStr = m.maxctx != null ? (m.maxctx >= 1000 ? `${Math.round(m.maxctx / 1000)}k` : String(m.maxctx)) : '?';

   const vals = [
      { col: COLS[0], v: String(rank + 1), fill: '#777' },
      { col: COLS[2], v: num(m.reasoning), fill: TEXT },
      { col: COLS[3], v: num(m.triage), fill: TEXT },
      {
         col: COLS[4],
         // n/a = capability not supported; – = capable but not measured
         v: m.toolcall != null ? num(m.toolcall, '%') : (CAPS.get(m.base_model)?.tools ?? true) ? '–' : 'n/a',
         fill: m.toolcall != null ? TEXT : DIM,
      },
      { col: COLS[5], v: num(m.docqa, '', 1), fill: TEXT },
      { col: COLS[6], v: num(m.summ), fill: TEXT },
      { col: COLS[7], v: ctxStr, fill: m.maxctx && m.maxctx >= maxCtx * 0.9 ? ACCENT : TEXT },
      { col: COLS[8], v: m.speedTg != null ? `${m.speedTg.toFixed(0)}t/s` : '?', fill: TEXT },
      { col: COLS[9], v: `${m.score.toFixed(1)}%`, fill: ACCENT, weight: '700' },
   ];
   for (const { col, v, fill, weight, size } of vals) {
      svg += svgText(tx0 + col.x, ty, v, { fill, size: size ?? 10, weight: weight ?? 'normal' });
   }
   svg += rect(PAD.left, ty + 8, WIDE_W, 1, '#1e1e2a');
});

svg += '</svg>';

writeFileSync(flags.output, svg, 'utf-8');
console.log(`Chart written: ${flags.output}  (${(svg.length / 1024).toFixed(1)} KB, ${models.length} models)`);

// Also emit a PNG alongside the SVG — many viewers render PNG inline but not SVG.
// Best-effort: skip silently if sharp isn't installed (it's not a hard dependency).
const pngPath = flags.output.endsWith('.svg') ? flags.output.replace(/\.svg$/, '.png') : `${flags.output}.png`;
try {
   const sharp = (await import('sharp')).default;
   await sharp(Buffer.from(svg), { density: 150 }).png().toFile(pngPath);
   console.log(`Chart PNG:     ${pngPath}`);
} catch (e) {
   console.warn(`(PNG export skipped: ${e.message.slice(0, 80)})`);
}
