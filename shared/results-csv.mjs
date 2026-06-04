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
import yaml from 'js-yaml';

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

// Per-metric weights (sum = 1.0). Context capacity is weighted heavily (0.30) —
// long usable windows are a top priority for this PKM/docQA use case — with task
// quality at 0.55 across the five capability benches and decode speed at 0.15.
// The weighted score uses a FIXED denominator (see finalScore): a metric a model
// didn't run contributes 0, so breadth of capability counts and a narrow model
// can't top the ranking by being scored on fewer axes.
//   maxctx 30 · reasoning 15 · docqa 12 · triage 10 · toolcalling 10 · summarization 8  · speed 15
export const DEFAULT_WEIGHTS = {
   maxctx: 0.3,
   reasoning: 0.15,
   docqa: 0.12,
   triage: 0.1,
   toolcalling: 0.1,
   summarization: 0.08,
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
 * Load declared model capabilities from config/models.yaml, keyed by base id
 * (hf_file minus .gguf — matches aggregateModels' base_model). Lets the report
 * distinguish "n/a (capability not supported)" from "– (capable but unmeasured)".
 * Returns Map<baseId, { tools: boolean, note: string|null }>.
 */
export function loadCapabilities(modelsYamlPath) {
   const caps = new Map();
   try {
      const cfg = yaml.load(readFileSync(modelsYamlPath, 'utf8'));
      for (const m of cfg.models ?? []) {
         const base = String(m.hf_file ?? '').replace(/\.gguf$/i, '');
         if (base) {
            caps.set(base, { tools: m.tools === true, note: m.capability_note ?? null });
         }
      }
   } catch {
      /* no capabilities available */
   }
   return caps;
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
   const maxctxVramByModel = new Map(); // VRAM (MiB) used at the coherence ceiling
   // Decode-decay rows are recorded once per base model (think='n/a'); collect
   // them by base model so they attach to every think variant (like maxctx) and
   // don't spawn phantom 'n/a' model groups.
   const decayByModel = new Map(); // base model → Map(depth → decode tok/s, newest wins)
   const pargenByModel = new Map(); // base model → Map(concurrency → aggregate tok/s)
   for (const r of data) {
      if (String(r.bench).startsWith('speed_pargen-')) {
         const k = Number(r.bench.replace('speed_pargen-', ''));
         const tps = parseFloat(r.score);
         if (Number.isFinite(k) && Number.isFinite(tps)) {
            if (!pargenByModel.has(baseModel(r.model))) pargenByModel.set(baseModel(r.model), new Map());
            pargenByModel.get(baseModel(r.model)).set(k, tps); // later row wins
         }
      }
      if (r.bench === 'maxctx') {
         const v = parseFloat(r.score);
         if (Number.isFinite(v)) {
            maxctxByModel.set(baseModel(r.model), v);
         }
         const vram = parseFloat(r.vram_mib);
         if (Number.isFinite(vram)) {
            maxctxVramByModel.set(baseModel(r.model), vram);
         }
      } else if (String(r.bench).startsWith('speed_decay-')) {
         const depth = Number(r.bench.replace('speed_decay-', '').replace('k', '')) * 1024;
         const dec = parseFloat(r.score);
         if (Number.isFinite(dec)) {
            if (!decayByModel.has(baseModel(r.model))) decayByModel.set(baseModel(r.model), new Map());
            decayByModel.get(baseModel(r.model)).set(depth, dec); // later row wins
         }
      }
   }

   const modelMap = new Map();
   for (const r of data) {
      if (r.bench === 'maxctx' || String(r.bench).startsWith('speed_decay-') || String(r.bench).startsWith('speed_pargen-')) {
         continue;
      }
      const key = `${r.model}|${r.think}`;
      if (!modelMap.has(key)) {
         modelMap.set(key, { model: r.model, think: r.think, rows: [] });
      }
      modelMap.get(key).rows.push(r);
   }

   // Newest row wins: a re-run supersedes the prior value for the same
   // model/think/bench, regardless of whether it's higher or lower. `rs` is in
   // CSV append order (chronological), and error rows were filtered out above,
   // so the last finite score is the most recent successful measurement. This
   // matches maxctxByModel's last-write-wins and build-report's merge dedup.
   const latestScore = (rs, bench) => {
      const m = rs
         .filter((r) => r.bench === bench)
         .map((r) => parseFloat(r.score))
         .filter(Number.isFinite);
      return m.length ? m[m.length - 1] : null;
   };

   const models = [...modelMap.values()]
      .map(({ model, think, rows: rs }) => {
         const maxctx = maxctxByModel.get(baseModel(model)) ?? null;
         const maxctxVram = maxctxVramByModel.get(baseModel(model)) ?? null; // VRAM used (MiB) at max ctx
         const triage = latestScore(rs, 'triage');
         const reasoning = latestScore(rs, 'reasoning');
         const toolcall = latestScore(rs, 'toolcalling');
         const summ = latestScore(rs, 'summarization');
         const docqa = latestScore(rs, 'docqa');
         // max() here combines DISTINCT metrics (short vs long-ctx decode) into a
         // headline tok/s — not a dedup; each component is already newest-wins.
         const speedTg =
            Math.max(latestScore(rs, 'speed_short') ?? 0, latestScore(rs, 'speed_long-32k') ?? 0, latestScore(rs, 'speed') ?? 0) ||
            null;
         // Real prefill throughput (prompt processing) from large-prompt probes —
         // newest value of the prefill_tps column for each probe bench.
         const latestField = (bench, field) => {
            const m = rs
               .filter((r) => r.bench === bench)
               .map((r) => parseFloat(r[field]))
               .filter(Number.isFinite);
            return m.length ? m[m.length - 1] : null;
         };
         const prefill4k = latestField('speed_prefill-4k', 'prefill_tps');
         const prefill12k = latestField('speed_prefill-12k', 'prefill_tps');
         // End-to-end throughput for a representative request: P-token prompt +
         // 512 generated tokens. time = P/prefill + 512/decode; total = (P+512)/time.
         const endToEnd = (P, pf) => (pf && speedTg ? (P + 512) / (P / pf + 512 / speedTg) : null);
         const total4k = endToEnd(4096, prefill4k);
         const total12k = endToEnd(12288, prefill12k);
         // Decode-speed degradation under context load: decode tok/s at depths,
         // shared across think variants (measured once per base model, think-independent).
         // Reference = the deepest measured depth ≤ 32k for cross-model comparison.
         const decayMap = decayByModel.get(baseModel(model));
         const decayCurve = decayMap
            ? [...decayMap.entries()].map(([depth, dec]) => ({ depth, decode: dec })).sort((a, b) => a.depth - b.depth)
            : [];
         const decodeBase = decayMap?.get(0) ?? null;
         const refPt = [...decayCurve].filter((x) => x.depth > 0 && x.depth <= 32768).pop() ?? null;
         const decodeRef = refPt?.decode ?? null;
         const decodeRefDepth = refPt?.depth ?? null;
         const decodeRetentionPct = decodeBase && decodeRef ? Math.round((decodeRef / decodeBase) * 100) : null;
         // Parallel-generation throughput: aggregate tok/s at K concurrent slots,
         // shared across think variants (measured once per base model).
         const pgMap = pargenByModel.get(baseModel(model));
         const pargenCurve = pgMap ? [...pgMap.entries()].map(([conc, tps]) => ({ conc, tps })).sort((a, b) => a.conc - b.conc) : [];
         const pargen1 = pgMap?.get(1) ?? null;
         const pargenMaxK = pargenCurve.length ? pargenCurve[pargenCurve.length - 1].conc : null;
         const pargenAggMax = pargenCurve.length ? pargenCurve[pargenCurve.length - 1].tps : null;
         const pargenSpeedup = pargen1 && pargenAggMax ? Math.round((pargenAggMax / pargen1) * 100) / 100 : null;
         return {
            label: `${model}${think !== 'n/a' ? ` [${think}]` : ''}`,
            model,
            base_model: baseModel(model),
            think,
            maxctx,
            maxctxVram,
            triage,
            reasoning,
            toolcall,
            summ,
            docqa,
            speedTg,
            prefill4k,
            prefill12k,
            total4k,
            total12k,
            decayCurve,
            decodeBase,
            decodeRef,
            decodeRefDepth,
            decodeRetentionPct,
            pargenCurve,
            pargen1,
            pargenAggMax,
            pargenMaxK,
            pargenSpeedup,
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
