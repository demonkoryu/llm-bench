// Scoring engine (pure). Consumes tidy leaf-metric rows (already filtered to a
// selection), derives per-entity composite metrics, normalizes them ACROSS the
// selection, and composes capability / speed / fleet. Clean-slate rewrite; reads the
// declarative analysis/scoring-config.mjs. No imports from the retired scoring.mjs.
import { CARD_TOTAL_MIB, CODING_WEIGHTS, DEFAULT_DIALS, ENTITY_DIMS, GROUPS } from './scoring-config.mjs';

// ── leaf helpers ────────────────────────────────────────────────────────────────
const num = (v) => (typeof v === 'number' && Number.isFinite(v) ? v : null);
const mean = (xs) => (xs.length ? xs.reduce((a, b) => a + b, 0) / xs.length : null);
const sum = (xs) => xs.reduce((a, b) => a + (b ?? 0), 0);
function vals(rows, pred) { return rows.filter(pred).map((r) => num(r.metric_value)).filter((v) => v != null); }
const pickMean = (rows, metric, bench) => mean(vals(rows, (r) => r.metric === metric && (!bench || r.bench === bench)));
const ratio = (rows, a, b) => { const t = sum(vals(rows, (r) => r.metric === b)); return t ? sum(vals(rows, (r) => r.metric === a)) / t : null; };

function codingGrade(rows) {
  let wsum = 0, acc = 0;
  for (const [bench, w] of Object.entries(CODING_WEIGHTS)) {
    const sub = rows.filter((r) => r.bench === bench);
    if (!sub.length) continue;
    const pass = ratio(sub, 'coding_pass_at_1', 'coding_total'); // count → pass@1 rate
    const rate = ratio(sub, 'coding_tests_passed', 'coding_tests_total');
    const g = 0.4 * (pass ?? 0) + 0.6 * (rate ?? pass ?? 0);
    acc += w * g; wsum += w;
  }
  return wsum ? acc / wsum : null;
}

// ── metric definitions: raw(rows) → number|null, plus direction + normalization ──
const METRIC_DEFS = {
  triage: { raw: (r) => mean(vals(r, (x) => /^triage_[RC]\d+$/.test(x.metric))), norm: 'identity' },
  reasoning: { raw: (r) => ratio(r, 'reasoning_correct', 'reasoning_total'), norm: 'identity' },
  toolcalling: { raw: (r) => ratio(r, 'toolcall_pass', 'toolcall_total'), norm: 'identity' },
  summarization: { raw: (r) => mean(vals(r, (x) => /^summ_/.test(x.metric))), norm: 'identity' },
  docqa: { raw: (r) => { const m = mean(vals(r, (x) => /^docqa_/.test(x.metric))); return m == null ? null : m / 10; }, norm: 'identity' },
  struct_output: { raw: (r) => { const m = pickMean(r, 'score', 'struct_output'); return m == null ? null : m / 100; }, norm: 'identity' },
  instruction_following: { raw: (r) => { const m = pickMean(r, 'score', 'instruction_following'); return m == null ? null : m / 100; }, norm: 'identity' },
  agentic_loop: { raw: (r) => { const m = pickMean(r, 'score', 'agentic_loop'); return m == null ? null : m / 100; }, norm: 'identity' },
  coding_grade: { raw: codingGrade, norm: 'identity' },
  e2e_throughput: { raw: (r) => pickMean(r, 'score', 'e2e-8k') ?? pickMean(r, 'score', 'e2e-2k'), norm: 'ratioMax' },
  ttft: { raw: (r) => pickMean(r, 'score', 'ttft-8k') ?? pickMean(r, 'score', 'ttft-2k'), dir: 'lower', norm: 'inverseMin' },
  decode_retention: { raw: (r) => { const a = pickMean(r, 'score', 'speed_long-32k'); const b = pickMean(r, 'score', 'speed_short'); return a != null && b ? Math.min(1, a / b) : null; }, norm: 'identity' },
  maxctx: { raw: (r) => pickMean(r, 'score', 'maxctx'), norm: 'ratioMax' },
  // fleet inputs (not scored directly)
  _vram_at_maxctx: { raw: (r) => pickMean(r, 'vram_mib', 'maxctx'), norm: 'raw' },
  _kv_per_tok_kib: { raw: (r) => pickMean(r, 'score', 'kv_per_tok'), norm: 'raw' },
};

// ── entity grouping ─────────────────────────────────────────────────────────────
const SEP = '␟';
// An entity is a SERVED CONFIG (ENTITY_DIMS) — NOT split by think. think is a view
// parameter: think-dependent core benches use the chosen think; think-independent
// benches (think_mode='n/a') always attach. This keeps one config's metrics together.
function entityKey(row) { return ENTITY_DIMS.map((d) => row[d] ?? '').join(SEP); }
function groupEntities(rows, think) {
  const m = new Map();
  for (const r of rows) {
    const tm = r.think_mode ?? 'n/a';
    if (tm !== 'n/a' && tm !== think) continue; // drop the non-selected think's core rows
    const k = entityKey(r);
    if (!m.has(k)) {
      const dims = {}; for (const d of ENTITY_DIMS) dims[d] = r[d] ?? null;
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
  if (strat === 'ratioMax') denom = pin?.[name] ?? (Math.max(...raws, 0) || 1);
  if (strat === 'inverseMin') denom = pin?.[name] ?? Math.min(...raws.filter((v) => v > 0), Infinity);
  let mn = 0, mx = 1;
  if (strat === 'minmax') { mn = Math.min(...raws); mx = Math.max(...raws); }
  for (const e of entities) {
    const v = e.raw[name];
    if (v == null) { e.norm[name] = null; continue; }
    if (strat === 'identity') e.norm[name] = Math.max(0, Math.min(1, v));
    else if (strat === 'ratioMax') e.norm[name] = denom ? Math.max(0, Math.min(1, v / denom)) : null;
    else if (strat === 'inverseMin') e.norm[name] = Number.isFinite(denom) && v > 0 ? Math.max(0, Math.min(1, denom / v)) : null;
    else if (strat === 'minmax') e.norm[name] = mx > mn ? (v - mn) / (mx - mn) : 1;
    else e.norm[name] = v; // raw passthrough
  }
  return denom;
}

// ── composites ──────────────────────────────────────────────────────────────────
const geomean = (xs) => { const v = xs.filter((x) => x != null && x > 0); return v.length ? Math.exp(mean(v.map(Math.log))) : (xs.some((x) => x === 0) ? 0 : null); };
function wGeomean(pairs) { // [[val,weight]]
  const p = pairs.filter(([v]) => v != null); const W = sum(p.map(([, w]) => w));
  if (!W) return null; let s = 0; for (const [v, w] of p) s += (w / W) * Math.log(Math.max(v, 1e-9)); return Math.exp(s);
}
function wSum(pairs) { const p = pairs.filter(([v]) => v != null); const W = sum(p.map(([, w]) => w)); return W ? sum(p.map(([v, w]) => (w / W) * v)) : null; }

function capability(e, dials) {
  const cw = dials.comprehension.weights, comp = wGeomean(GROUPS.comprehension.members.map((m) => [e.norm[m], cw[m] ?? 0]));
  const gates = geomean(GROUPS.coding.gates.map((m) => e.norm[m]).filter((v) => v != null)); // absent gate = neutral (skipped)
  const competence = e.norm.coding_grade;
  const coding = gates == null && competence == null ? null : (gates ?? 1) * (competence ?? 1);
  const cS = dials.comprehension.strength, kS = dials.coding.strength;
  const compTerm = comp == null ? 1 : comp ** cS;
  const codeTerm = coding == null ? 1 : coding ** kS;
  const cap = (comp == null && coding == null) ? null : compTerm * codeTerm;
  return { comprehension: comp, coding, capability: cap == null ? null : cap * 100 };
}
function speed(e, dials) { const w = dials.speed.weights; return wSum(GROUPS.speed.members.map((m) => [e.norm[m], w[m] ?? 0])); }

function fleet(e, dials, ctxNormMax) {
  const d = dials.fleet, vram = e.raw._vram_at_maxctx, kvKib = e.raw._kv_per_tok_kib, mctx = e.raw.maxctx, cap = e.capability;
  if (vram == null || kvKib == null || mctx == null || cap == null) return null;
  const kvMib = (kvKib * mctx) / 1024;               // KV MiB at max ctx
  const weights = Math.max(0, vram - kvMib);          // resident weights (VRAM at ctx0)
  const slotVram = weights + (kvKib * d.worker_ctx) / 1024 + d.parallel_overhead;
  const budget = CARD_TOTAL_MIB - d.reserve - vram;   // room beyond the main slot
  const slots = 1 + Math.max(0, Math.floor(budget / Math.max(slotVram, 1)));
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
  for (const e of entities) { e.raw = {}; e.norm = {}; for (const [name, def] of Object.entries(METRIC_DEFS)) e.raw[name] = def.raw(e.rows); }
  const denom = {};
  for (const [name, def] of Object.entries(METRIC_DEFS)) denom[name] = normalizeMetric(entities, name, def, pinNorm);
  for (const e of entities) { Object.assign(e, capability(e, dials)); e.speed = speed(e, dials); }
  for (const e of entities) { const fl = fleet(e, dials); e.fleet_slots = fl?.slots ?? null; e.fleet_suitability = fl?.suitability ?? null; delete e.rows; }
  entities.sort((a, b) => (b.capability ?? -1) - (a.capability ?? -1));
  return { entities, denom, version: 3 };
}
