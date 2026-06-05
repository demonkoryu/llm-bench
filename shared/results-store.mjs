/**
 * Result store for llm-bench — a clean, JSON-native run format.
 *
 * Every runner invocation writes ONE immutable run directory:
 *
 *   results/runs/<run_id>/run.json
 *
 * run.json is fully self-describing — provenance (host/gpu/backend/config),
 * lifecycle (started/finished/status), the planned work matrix, and the measured
 * result rows all live in a single object:
 *
 *   {
 *     run_id, kind,                       // identity + which runner produced it
 *     host, gpu, backend, config_hash,    // provenance / config epoch
 *     started, finished, status,          // lifecycle: running|complete|partial|aborted
 *     seed,                               // run_id this secondary run read maxctx etc. from
 *     planned: [{ model, think, bench }], // the matrix this run intended to cover
 *     results: [{ model, think, bench, status, ts, ...measurements }],
 *   }
 *
 * Merging partial / catch-up runs is deterministic: each result row carries a `ts`
 * and a `status`, so dedup arbitrates by (status, timestamp) — a successful
 * measurement always beats an error, and the newest measurement wins — NOT by file
 * or command-line order. A base run and a catch-up run produce the same report
 * regardless of which is listed first.
 *
 * Consumers (build-report, render-chart, results-to-md, fleet-analysis,
 * coding-rank) load runs via loadRuns()/readRun() and merge with mergeResultRows().
 * Writers (run-suite + the secondary runners) use createRun()/openSecondaryRun().
 * There is no CSV/TSV anywhere — this is the single source of truth for the format.
 */

import { existsSync, mkdirSync, readdirSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import yaml from 'js-yaml';

// ── Result row shape (documented, not enforced) ──────────────────────────────────
//
// A result row is a plain object identified by (model, think, bench). It always
// carries `status` ('ok' | 'error' | …) and a `ts` (ISO 8601, stamped on append),
// plus whichever measurement fields the bench produces:
//
//   score, halls, json_fail, tok_s, prefill_tps, vram_mib, ctx_loaded,
//   oom_ceiling, coherence_ceiling, wall_s, notes
//
// Provenance (host/gpu/backend/config_hash/run_id) lives on the RUN, not the row,
// so rows stay lean and the run object is the single place identity is recorded.

// RX 7900 XT usable VRAM (MiB). Mirrors config/hosts.yaml.
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
// TTFT at the common 8k depth (lower TTFT → closer to 1).
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

// ── Identity ─────────────────────────────────────────────────────────────────

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

/**
 * Build a run id: <host>-<gpu>-<backend>-<datetime>, suffixed with the runner kind
 * for non-suite runs so secondary catch-up runs (kv-probe, struct-output, …) get
 * distinct, self-describing directories. Sorts chronologically (embedded datetime).
 */
export function runIdFrom({ host, gpu, backend, date, kind }) {
   const base = `${slugify(host)}-${slugify(gpu)}-${slugify(backend)}-${timestamp(date)}`;
   return kind && kind !== 'suite' ? `${base}-${slugify(kind)}` : base;
}

// ── Shared (base-model-keyed) benches ────────────────────────────────────────────

/**
 * Benches recorded ONCE per base model (think-independent), keyed by base id. They
 * do not spawn (model × think) rows in aggregation — every think variant inherits
 * them via a base-model lookup (like maxctx). Single source of truth so the
 * aggregation enumeration skip and any row classifier can't drift apart.
 */
const SHARED_BENCH_EXACT = new Set(['maxctx', 'struct_output', 'power_eff', 'kv_per_tok', 'judge']);
const SHARED_BENCH_PREFIXES = ['speed_decay-', 'speed_pargen-', 'quality_decay-', 'ttft-', 'e2e-'];

/** True for a base-model-keyed bench (see SHARED_BENCH_*). */
export function isSharedBench(bench) {
   const b = String(bench);
   return SHARED_BENCH_EXACT.has(b) || SHARED_BENCH_PREFIXES.some((p) => b.startsWith(p));
}

// ── Deterministic merge across runs ──────────────────────────────────────────────

/** ok beats everything; a measured error beats a blank/unknown status. */
function statusRank(s) {
   return s === 'ok' ? 2 : s ? 1 : 0;
}

/** Does row `a` supersede row `b` for the same identity key? */
function supersedes(a, b) {
   const ra = statusRank(a.status);
   const rb = statusRank(b.status);
   if (ra !== rb) {
      return ra > rb; // a successful measurement always wins over an error
   }
   const ta = a.ts ?? '';
   const tb = b.ts ?? '';
   if (ta !== tb) {
      return ta > tb; // among same status, newest ISO ts wins
   }
   return true; // equal/absent ts → later-seen wins (append-order fallback)
}

/**
 * Dedup rows across one or more runs by identity (model|think|bench), choosing the
 * authoritative row per key: a successful measurement always beats an error, and
 * among rows of equal status the newest `ts` wins. ORDER-INDEPENDENT — merging a
 * base run and a catch-up run gives the same result regardless of order. Returns a
 * fresh array in first-seen key order.
 */
export function mergeResultRows(rows) {
   const best = new Map();
   const order = [];
   for (const r of rows) {
      const key = `${r.model}|${r.think}|${r.bench}`;
      const prev = best.get(key);
      if (!prev) {
         best.set(key, r);
         order.push(key);
      } else if (supersedes(r, prev)) {
         best.set(key, r);
      }
   }
   return order.map((k) => best.get(k));
}

// ── Run-scoped layout (results/runs/<run_id>/run.json) ───────────────────────────

export const RUNS_DIRNAME = 'runs';

/** results/runs/<run_id>/ — one immutable directory per runner invocation. */
export function runDir(resultsDir, runId) {
   return join(resultsDir, RUNS_DIRNAME, runId);
}

/** results/runs/<run_id>/run.json */
export function runJsonPath(resultsDir, runId) {
   return join(runDir(resultsDir, runId), 'run.json');
}

/** Parse a run.json into a run object (results[] guaranteed), or null if unreadable. */
function parseRun(path) {
   try {
      const run = JSON.parse(readFileSync(path, 'utf8'));
      if (!Array.isArray(run.results)) {
         run.results = [];
      }
      return run;
   } catch {
      return null;
   }
}

/** Read a run by id, or null if absent/unparseable. */
export function readRun(resultsDir, runId) {
   const p = runJsonPath(resultsDir, runId);
   return existsSync(p) ? parseRun(p) : null;
}

/** Run ids present under results/runs/ (those with a run.json), oldest → newest. */
export function listRuns(resultsDir) {
   const dir = join(resultsDir, RUNS_DIRNAME);
   if (!existsSync(dir)) {
      return [];
   }
   return readdirSync(dir, { withFileTypes: true })
      .filter((d) => d.isDirectory() && existsSync(join(dir, d.name, 'run.json')))
      .map((d) => d.name)
      .sort(); // run ids embed a sortable timestamp
}

/** Newest run id, optionally filtered by run kind (e.g. 'suite'). */
export function latestRun(resultsDir, { kind } = {}) {
   const runs = listRuns(resultsDir);
   for (let i = runs.length - 1; i >= 0; i--) {
      if (!kind || readRun(resultsDir, runs[i])?.kind === kind) {
         return runs[i];
      }
   }
   return null;
}

/** Resolve a single --input token (run id | run dir | run.json path) to a run object. */
function loadRunFromToken(resultsDir, token) {
   if (existsSync(token)) {
      const p = statSync(token).isDirectory() ? join(token, 'run.json') : token;
      return existsSync(p) ? parseRun(p) : null;
   }
   return readRun(resultsDir, token); // a bare run id
}

/**
 * Resolve the --input tokens shared by every consumer (build-report, render-chart,
 * results-to-md, fleet-analysis) to a list of run objects. With no tokens it
 * defaults to the single newest run. Unresolvable tokens are dropped. Feed the
 * merged `results` through mergeResultRows so input ORDER never affects the result.
 */
export function loadRuns(resultsDir, tokens) {
   if (tokens?.length) {
      return tokens.map((t) => loadRunFromToken(resultsDir, t)).filter(Boolean);
   }
   const latest = latestRun(resultsDir);
   return latest ? [readRun(resultsDir, latest)] : [];
}

/** All runs under results/runs/, oldest → newest (used by coding-rank's full merge). */
export function loadAllRuns(resultsDir) {
   return listRuns(resultsDir)
      .map((id) => readRun(resultsDir, id))
      .filter(Boolean);
}

/** complete = every planned (model|think|bench) has a successful result; else partial. */
function deriveStatus(run) {
   if (!run.planned?.length) {
      return run.results.length ? 'complete' : 'partial';
   }
   const ok = new Set(run.results.filter((r) => r.status === 'ok').map((r) => `${r.model}|${r.think}|${r.bench}`));
   return run.planned.every((p) => ok.has(`${p.model}|${p.think}|${p.bench}`)) ? 'complete' : 'partial';
}

/**
 * Create a run directory and return a small recorder. The run.json is rewritten on
 * every append and on finalize, so a crash leaves a readable `running` run with all
 * rows collected so far (resumable). Call finalize() on a clean exit and
 * finalize('aborted') from a signal handler.
 *
 * @param resultsDir  results/ root
 * @param meta { host, gpu, backend, date, kind, planned?, config_hash?, seed?, run_id?, started?, extra? }
 */
export function createRun(resultsDir, meta) {
   const runId = meta.run_id ?? runIdFrom(meta);
   const dir = runDir(resultsDir, runId);
   mkdirSync(dir, { recursive: true });
   const jsonPath = join(dir, 'run.json');

   const run = {
      run_id: runId,
      kind: meta.kind ?? 'suite',
      host: meta.host ?? null,
      gpu: meta.gpu ?? null,
      backend: meta.backend ?? null,
      config_hash: meta.config_hash ?? null,
      started: meta.started ?? new Date().toISOString(),
      finished: null,
      status: 'running',
      seed: meta.seed ?? null,
      planned: meta.planned ?? [],
      results: [],
      ...(meta.extra ?? {}), // run-specific fields (e.g. filters) merged into the run
   };
   const write = () => writeFileSync(jsonPath, `${JSON.stringify(run, null, 2)}\n`, 'utf8');
   write();

   return {
      runId,
      dir,
      jsonPath,
      run,
      /** Append a result row (auto-stamped with `ts`) and persist. */
      append(row) {
         run.results.push({ ...row, ts: row.ts ?? new Date().toISOString() });
         write();
      },
      /** Set finished + terminal status ('complete'|'partial'|'aborted'); defaults to derived. */
      finalize(status) {
         run.finished = new Date().toISOString();
         run.status = status ?? deriveStatus(run);
         write();
         return run.status;
      },
   };
}

/**
 * Open a write run for a single-purpose secondary runner (kv-probe, struct-output,
 * ttft, …) and return the merged result rows it should pull prior data (maxctx,
 * etc.) from. Secondary runners never mutate the run they read — each writes its own
 * immutable run directory, and build-report merges them. The seed is the newest
 * existing run, overridable via --input (a run id / dir / run.json path).
 *
 * @returns {{ run, seedRows }}
 */
export function openSecondaryRun(resultsDir, { target, gpu, backend = 'vulkan', kind, inputFlag, config_hash }) {
   const seedRuns = loadRuns(resultsDir, inputFlag ? [inputFlag] : undefined);
   const seedRows = mergeResultRows(seedRuns.flatMap((r) => r.results));
   const run = createRun(resultsDir, {
      host: target,
      gpu,
      backend,
      date: new Date(),
      kind,
      config_hash: config_hash ?? null,
      seed: seedRuns[0]?.run_id ?? null,
   });
   return { run, seedRows };
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
   // Collapse to one authoritative row per identity first (ok over error, newest ts
   // wins) so aggregation is order-independent whether it's handed a single run's
   // rows or several runs concatenated. Then keep only successful measurements.
   const data = mergeResultRows(rows).filter((r) => r.status === 'ok' && r.bench !== 'load' && r.bench !== 'smoke');

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
         // `score` field; the more granular per-test rate lives in notes as "tests N%".
         const tr = /tests\s+([\d.]+)%/.exec(r.notes ?? '');
         if (Number.isFinite(v) || tr) {
            codingByMT.set(`${baseModel(r.model)}|${r.think}`, {
               pass1: Number.isFinite(v) ? v : null,
               testRate: tr ? Number(tr[1]) : null,
            });
         }
      }
      if (r.bench === 'maxctx') {
         if (Number.isFinite(v)) {
            maxctxByModel.set(baseModel(r.model), v);
         }
         const vram = parseFloat(r.vram_mib);
         if (Number.isFinite(vram)) {
            maxctxVramByModel.set(baseModel(r.model), vram);
         }
      } else if (bench.startsWith('speed_decay-')) {
         const depth = Number(bench.replace('speed_decay-', '').replace('k', '')) * 1024;
         if (Number.isFinite(v)) {
            setDepth(decayByModel, baseModel(r.model), depth, v); // later row wins
         }
      }
   }

   const modelMap = new Map();
   for (const r of data) {
      // Shared (base-model-keyed) benches don't spawn (model × think) groups —
      // they attach to every think variant via base-model lookup above.
      if (isSharedBench(r.bench)) {
         continue;
      }
      const key = `${r.model}|${r.think}`;
      if (!modelMap.has(key)) {
         modelMap.set(key, { model: r.model, think: r.think, rows: [] });
      }
      modelMap.get(key).rows.push(r);
   }

   // Newest row wins: a re-run supersedes the prior value for the same
   // model/think/bench. `rs` is in append order (chronological), and error rows
   // were filtered out above, so the last finite score is the most recent
   // successful measurement.
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
   // rate (granular, discriminates). Test-rate-weighted. Prefer no_think, then the
   // null (n/a) state of non-hybrid models.
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
         // newest value of the prefill_tps field for each probe bench.
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
         // Single end-to-end throughput number (mean of the 4k/12k totals), kept for
         // reference; the score's performance axis uses the directly-measured e2e below.
         const e2e = [total4k, total12k].filter(Number.isFinite);
         const totalE2E = e2e.length ? e2e.reduce((a, b) => a + b, 0) / e2e.length : speedTg;
         // Decode-speed degradation under context load: decode tok/s at depths,
         // shared across think variants (measured once per base model).
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
         // models (mamba/hybrid like Granite) plus sampling noise can read faster at depth
         // than at base — that's no degradation, i.e. 100%, not a >100% speedup.
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
         // reach 32k), so latency is compared apples-to-apples; ttftRefMs stays for display.
         const ttft8kMs = tMap?.get(8192) ?? null;
         // Directly-measured end-to-end throughput (tok/s): one real request per
         // operating-point depth — prefill + a fixed ignore_eos decode — with tok/s
         // read from the server's own timings. The headline `e2eThroughput` is the
         // mean across measured depths; this feeds the score's performance axis.
         const e2eMap = e2eByModel.get(baseModel(model));
         const e2eCurve = e2eMap ? [...e2eMap.entries()].map(([depth, tps]) => ({ depth, tps })).sort((a, b) => a.depth - b.depth) : [];
         const e2eThroughput = e2eCurve.length ? e2eCurve.reduce((a, b) => a + b.tps, 0) / e2eCurve.length : null;
         const e2eRefPt = [...e2eCurve].filter((x) => x.depth > 0 && x.depth <= 32768).pop() ?? null;
         const e2eRef = e2eRefPt?.tps ?? null;
         // Structured-output reliability: % of JSON tasks that were schema-conformant.
         const structScore = structByModel.get(baseModel(model)) ?? null;
         // Coding grade (no_think-primary): pass@1 + test-rate from coding_multipl in
         // the no_think / null state — a base-model property shared across think
         // variants. Normalized to a multiplier below.
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
   const REST_NORMALIZE = {
      reasoning: (m) => (m.reasoning != null ? m.reasoning / 100 : null),
      triage: (m) => (m.triage != null ? m.triage / 100 : null),
      summarization: (m) => (m.summ != null ? m.summ / 100 : null),
      docqa: (m) => (m.docqa != null ? m.docqa / 10 : null),
      // Performance composite: 0.4·throughput + 0.6·latency, latency-favored, in 0..1.
      //   throughput = directly-measured E2E tok/s ÷ fleet best (no decode fallback)
      //   latency    = fleet-min TTFT@8k ÷ this model's TTFT@8k (lower TTFT → ~1)
      // Weighted-averaged over whichever components exist; missing BOTH contributes 0.
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
   // best (0..1), multiplied into the score like the gates. NOT a rest-axis weight.
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
