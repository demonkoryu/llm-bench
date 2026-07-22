// Scoring engine (pure). Consumes tidy leaf-metric rows (already filtered to a
// selection), derives per-entity composite metrics, normalizes them ACROSS the
// selection, and composes capability / speed / fleet. Clean-slate rewrite; reads the
// declarative analysis/scoring-config.mjs. No imports from the retired scoring.mjs.
import { CODING_WEIGHTS, DEFAULT_DIALS, ENTITY_DIMS, GROUPS } from './scoring-config.mjs';

// ── leaf helpers ────────────────────────────────────────────────────────────────
const num = (v) => (typeof v === 'number' && Number.isFinite(v) ? v : null);
const mean = (xs) => (xs.length ? xs.reduce((a, b) => a + b, 0) / xs.length : null);
const sum = (xs) => xs.reduce((a, b) => a + (b ?? 0), 0);
function vals(rows, pred) {
   return rows
      .filter(pred)
      .map((r) => num(r.metric_value))
      .filter((v) => v != null);
}
const pickMean = (rows, metric, bench) => mean(vals(rows, (r) => r.metric === metric && (!bench || r.bench === bench)));
const ratio = (rows, a, b) => {
   const t = sum(vals(rows, (r) => r.metric === b));
   return t ? sum(vals(rows, (r) => r.metric === a)) / t : null;
};

function codingGrade(rows) {
   let wsum = 0,
      acc = 0;
   for (const [bench, w] of Object.entries(CODING_WEIGHTS)) {
      const sub = rows.filter((r) => r.bench === bench);
      if (!sub.length) {
         continue;
      }
      const pass = ratio(sub, 'coding_pass_at_1', 'coding_total'); // count → pass@1 rate
      const rate = ratio(sub, 'coding_tests_passed', 'coding_tests_total');
      const g = 0.4 * (pass ?? 0) + 0.6 * (rate ?? pass ?? 0);
      acc += w * g;
      wsum += w;
   }
   return wsum ? acc / wsum : null;
}

// ── metric definitions: raw(rows) → number|null, plus direction + normalization ──
const METRIC_DEFS = {
   triage: { raw: (r) => mean(vals(r, (x) => /^triage_[RC]\d+$/.test(x.metric))), norm: 'identity' },
   reasoning: { raw: (r) => ratio(r, 'reasoning_correct', 'reasoning_total'), norm: 'identity' },
   toolcalling: { raw: (r) => ratio(r, 'toolcall_pass', 'toolcall_total'), norm: 'identity' },
   summarization: { raw: (r) => mean(vals(r, (x) => /^summ_/.test(x.metric))), norm: 'identity' },
   docqa: {
      // Grader components are ADDITIVE: correctness(5)+coverage(3)+faithfulness(2) = score/10.
      // Sum the per-component means (mean handles duplicate runs), NOT the mean of the three
      // (which would divide the 0–10 score by 3, capping docqa at ~3.3/10).
      raw: (r) => {
         const parts = ['docqa_correctness', 'docqa_coverage', 'docqa_faithfulness'].map((k) => pickMean(r, k, 'docqa'));
         return parts.every((v) => v == null) ? null : parts.reduce((s, v) => s + (v ?? 0), 0) / 10;
      },
      norm: 'identity',
   },
   struct_output: {
      raw: (r) => {
         const m = pickMean(r, 'score', 'struct_output');
         return m == null ? null : m / 100;
      },
      norm: 'identity',
   },
   instruction_following: {
      raw: (r) => {
         const m = pickMean(r, 'score', 'instruction_following');
         return m == null ? null : m / 100;
      },
      norm: 'identity',
   },
   agentic_loop: {
      raw: (r) => {
         const m = pickMean(r, 'score', 'agentic_loop');
         return m == null ? null : m / 100;
      },
      norm: 'identity',
   },
   coding_grade: { raw: codingGrade, norm: 'identity' },
   e2e_throughput: { raw: (r) => pickMean(r, 'score', 'e2e-8k') ?? pickMean(r, 'score', 'e2e-2k'), norm: 'ratioMax' },
   ttft: { raw: (r) => pickMean(r, 'score', 'ttft-8k') ?? pickMean(r, 'score', 'ttft-2k'), dir: 'lower', norm: 'inverseMin' },
   decode_retention: {
      raw: (r) => {
         const a = pickMean(r, 'score', 'speed_long-32k');
         const b = pickMean(r, 'score', 'speed_short');
         return a != null && b ? Math.min(1, a / b) : null;
      },
      norm: 'identity',
   },
   // shared multi-agent KV pool (total_ctx across 1 planner + n coders), from agent_ctx
   agent_ctx: { raw: (r) => pickMean(r, 'total_ctx', 'agent_ctx'), norm: 'ratioMax' },
   fit_ctx: { raw: (r) => pickMean(r, 'score', 'fit_ctx'), norm: 'ratioMax' },
   // fleet inputs (empirical, from the agent_ctx probe; not scored directly)
   _agent_slots: { raw: (r) => pickMean(r, 'n_slots', 'agent_ctx'), norm: 'raw' },
   _agent_planner_ctx: { raw: (r) => pickMean(r, 'planner_ctx', 'agent_ctx'), norm: 'raw' },
   _vram_at_ctx: { raw: (r) => pickMean(r, 'vram_mib', 'agent_ctx'), norm: 'raw' },
   _kv_per_tok_kib: { raw: (r) => pickMean(r, 'score', 'kv_per_tok'), norm: 'raw' },
};

// ── entity grouping ─────────────────────────────────────────────────────────────
const SEP = '␟';
// An entity is a SERVED CONFIG (ENTITY_DIMS) — NOT split by think. think is a view
// parameter: think-dependent core benches use the chosen think; think-independent
// benches (think_mode='n/a') always attach. This keeps one config's metrics together.
export function entityKey(row) {
   return ENTITY_DIMS.map((d) => row[d] ?? '').join(SEP);
}
function groupEntities(rows, think) {
   const m = new Map();
   for (const r of rows) {
      const tm = r.think_mode ?? 'n/a';
      if (tm !== 'n/a' && tm !== think) {
         continue; // drop the non-selected think's core rows
      }
      const k = entityKey(r);
      if (!m.has(k)) {
         const dims = {};
         for (const d of ENTITY_DIMS) {
            dims[d] = r[d] ?? null;
         }
         m.set(k, { key: k, dims, think, rows: [] });
      }
      m.get(k).rows.push(r);
   }
   return [...m.values()];
}

// ── normalization across the selection ──────────────────────────────────────────
function normalizeMetric(entities, name, def, pin) {
   const raws = entities.map((e) => e.raw[name]).filter((v) => v != null);
   const strat = def.norm;
   let denom = null;
   if (strat === 'ratioMax') {
      denom = pin?.[name] ?? (Math.max(...raws, 0) || 1);
   }
   if (strat === 'inverseMin') {
      denom = pin?.[name] ?? Math.min(...raws.filter((v) => v > 0), Infinity);
   }
   let mn = 0,
      mx = 1;
   if (strat === 'minmax') {
      mn = Math.min(...raws);
      mx = Math.max(...raws);
   }
   for (const e of entities) {
      const v = e.raw[name];
      if (v == null) {
         e.norm[name] = null;
         continue;
      }
      if (strat === 'identity') {
         e.norm[name] = Math.max(0, Math.min(1, v));
      } else if (strat === 'ratioMax') {
         e.norm[name] = denom ? Math.max(0, Math.min(1, v / denom)) : null;
      } else if (strat === 'inverseMin') {
         e.norm[name] = Number.isFinite(denom) && v > 0 ? Math.max(0, Math.min(1, denom / v)) : null;
      } else if (strat === 'minmax') {
         e.norm[name] = mx > mn ? (v - mn) / (mx - mn) : 1;
      } else {
         e.norm[name] = v; // raw passthrough
      }
   }
   return denom;
}

// ── composites ──────────────────────────────────────────────────────────────────
const geomean = (xs) => {
   const v = xs.filter((x) => x != null && x > 0);
   return v.length ? Math.exp(mean(v.map(Math.log))) : xs.some((x) => x === 0) ? 0 : null;
};
function wGeomean(pairs) {
   // [[val,weight]]
   const p = pairs.filter(([v]) => v != null);
   const W = sum(p.map(([, w]) => w));
   if (!W) {
      return null;
   }
   let s = 0;
   for (const [v, w] of p) {
      s += (w / W) * Math.log(Math.max(v, 1e-9));
   }
   return Math.exp(s);
}
function wSum(pairs) {
   const p = pairs.filter(([v]) => v != null);
   const W = sum(p.map(([, w]) => w));
   return W ? sum(p.map(([v, w]) => (w / W) * v)) : null;
}

// A composite is reported ONLY when its members are fully present. A missing bench must not be
// treated as a perfect (neutral) score — otherwise a config that only ran a subset inflates to the
// top of the board (e.g. a 4B model at capability 100 because it only ran toolcalling). So an
// incomplete comprehension or coding is null → capability is null → the config shows "—" and ranks
// last, instead of #1. Fully-covered configs are unaffected (identical scores to before).
function capability(e, dials) {
   const cw = dials.comprehension.weights;
   const compMembers = GROUPS.comprehension.members.filter((m) => (cw[m] ?? 0) > 0);
   const comp = compMembers.every((m) => e.norm[m] != null) ? wGeomean(compMembers.map((m) => [e.norm[m], cw[m]])) : null;

   const competence = e.norm.coding_grade;
   const gatesComplete = GROUPS.coding.gates.every((m) => e.norm[m] != null);
   const gates = gatesComplete ? geomean(GROUPS.coding.gates.map((m) => e.norm[m])) : null;
   const coding = gates == null || competence == null ? null : gates * competence;

   const cap = comp == null || coding == null ? null : comp ** dials.comprehension.strength * coding ** dials.coding.strength;
   return { comprehension: comp, coding, capability: cap == null ? null : cap * 100 };
}
function speed(e, dials) {
   const w = dials.speed.weights;
   return wSum(GROUPS.speed.members.map((m) => [e.norm[m], w[m] ?? 0]));
}

// Fleet suitability from the EMPIRICAL agent_ctx probe: it directly measured how many
// slots (1 planner + n coders) verifiably load + cohere from a single shared KV pool, so
// there is no VRAM formula here anymore — `slots` and the planner ctx come straight from the
// measurement. worker_ctx / reserve / parallel_overhead dials are retired (they parameterized
// the old estimate); ctx_tier + the weight exponents still shape the composite.
function fleet(e, dials) {
   const d = dials.fleet,
      slots = e.raw._agent_slots,
      mctx = e.raw._agent_planner_ctx,
      cap = e.capability;
   if (slots == null || mctx == null || cap == null) {
      return null;
   }
   const ctxNorm = Math.min(mctx, d.ctx_tier) / d.ctx_tier;
   const slotNorm = Math.min(1, slots / 4);
   const thru = e.norm.e2e_throughput ?? 0;
   return { slots, suitability: (cap / 100) ** d.w_cap * ctxNorm ** d.w_ctx * slotNorm ** d.w_slots * (thru || 0.01) ** d.w_thru * 100 };
}

/**
 * Score a selection of tidy rows.
 * @returns {{ entities: object[], denom: object, version }}
 */
export function scoreSelection(rows, { dials = DEFAULT_DIALS, pinNorm = null, think = 'no_think' } = {}) {
   const entities = groupEntities(rows, think);
   for (const e of entities) {
      e.raw = {};
      e.norm = {};
      for (const [name, def] of Object.entries(METRIC_DEFS)) {
         e.raw[name] = def.raw(e.rows);
      }
   }
   const denom = {};
   for (const [name, def] of Object.entries(METRIC_DEFS)) {
      denom[name] = normalizeMetric(entities, name, def, pinNorm);
   }
   for (const e of entities) {
      Object.assign(e, capability(e, dials));
      e.speed = speed(e, dials);
   }
   for (const e of entities) {
      const fl = fleet(e, dials);
      e.fleet_slots = fl?.slots ?? null;
      e.fleet_suitability = fl?.suitability ?? null;
      delete e.rows;
   }
   entities.sort((a, b) => (b.capability ?? -1) - (a.capability ?? -1));
   return { entities, denom, version: 3 };
}
