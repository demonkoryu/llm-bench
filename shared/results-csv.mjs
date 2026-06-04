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

// RX 7900 XT usable VRAM (MiB). Mirrors build-report.mjs / config/hosts.yaml.
// Used to turn "VRAM used at max ctx" into free headroom for the score's amplifier.
export const CARD_TOTAL_MIB = 20464;

// The composite score is MULTIPLICATIVE, not a flat weighted sum:
//
//   score = toolGate × structGate × ((maxctx% + vramHeadroom%) / 2) × restScore
//
//   • toolGate / structGate  — hard gates in 0..1 (accuracy/conformance as a fraction).
//                              Either at 0 (or absent) zeroes the whole score: a model
//                              that can't tool-call or can't emit valid structured
//                              output is unusable for this agentic use case.
//   • amplifier  — average of max-ctx and free-VRAM-headroom, each as a % of the
//                  fleet's best (0..1). Rewards long usable windows AND idle headroom.
//   • restScore  — additive weighted sum of the remaining capability axes (below),
//                  weights sum to 1.0, each normalized to 0..1.
//
// restScore keeps the FIXED-denominator rule: an axis a model didn't run contributes 0,
// so breadth counts and a narrow model can't win by being scored on fewer axes.
// DEFAULT_WEIGHTS holds ONLY the rest axes — toolcalling, struct_output, maxctx and
// vram are structural multipliers, not entries here.
//   reasoning 22 · triage 20 · summarization 18 · docqa 15 · speed 15 · degradation 10
export const DEFAULT_WEIGHTS = {
   reasoning: 0.22,
   triage: 0.2,
   summarization: 0.18,
   docqa: 0.15,
   speed: 0.15,
   degradation: 0.1,
};

// Self-describing scoring shape for report.json + the chart subtitle (so the
// displayed formula can never drift from the code).
export const SCORING = {
   formula: 'toolcalling × struct_output × (maxctx% + vram_headroom%)/2 × Σ(rest)',
   gates: ['toolcalling', 'struct_output'],
   amplifiers: ['maxctx', 'vram_headroom'],
   rest_weights: DEFAULT_WEIGHTS,
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
   const qualityByModel = new Map(); // base model → Map(depth → accuracy %)
   const ttftByModel = new Map(); // base model → Map(depth → prefill ms)
   const structByModel = new Map(); // base model → schema-conformance %
   const powerEffByModel = new Map(); // base model → decode tok/s per watt
   // Helper: set base→Map(key→val), later row wins.
   const setDepth = (map, base, key, val) => {
      if (!map.has(base)) map.set(base, new Map());
      map.get(base).set(key, val);
   };
   const depthOf = (bench, prefix) => Number(bench.replace(prefix, '').replace('k', '')) * 1024;
   for (const r of data) {
      const bench = String(r.bench);
      const v = parseFloat(r.score);
      if (bench.startsWith('speed_pargen-')) {
         if (Number.isFinite(v)) setDepth(pargenByModel, baseModel(r.model), Number(bench.replace('speed_pargen-', '')), v);
      } else if (bench.startsWith('quality_decay-')) {
         if (Number.isFinite(v)) setDepth(qualityByModel, baseModel(r.model), depthOf(bench, 'quality_decay-'), v);
      } else if (bench.startsWith('ttft-')) {
         if (Number.isFinite(v)) setDepth(ttftByModel, baseModel(r.model), depthOf(bench, 'ttft-'), v);
      } else if (bench === 'struct_output') {
         if (Number.isFinite(v)) structByModel.set(baseModel(r.model), v);
      } else if (bench === 'power_eff') {
         if (Number.isFinite(v)) powerEffByModel.set(baseModel(r.model), v);
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
      const b = String(r.bench);
      if (
         b === 'maxctx' ||
         b === 'struct_output' ||
         b === 'power_eff' ||
         b.startsWith('speed_decay-') ||
         b.startsWith('speed_pargen-') ||
         b.startsWith('quality_decay-') ||
         b.startsWith('ttft-')
      ) {
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
         // Single end-to-end throughput number that feeds the score's `speed` axis:
         // mean of the 4k/12k totals (whichever exist), falling back to raw decode.
         const e2e = [total4k, total12k].filter(Number.isFinite);
         const totalE2E = e2e.length ? e2e.reduce((a, b) => a + b, 0) / e2e.length : speedTg;
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
         // Quality-at-depth: accuracy of the fixed 6-needle block at each context
         // depth; retention = acc@ref ÷ acc@0 (ref = deepest measured ≤ 32k).
         const qMap = qualityByModel.get(baseModel(model));
         const qualityCurve = qMap ? [...qMap.entries()].map(([depth, acc]) => ({ depth, acc })).sort((a, b) => a.depth - b.depth) : [];
         const qualityBase = qMap?.get(0) ?? null;
         const qRef = [...qualityCurve].filter((x) => x.depth > 0 && x.depth <= 32768).pop() ?? null;
         const qualityRetentionPct = qualityBase && qRef?.acc != null ? Math.round((qRef.acc / qualityBase) * 100) : null;
         // TTFT (prefill latency, ms) at each depth — the latency an agent feels.
         const tMap = ttftByModel.get(baseModel(model));
         const ttftCurve = tMap ? [...tMap.entries()].map(([depth, ms]) => ({ depth, ms })).sort((a, b) => a.depth - b.depth) : [];
         const ttftRefPt = [...ttftCurve].filter((x) => x.depth > 0 && x.depth <= 32768).pop() ?? null;
         const ttftRefMs = ttftRefPt?.ms ?? null;
         // Structured-output reliability: % of JSON tasks that were schema-conformant.
         const structScore = structByModel.get(baseModel(model)) ?? null;
         // Power efficiency: decode tok/s per watt (board power via lm-sensors).
         const powerEff = powerEffByModel.get(baseModel(model)) ?? null;
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
            totalE2E,
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
            qualityCurve,
            qualityBase,
            qualityRetentionPct,
            ttftCurve,
            ttftRefMs,
            structScore,
            powerEff,
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

   const freeVram = (m) => (m.maxctxVram != null ? CARD_TOTAL_MIB - m.maxctxVram : null);
   const maxCtx = Math.max(...models.map((m) => m.maxctx ?? 0)) || 1;
   const maxSpeed = Math.max(...models.map((m) => m.speedTg ?? 0)) || 1;
   const maxTotal = Math.max(...models.map((m) => m.totalE2E ?? 0)) || 1;
   const maxFreeVram = Math.max(...models.map((m) => freeVram(m) ?? 0)) || 1;

   // ── Multiplicative score (see SCORING / DEFAULT_WEIGHTS comment above) ─────────
   // restScore: additive weighted sum of capability axes. maxctx/speed are NOT in
   // here (maxctx is an amplifier; speed uses end-to-end totalE2E). Quality benches
   // are absolute (0-100, docqa 0-10); degradation is decode/quality retention.
   const REST_NORMALIZE = {
      reasoning: (m) => (m.reasoning != null ? m.reasoning / 100 : null),
      triage: (m) => (m.triage != null ? m.triage / 100 : null),
      summarization: (m) => (m.summ != null ? m.summ / 100 : null),
      docqa: (m) => (m.docqa != null ? m.docqa / 10 : null),
      speed: (m) => (m.totalE2E != null ? m.totalE2E / maxTotal : null),
      degradation: (m) => {
         // Mean of whichever retention %s exist (decode + quality-at-depth), 0-1.
         const r = [m.decodeRetentionPct, m.qualityRetentionPct].filter(Number.isFinite);
         return r.length ? Math.min(1, r.reduce((a, b) => a + b, 0) / r.length / 100) : null;
      },
   };
   // Fixed denominator inside restScore: an axis a model didn't run contributes 0,
   // so breadth counts and a narrow model can't win on fewer axes.
   const restScore = (m) => {
      let s = 0;
      for (const [metric, w] of Object.entries(weights)) {
         const v = REST_NORMALIZE[metric]?.(m);
         if (v != null && Number.isFinite(v)) {
            s += w * v;
         }
      }
      return s;
   };
   // Two hard gates (0..1): a model with no toolcalling / struct_output data, or a
   // genuine 0, is zeroed — unusable as an agent regardless of other strengths.
   const toolGate = (m) => (m.toolcall != null ? m.toolcall / 100 : 0);
   const structGate = (m) => (m.structScore != null ? m.structScore / 100 : 0);
   // Amplifier: average of max-ctx and free-VRAM headroom, each as % of fleet best.
   // Average only over whichever of the two the model actually measured; 0 if neither.
   const ctxAmp = (m) => {
      const parts = [];
      if (m.maxctx != null) parts.push(m.maxctx / maxCtx);
      const fv = freeVram(m);
      if (fv != null) parts.push(fv / maxFreeVram);
      return parts.length ? parts.reduce((a, b) => a + b, 0) / parts.length : 0;
   };
   const finalScore = (m) => toolGate(m) * structGate(m) * ctxAmp(m) * restScore(m);
   for (const m of models) {
      m.score = Math.round(finalScore(m) * 1000) / 10;
   }
   const ranking = [...models].sort((a, b) => b.score - a.score);

   return { models, ranking, maxCtx, maxSpeed, maxTotal, maxFreeVram, weights };
}
