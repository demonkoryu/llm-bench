#!/usr/bin/env node
/**
 * Data-driven SVG chart renderer for llm-bench results.
 *
 * Reads one or more runs and renders:
 *   1. Overall weighted ranking (multiplicative; see SCORING in results-store.mjs)
 *   2. Per-metric bar panels (throughput, TTFT latency, max context, triage, toolcalling, docqa, summarization)
 *   3. Score breakdown table
 *
 * Usage:
 *   node runners/render-chart.mjs
 *   node runners/render-chart.mjs --input <run-id> --output results/chart.svg
 *
 * Output: results/chart.svg (+ a PNG alongside it, best-effort via sharp, since
 *         many viewers render PNG inline but not SVG)
 */

import { writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseArgs } from 'node:util';
import { aggregateModels, CARD_TOTAL_MIB, loadCapabilities, loadRuns, mergeResultRows, SCORING } from '../shared/results-store.mjs';

const __dir = dirname(fileURLToPath(import.meta.url));
const ROOT = join(__dir, '..');
const RESULTS_DIR = join(ROOT, 'results');

const { values: flags } = parseArgs({
   options: {
      input: { type: 'string', multiple: true },
      output: { type: 'string', default: join(RESULTS_DIR, 'chart.svg') },
   },
});

// ── Read & aggregate ────────────────────────────────────────────────────────────
// Accepts one or more --input (run id | run dir | run.json); rows are merged by
// ts/status so input order is irrelevant (a base run + a catch-up run chart the
// same either way). With no --input, the newest run is used.
const runs = loadRuns(RESULTS_DIR, flags.input);
if (!runs.length) {
   console.error('No runs found. Run the benchmark first, or pass --input <run-id>.');
   process.exit(0);
}
const { models, ranking, maxCtx } = aggregateModels(mergeResultRows(runs.flatMap((r) => r.results)));
const CAPS = loadCapabilities(join(ROOT, 'config/models.yaml'));

if (!models.length) {
   console.error('No completed model results found. Run the benchmark first.');
   process.exit(0);
}

// Panel scale for the directly-measured end-to-end throughput panel (mean across depths).
const maxE2E = Math.max(...models.map((m) => m.e2eThroughput ?? 0), 1);
// Free VRAM at max ctx = CARD_TOTAL_MIB − used; high = model/coherence-bound, low
// = VRAM-bound. CARD_TOTAL_MIB is the single source in results-store.mjs.
const vramFree = (m) => (m.maxctxVram != null ? CARD_TOTAL_MIB - m.maxctxVram : null);
const maxFreeVram = Math.max(...models.map((m) => vramFree(m) ?? 0), 1);
// Decode-speed degradation under context load.
const maxRetention = Math.max(...models.map((m) => m.decodeRetentionPct ?? 0), 100);
const maxPowerEff = Math.max(...models.map((m) => m.powerEff ?? 0), 0.1);

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

// Flag the top-5 overall finishers with a 5-star rank badge drawn next to their
// bar in every per-metric panel: rank 1 = 5 gold stars, rank 5 = 1 gold + 4 grey.
// So you can spot a winner (and how high it placed overall) across all metrics at
// a glance. rankIdx lives on the shared model objects, seen by every panel.
const MARKER_FILL = '#ffd54a'; // gold — stars earned by rank
const MARKER_DIM = '#4a4a57'; // grey — stars not earned
ranked.slice(0, 5).forEach((m, i) => {
   m.rankIdx = i; // 0-based overall rank; gold stars = 5 - rankIdx
});

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

const GRID_PANELS = 13; // one per metric panel; asserted == METRIC_PANELS.length after the array
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

// 5-star overall-rank badge: `earned` gold stars (gold = high rank), the rest
// greyed. Drawn on a dark pill (right-aligned at rightX) so it reads over any bar.
function starBadge(rightX, midY, earned) {
   const N = 5;
   const step = 9;
   const padX = 5;
   const w = N * step + padX * 2 - 2;
   const x0 = rightX - w;
   let s = rect(x0, midY - 8, w, 16, '#0a0a0e', 4, 0.82);
   for (let k = 0; k < N; k++) {
      s += svgText(x0 + padX + k * step, midY + 4, '★', { fill: k < earned ? MARKER_FILL : MARKER_DIM, size: 11 });
   }
   return s;
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
      const isTop = item.rankIdx != null;
      s += svgText(x + 10, barY + 13, item.label, { fill: isTop ? '#ffffff' : TEXT, size: 10, weight: isTop ? '700' : 'normal' });
      s += rect(bx, barY, trackW, BAR_H, TRACK, 3);
      s += `<rect x="${bx}" y="${barY}" width="${Math.max(0, pct)}" height="${BAR_H}" fill="${item.color}" rx="3"/>`;
      s += svgText(bx + 6, barY + 13, item.displayVal, { fill: 'rgba(255,255,255,0.9)', size: 10, weight: '600' });
      // Top-5 overall finishers get a 5-star rank badge at the bar's right end.
      if (isTop) {
         s += starBadge(bx + trackW - 2, barY + BAR_H / 2, 5 - item.rankIdx);
      }
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
// Subtitle is derived from the SCORING export so it can never drift from the code.
const restLabels = {
   reasoning: 'reasoning',
   triage: 'triage',
   summarization: 'summ',
   docqa: 'docqa',
   performance: 'perf',
   degradation: 'degrade',
};
const restStr = Object.entries(SCORING.rest_weights)
   .map(([k, w]) => `${restLabels[k] ?? k} ${w.toFixed(2).replace(/^0/, '')}`)
   .join(' · ');
const scoreSubtitle = `score = coding × toolcalling × struct-output × maxctx% × Σ(${restStr})`;
svg += barPanel(PAD.left, rankY, WIDE_W, 'Overall Ranking', scoreSubtitle, rankItems);

// ── Per-metric grid (one panel per scored metric — no blending) ──────────────────
const METRIC_PANELS = [
   // ── Rest axes (additive weighted sum, weights sum to 1.0) ──
   {
      title: 'Reasoning accuracy',
      weight: '×0.20 (rest)',
      getValue: (m) => m.reasoning,
      formatVal: (v) => (v != null ? `${v.toFixed(0)}%` : '–'),
      getMax: () => 100,
   },
   {
      title: 'Triage score (/100)',
      weight: '×0.18 (rest)',
      getValue: (m) => m.triage,
      formatVal: (v) => (v != null ? v.toFixed(0) : '–'),
      getMax: () => 100,
   },
   {
      title: 'Summarization score (/100)',
      weight: '×0.16 (rest)',
      getValue: (m) => m.summ,
      formatVal: (v) => (v != null ? v.toFixed(0) : '–'),
      getMax: () => 100,
   },
   {
      title: 'DocQA comprehension (/10)',
      weight: '×0.13 (rest)',
      getValue: (m) => m.docqa,
      formatVal: (v) => (v != null ? v.toFixed(1) : '–'),
      getMax: () => 10,
   },
   {
      title: 'End-to-end throughput — measured (tok/s)',
      weight: '×0.25 perf · 40%',
      getValue: (m) => m.e2eThroughput,
      formatVal: (v) => (v != null ? `${v.toFixed(0)} t/s` : '?'),
      getMax: () => maxE2E,
   },
   {
      // Latency half of the performance axis. Bar length is fleet-relative (fleet-
      // fastest = 100) so longer bar = faster — keeps the chart's higher-is-better
      // invariant and the top-5 badge correct — but the LABEL shows the absolute
      // TTFT@8k in seconds (formatVal gets the model, not just the bar value).
      title: 'First-token latency @8k (s · longer=faster)',
      weight: '×0.25 perf · 60%',
      getValue: (m) => (m.latencyNorm != null ? m.latencyNorm * 100 : null),
      formatVal: (_v, m) => (m.ttft8kMs != null ? `${(m.ttft8kMs / 1000).toFixed(2)}s` : '?'),
      getMax: () => 100,
   },
   {
      title: 'Decode retention @ ~32k ctx (% of base)',
      weight: '×0.08 (rest)',
      getValue: (m) => m.decodeRetentionPct,
      formatVal: (v) => (v != null ? `${v.toFixed(0)}%` : '?'),
      getMax: () => maxRetention,
   },
   // ── Hard gates (0 → total score 0) ──
   {
      title: 'Coding grade (no_think: .3·easy + .7·hard)',
      weight: '×gate (norm)',
      getValue: (m) => m.codingGrade,
      formatVal: (v) => (v != null ? v.toFixed(0) : 'n/a'),
      getMax: () => 100,
   },
   {
      title: 'Tool-call accuracy',
      weight: '×gate',
      getValue: (m) => m.toolcall,
      formatVal: (v) => (v != null ? `${v.toFixed(0)}%` : 'n/a'),
      getMax: () => 100,
   },
   {
      title: 'Structured-output reliability (schema-conformant %)',
      weight: '×gate',
      getValue: (m) => m.structScore,
      formatVal: (v) => (v != null ? `${v.toFixed(0)}%` : '?'),
      getMax: () => 100,
   },
   // ── Context amplifier (% of fleet best) ──
   {
      title: 'Max Context (tokens, coherence-verified)',
      weight: '×amp',
      getValue: (m) => m.maxctx,
      formatVal: (v) => (v != null ? (v >= 1000 ? `${(v / 1000).toFixed(0)}k` : String(v)) : '?'),
      getMax: () => maxCtx,
   },
   // ── Reported-only (not in the score) ──
   {
      title: 'Free VRAM at max ctx (headroom)',
      weight: 'reported',
      getValue: (m) => vramFree(m),
      formatVal: (v) => (v != null ? `${(v / 1024).toFixed(1)} GB` : '?'),
      getMax: () => maxFreeVram,
   },
   {
      title: 'Power efficiency (decode tok/s per watt)',
      weight: 'reported',
      getValue: (m) => m.powerEff,
      formatVal: (v) => (v != null ? `${v.toFixed(2)} t/s/W` : '?'),
      getMax: () => maxPowerEff,
   },
];

// GRID_PANELS (used above to size the canvas) must match the panel count. It can't
// reference METRIC_PANELS.length there (declared later), so catch drift loudly here
// rather than silently clipping panels or leaving dead canvas space.
if (METRIC_PANELS.length !== GRID_PANELS) {
   throw new Error(`GRID_PANELS (${GRID_PANELS}) must equal METRIC_PANELS.length (${METRIC_PANELS.length})`);
}

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
         displayVal: panel.formatVal(raw, m),
         rankIdx: m.rankIdx,
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
