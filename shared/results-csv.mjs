/**
 * Reporting core for llm-bench: the CSV result format + the aggregation that
 * turns raw per-bench rows into ranked model summaries.
 *
 * One run writes rows during execution to a self-describing file named
 *   llm-benchmarks-<host>-<gpu>-<backend>-<YYYYMMDD-HHMMSS>.csv
 * Follow-up runs can append to an existing CSV (run-suite --out).
 *
 * Consumers: run-suite (write + resume-read), build-report (→ report.json),
 * render-chart (→ chart.svg), results-to-md (→ report.md), judge-merge (rewrite).
 * All read via readTable(), which auto-detects tab vs comma so the legacy
 * results.tsv still parses during the transition.
 */

import { appendFileSync, existsSync, readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

/** Canonical column order. Header-driven readers tolerate extra columns (e.g. judge_score). */
export const COLUMNS = [
   'target',
   'backend',
   'model',
   'think',
   'bench',
   'score',
   'halls',
   'json_fail',
   'tok_s',
   'prefill_tps',
   'vram_mib',
   'ctx_loaded',
   'oom_ceiling',
   'coherence_ceiling',
   'status',
   'wall_s',
   'notes',
];

// Per-metric weights (sum = 1.0). Task quality dominates (0.75 across the five
// capability benches) since a fast model with a huge context window but weak
// answers isn't useful; context capacity and decode speed are secondary. The
// weighted score uses a FIXED denominator (see finalScore): a metric a model
// didn't run contributes 0, so breadth of capability counts and a narrow model
// can't top the ranking by being scored on fewer axes.
//   reasoning 20 · triage 15 · toolcalling 15 · docqa 15 · summarization 10  (quality = 75)
//   maxctx 10 · speed 15
export const DEFAULT_WEIGHTS = {
   reasoning: 0.2,
   triage: 0.15,
   toolcalling: 0.15,
   docqa: 0.15,
   summarization: 0.1,
   maxctx: 0.1,
   speed: 0.15,
};

// ── Filename ─────────────────────────────────────────────────────────────────

/** Lowercase, strip everything but [a-z0-9] so the slug can't introduce extra '-' separators. */
export function slugify(s) {
   return String(s ?? '')
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, '');
}

const pad = (n) => String(n).padStart(2, '0');

/** Local YYYYMMDD-HHMMSS (NOT for use inside workflow scripts — new Date() is fine here). */
export function timestamp(date) {
   return (
      `${date.getFullYear()}${pad(date.getMonth() + 1)}${pad(date.getDate())}` +
      `-${pad(date.getHours())}${pad(date.getMinutes())}${pad(date.getSeconds())}`
   );
}

/** llm-benchmarks-rose-rx7900xt-vulkan-20260603-153012.csv */
export function csvFilename({ host, gpu, backend, date }) {
   return `llm-benchmarks-${slugify(host)}-${slugify(gpu)}-${slugify(backend)}-${timestamp(date)}.csv`;
}

/** Newest llm-benchmarks-*.csv in resultsDir, else the legacy results.tsv. */
export function latestResultsFile(resultsDir) {
   const csvs = existsSync(resultsDir)
      ? readdirSync(resultsDir)
           .filter((f) => f.startsWith('llm-benchmarks-') && f.endsWith('.csv'))
           .sort()
      : [];
   return csvs.length ? join(resultsDir, csvs[csvs.length - 1]) : join(resultsDir, 'results.tsv');
}

// ── CSV read / write ───────────────────────────────────────────────────────────

/** RFC-4180: quote when the field contains a comma, quote, or newline; double embedded quotes. */
export function csvEscape(v) {
   const s = v == null ? '' : String(v);
   return /[",\n\r]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
}

export function headerLine(columns = COLUMNS) {
   return columns.join(',');
}

export function formatRow(rowObj, columns = COLUMNS) {
   return columns.map((c) => csvEscape(rowObj[c] ?? '')).join(',');
}

/** Tokenize delimited text, honoring quoted fields (only meaningful for CSV). */
function parseDelimited(text, delim) {
   const rows = [];
   let row = [];
   let field = '';
   let inQuote = false;
   for (let i = 0; i < text.length; i++) {
      const ch = text[i];
      if (inQuote) {
         if (ch === '"') {
            if (text[i + 1] === '"') {
               field += '"';
               i++;
            } else {
               inQuote = false;
            }
         } else {
            field += ch;
         }
         continue;
      }
      if (ch === '"') {
         inQuote = true;
      } else if (ch === delim) {
         row.push(field);
         field = '';
      } else if (ch === '\n') {
         row.push(field);
         rows.push(row);
         row = [];
         field = '';
      } else if (ch !== '\r') {
         field += ch;
      }
   }
   if (field.length || row.length) {
      row.push(field);
      rows.push(row);
   }
   return rows;
}

/**
 * Read a results table into an array of row objects keyed by header.
 * Delimiter auto-detected: a tab in the header line → TSV, else CSV.
 */
export function readTable(path) {
   const text = readFileSync(path, 'utf8');
   if (!text.trim()) {
      return [];
   }
   const nl = text.indexOf('\n');
   const firstLine = nl < 0 ? text : text.slice(0, nl);
   const delim = firstLine.includes('\t') ? '\t' : ',';
   const rows = parseDelimited(text, delim).filter((r) => r.length > 1 || (r.length === 1 && r[0] !== ''));
   if (!rows.length) {
      return [];
   }
   const header = rows[0];
   return rows.slice(1).map((cells) => Object.fromEntries(header.map((h, i) => [h, cells[i] ?? ''])));
}

export function ensureHeader(path, columns = COLUMNS) {
   if (!existsSync(path)) {
      appendFileSync(path, `${headerLine(columns)}\n`);
   }
}

export function appendRow(path, rowObj, columns = COLUMNS) {
   appendFileSync(path, `${formatRow(rowObj, columns)}\n`);
}

// ── Aggregation ────────────────────────────────────────────────────────────────

/** Strip the hybrid think suffix to the canonical model id. */
export function baseModel(m) {
   return String(m).replace(/--(?:nothi|think)$/, '');
}

/**
 * Turn raw per-bench rows into ranked per-(model × think) summaries.
 *
 * maxctx is probed once per model (rows with bench='maxctx', think='-'); every
 * think variant inherits it via a base-model lookup. Sibling variants are tagged
 * maxctxSharedFrom so a renderer can show "same as <owner>" instead of a blank.
 *
 * @returns {{ models, ranking, maxCtx, maxSpeed, weights }}
 */
export function aggregateModels(rows, weights = DEFAULT_WEIGHTS) {
   const data = rows.filter((r) => r.status === 'ok' && r.bench !== 'load' && r.bench !== 'smoke');

   const maxctxByModel = new Map();
   for (const r of data) {
      if (r.bench === 'maxctx') {
         const v = parseFloat(r.score);
         if (Number.isFinite(v)) {
            maxctxByModel.set(baseModel(r.model), v);
         }
      }
   }

   const modelMap = new Map();
   for (const r of data) {
      if (r.bench === 'maxctx') {
         continue;
      }
      const key = `${r.model}|${r.think}`;
      if (!modelMap.has(key)) {
         modelMap.set(key, { model: r.model, think: r.think, rows: [] });
      }
      modelMap.get(key).rows.push(r);
   }

   const bestScore = (rs, bench) => {
      const m = rs
         .filter((r) => r.bench === bench)
         .map((r) => parseFloat(r.score))
         .filter(Number.isFinite);
      return m.length ? Math.max(...m) : null;
   };

   const models = [...modelMap.values()]
      .map(({ model, think, rows: rs }) => {
         const maxctx = maxctxByModel.get(baseModel(model)) ?? null;
         const triage = bestScore(rs, 'triage');
         const reasoning = bestScore(rs, 'reasoning');
         const toolcall = bestScore(rs, 'toolcalling');
         const summ = bestScore(rs, 'summarization');
         const docqa = bestScore(rs, 'docqa');
         const speedTg =
            Math.max(bestScore(rs, 'speed_short') ?? 0, bestScore(rs, 'speed_long-32k') ?? 0, bestScore(rs, 'speed') ?? 0) || null;
         return {
            label: `${model}${think !== 'n/a' ? ` [${think}]` : ''}`,
            model,
            base_model: baseModel(model),
            think,
            maxctx,
            triage,
            reasoning,
            toolcall,
            summ,
            docqa,
            speedTg,
         };
      })
      .filter((m) => m.maxctx || m.triage || m.speedTg);

   // Tag maxctx reuse across think variants of the same base model.
   const THINK_ORDER = { 'n/a': 0, no_think: 1, think: 2 };
   const byBase = new Map();
   for (const m of models) {
      if (!byBase.has(m.base_model)) {
         byBase.set(m.base_model, []);
      }
      byBase.get(m.base_model).push(m);
   }
   for (const variants of byBase.values()) {
      variants.sort((a, b) => (THINK_ORDER[a.think] ?? 9) - (THINK_ORDER[b.think] ?? 9));
      for (const v of variants) {
         v.maxctxSharedFrom = v === variants[0] ? null : variants[0].think;
      }
   }

   const maxCtx = Math.max(...models.map((m) => m.maxctx ?? 0)) || 1;
   const maxSpeed = Math.max(...models.map((m) => m.speedTg ?? 0)) || 1;

   // Normalize each weighted metric to 0-1. maxctx/speed are relative to the best
   // observed; the quality benches are absolute (triage/reasoning/toolcalling/summ
   // are 0-100, docqa is 0-10). Returns null when the model didn't run that metric.
   const NORMALIZE = {
      reasoning: (m) => (m.reasoning != null ? m.reasoning / 100 : null),
      triage: (m) => (m.triage != null ? m.triage / 100 : null),
      toolcalling: (m) => (m.toolcall != null ? m.toolcall / 100 : null),
      docqa: (m) => (m.docqa != null ? m.docqa / 10 : null),
      summarization: (m) => (m.summ != null ? m.summ / 100 : null),
      maxctx: (m) => (m.maxctx != null ? m.maxctx / maxCtx : null),
      speed: (m) => (m.speedTg != null ? m.speedTg / maxSpeed : null),
   };
   // Fixed denominator: a model earns a metric's weighted points only if it ran
   // that metric; a missing/failed metric contributes 0. This rewards breadth —
   // a model that can't tool-call or wasn't validated on a bench is genuinely a
   // less complete assistant, so it shouldn't out-rank a complete one by virtue
   // of being scored on fewer (easier) axes. The per-metric columns show the gaps.
   const finalScore = (m) => {
      let score = 0;
      for (const [metric, w] of Object.entries(weights)) {
         const v = NORMALIZE[metric]?.(m);
         if (v != null && Number.isFinite(v)) {
            score += w * v;
         }
      }
      return score;
   };
   for (const m of models) {
      m.score = Math.round(finalScore(m) * 1000) / 10;
   }
   const ranking = [...models].sort((a, b) => b.score - a.score);

   return { models, ranking, maxCtx, maxSpeed, weights };
}
