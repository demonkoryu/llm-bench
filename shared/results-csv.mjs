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
// Used to turn "VRAM used at max ctx" into reported free headroom (no longer scored).
export const CARD_TOTAL_MIB = 20464;

// The composite score is MULTIPLICATIVE, not a flat weighted sum:
//
//   score = codingMult × toolGate × structGate × maxctx% × restScore
//
//   • codingMult — the no_think-primary coding grade (0.4·pass@1 + 0.6·test-rate
//                  from coding_multipl), normalized to the fleet's best (0..1) and
//                  multiplied in. Coding is a first-class requirement for this use
//                  case, so a weak coder scales the whole score down; no coding data
//                  zeroes it (same convention as the gates). NOT a rest-axis weight.
//   • toolGate / structGate  — hard gates in 0..1 (accuracy/conformance as a fraction).
//                              Either at 0 (or absent) zeroes the whole score: a model
//                              that can't tool-call or can't emit valid structured
//                              output is unusable for this agentic use case.
//   • amplifier  — max-ctx as a % of the fleet's best (0..1). Rewards long usable
//                  windows. (Free-VRAM headroom is measured and reported but no
//                  longer scored — it double-counted what maxctx already captures.)
//   • restScore  — additive weighted sum of the remaining capability axes (below),
//                  weights sum to 1.0, each normalized to 0..1.
//
// restScore keeps the FIXED-denominator rule: an axis a model didn't run contributes 0,
// so breadth counts and a narrow model can't win by being scored on fewer axes.
// DEFAULT_WEIGHTS holds ONLY the rest axes — toolcalling, struct_output, maxctx and
// is a structural multiplier, not an entry here.
//   reasoning 20 · triage 18 · summarization 16 · docqa 13 · performance 25 · degradation 8
//
// `performance` is a composite (NOT a hard multiplier — significant but bounded by its
// 0.25 rest-weight): 0.4·throughput + 0.6·latency, latency-favored. Throughput =
// directly-measured E2E tok/s ÷ fleet best; latency = fleet-min TTFT ÷ this model's
// TTFT at the common 8k depth (lower TTFT → closer to 1). It replaces the old `speed`
// axis (which scored throughput alone at 0.15) so first-token latency now counts too.
export const DEFAULT_WEIGHTS = {
   reasoning: 0.2,
   triage: 0.18,
   summarization: 0.16,
   docqa: 0.13,
   performance: 0.25,
   degradation: 0.08,
};

// Self-describing scoring shape for report.json + the chart subtitle (so the
// displayed formula can never drift from the code).
export const SCORING = {
   formula: 'coding × toolcalling × struct_output × maxctx% × Σ(rest)',
   gates: ['coding', 'toolcalling', 'struct_output'],
   amplifiers: ['maxctx'],
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
 * @returns {{ models, ranking, maxCtx, maxE2E, minTtft8k, weights }}
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
   const e2eByModel = new Map(); // base model → Map(depth → end-to-end tok/s, directly measured)
   const structByModel = new Map(); // base model → schema-conformance %
   const powerEffByModel = new Map(); // base model → decode tok/s per watt
   const codingByMT = new Map(); // `${base}|${think}` → { pass1, testRate } from coding_multipl
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
      } else if (bench.startsWith('e2e-')) {
         if (Number.isFinite(v)) setDepth(e2eByModel, baseModel(r.model), depthOf(bench, 'e2e-'), v);
      } else if (bench === 'struct_output') {
         if (Number.isFinite(v)) structByModel.set(baseModel(r.model), v);
      } else if (bench === 'power_eff') {
         if (Number.isFinite(v)) powerEffByModel.set(baseModel(r.model), v);
      } else if (bench === 'coding_multipl') {
         // Sole coding source (imported MultiPL-E / HumanEval-JS). pass@1 is the
         // `score` column; the more granular per-test rate lives in notes as "tests N%".
         const tr = /tests\s+([\d.]+)%/.exec(r.notes ?? '');
         if (Number.isFinite(v) || tr) {
            codingByMT.set(`${baseModel(r.model)}|${r.think}`, {
               pass1: Number.isFinite(v) ? v : null,
               testRate: tr ? Number(tr[1]) : null,
            });
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
      const b = String(r.bench);
      if (
         b === 'maxctx' ||
         b === 'struct_output' ||
         b === 'power_eff' ||
         b === 'kv_per_tok' ||
         b.startsWith('speed_decay-') ||
         b.startsWith('speed_pargen-') ||
         b.startsWith('quality_decay-') ||
         b.startsWith('ttft-') ||
         b.startsWith('e2e-')
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

   // Coding grade — no_think-primary policy. Computed from the single coding source
   // (coding_multipl, imported MultiPL-E / HumanEval-JS) by blending its two metrics:
   // pass@1 (strict, all-or-nothing per problem — a competence floor) and the per-test
   // rate (granular, discriminates). Test-rate-weighted, mirroring the prior easy/hard
   // split. Prefer no_think, then the null (n/a) state of non-hybrid models.
   const W_CODE_PASS1 = 0.4;
   const W_CODE_TESTRATE = 0.6;
   const codingGradeOf = (base) => {
      for (const st of ['no_think', 'n/a']) {
         const c = codingByMT.get(`${base}|${st}`);
         if (c && (c.pass1 != null || c.testRate != null)) {
            return W_CODE_PASS1 * (c.pass1 ?? 0) + W_CODE_TESTRATE * (c.testRate ?? 0);
         }
      }
      return null;
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
            Math.max(latestScore(rs, 'speed_short') ?? 0, latestScore(rs, 'speed_long-32k') ?? 0, latestScore(rs, 'speed') ?? 0) || null;
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
         // Clamp ≤100%: retention is "fraction of base speed kept under load". Flat-decode
         // models (mamba/hybrid like Granite, whose state-space layers have no growing KV)
         // plus sampling noise can read faster at depth than at base — that's no degradation,
         // i.e. 100%, not a >100% speedup.
         const decodeRetentionPct = decodeBase && decodeRef ? Math.min(100, Math.round((decodeRef / decodeBase) * 100)) : null;
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
         const qualityRetentionPct = qualityBase && qRef?.acc != null ? Math.min(100, Math.round((qRef.acc / qualityBase) * 100)) : null;
         // TTFT (prefill latency, ms) at each depth — the latency an agent feels.
         const tMap = ttftByModel.get(baseModel(model));
         const ttftCurve = tMap ? [...tMap.entries()].map(([depth, ms]) => ({ depth, ms })).sort((a, b) => a.depth - b.depth) : [];
         const ttftRefPt = [...ttftCurve].filter((x) => x.depth > 0 && x.depth <= 32768).pop() ?? null;
         const ttftRefMs = ttftRefPt?.ms ?? null;
         // TTFT at the common 8k depth — used for the latency half of the performance
         // axis. 8k is measured by every model (even the small-ctx ones that can't
         // reach 32k), so latency is compared apples-to-apples; ttftRefMs (deepest
         // ≤32k) stays for display only.
         const ttft8kMs = tMap?.get(8192) ?? null;
         // Directly-measured end-to-end throughput (tok/s): one real request per
         // operating-point depth — prefill + a fixed ignore_eos decode — with tok/s
         // read from the server's own timings as (prompt_n+predicted_n)÷(prompt_ms+
         // predicted_ms). No formula combining separate runs, no decode fallback.
         // The headline `e2eThroughput` is the mean across measured depths; this is
         // what feeds the score's speed axis (replacing the synthetic totalE2E).
         const e2eMap = e2eByModel.get(baseModel(model));
         const e2eCurve = e2eMap ? [...e2eMap.entries()].map(([depth, tps]) => ({ depth, tps })).sort((a, b) => a.depth - b.depth) : [];
         const e2eThroughput = e2eCurve.length ? e2eCurve.reduce((a, b) => a + b.tps, 0) / e2eCurve.length : null;
         const e2eRefPt = [...e2eCurve].filter((x) => x.depth > 0 && x.depth <= 32768).pop() ?? null;
         const e2eRef = e2eRefPt?.tps ?? null;
         // Structured-output reliability: % of JSON tasks that were schema-conformant.
         const structScore = structByModel.get(baseModel(model)) ?? null;
         // Coding grade (no_think-primary): pass@1 + test-rate from coding_multipl in
         // the no_think / null state — a base-model property shared across think
         // variants (like struct/maxctx). Normalized to a multiplier below.
         const codingGrade = codingGradeOf(baseModel(model));
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
            ttft8kMs,
            e2eCurve,
            e2eThroughput,
            e2eRef,
            structScore,
            powerEff,
            codingGrade,
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
   const maxE2E = Math.max(...models.map((m) => m.e2eThroughput ?? 0)) || 1;
   // Fleet-fastest first-token latency at the common 8k depth (lower = better), the
   // denominator-flipped reference for the latency half of the performance axis.
   const minTtft8k = Math.min(...models.map((m) => m.ttft8kMs ?? Infinity));

   // ── Multiplicative score (see SCORING / DEFAULT_WEIGHTS comment above) ─────────
   // restScore: additive weighted sum of capability axes. maxctx is NOT here (it's an
   // amplifier). `performance` blends measured throughput + TTFT (see its normalizer).
   // Quality benches are absolute (0-100, docqa 0-10); degradation is retention.
   const REST_NORMALIZE = {
      reasoning: (m) => (m.reasoning != null ? m.reasoning / 100 : null),
      triage: (m) => (m.triage != null ? m.triage / 100 : null),
      summarization: (m) => (m.summ != null ? m.summ / 100 : null),
      docqa: (m) => (m.docqa != null ? m.docqa / 10 : null),
      // Performance composite: 0.4·throughput + 0.6·latency, latency-favored, in 0..1.
      //   throughput = directly-measured E2E tok/s ÷ fleet best (no decode fallback —
      //                a model with no e2e measurement just omits this component)
      //   latency    = fleet-min TTFT@8k ÷ this model's TTFT@8k (lower TTFT → ~1)
      // Weighted-averaged over whichever components exist, so a model missing one
      // sub-metric is scored on the other rather than zeroed outright; missing BOTH
      // contributes 0 to the axis (fixed-denominator rule).
      performance: (m) => {
         let num = 0;
         let den = 0;
         if (m.e2eThroughput != null) {
            num += 0.4 * (m.e2eThroughput / maxE2E);
            den += 0.4;
         }
         if (m.ttft8kMs != null && Number.isFinite(minTtft8k)) {
            num += 0.6 * (minTtft8k / m.ttft8kMs);
            den += 0.6;
         }
         return den ? num / den : null;
      },
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
   // Amplifier: max-ctx as % of fleet best. 0 if the model has no maxctx data.
   const ctxAmp = (m) => (m.maxctx != null ? m.maxctx / maxCtx : 0);
   // Coding multiplier: the no_think-primary coding grade normalized to the fleet's
   // best (0..1), multiplied into the score like the gates. A model with no coding
   // data is 0 (same convention as toolGate/structGate). NOT a rest-axis weight.
   const maxCoding = Math.max(...models.map((m) => m.codingGrade ?? 0)) || 1;
   const codingMult = (m) => (m.codingGrade != null ? m.codingGrade / maxCoding : 0);
   const finalScore = (m) => codingMult(m) * toolGate(m) * structGate(m) * ctxAmp(m) * restScore(m);
   for (const m of models) {
      // Expose the performance-axis breakdown for the report/chart (transparency).
      m.throughputNorm = m.e2eThroughput != null ? m.e2eThroughput / maxE2E : null;
      m.latencyNorm = m.ttft8kMs != null && Number.isFinite(minTtft8k) ? minTtft8k / m.ttft8kMs : null;
      m.performance = REST_NORMALIZE.performance(m);
      m.score = Math.round(finalScore(m) * 1000) / 10;
   }
   const ranking = [...models].sort((a, b) => b.score - a.score);

   return { models, ranking, maxCtx, maxE2E, minTtft8k, weights };
}
