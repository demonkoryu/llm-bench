// Dashboard query engine — the SINGLE source of truth for the metric catalog plus the
// pivot / pareto / leaderboard / coverage / meta / facets logic. Pure: every function takes
// the tidy `rows` array (leaf-metric rows) as input and returns the shapes the Observable
// Framework dashboard (dashboard/) renders.
//
// The Framework client imports this unchanged (dashboard/copy-lib.mjs mirrors it into
// dashboard/src/lib/ at build time); its build-time data loader pulls the rows from central-db
// via analysis/pg-store.mjs. Scoring stays in analysis/score.mjs; this module only owns the
// friendly-metric catalog and the tabular/scatter reshaping.
import { entityKey, scoreSelection } from './score.mjs';
import { DEFAULT_DIALS } from './scoring-config.mjs';

export const FACET_DIMS = [
   'family',
   'arch',
   'type',
   'finetune',
   'quant',
   'kv_quant',
   'chat_template',
   'think_mode',
   'backend',
   'gpu',
   'llamacpp_build',
   'sampling_profile',
];
export const PIVOT_DIMS = ['gguf_file', ...FACET_DIMS];

const CELL_SEP = '␟'; // ␟ — pivot/coverage cell-key joiner (distinct name from score.mjs's SEP so both inline cleanly)
const _n = (v) => (typeof v === 'number' && Number.isFinite(v) ? v : null);
const sumF = (rows, p) => rows.reduce((a, r) => (p(r) && _n(r.metric_value) != null ? a + r.metric_value : a), 0);
const cntF = (rows, p) => rows.reduce((a, r) => (p(r) && _n(r.metric_value) != null ? a + 1 : a), 0);
const avgF = (rows, p) => {
   const c = cntF(rows, p);
   return c ? sumF(rows, p) / c : null;
};
const maxF = (rows, p) => {
   const xs = rows.filter((r) => p(r) && _n(r.metric_value) != null).map((r) => r.metric_value);
   return xs.length ? Math.max(...xs) : null;
};

// Friendly metric name → { fn(rowsOfGroup) → number|null, lower?: bool }. `lower` flags
// lower-is-better metrics (VRAM, ttft, KV/tok). This is the ONE catalog both dashboards use.
export const METRIC_CATALOG = {
   'toolcalling %': {
      fn: (r) => {
         const t = sumF(r, (x) => x.metric === 'toolcall_total');
         return t ? (100 * sumF(r, (x) => x.metric === 'toolcall_pass')) / t : null;
      },
   },
   'reasoning %': {
      fn: (r) => {
         const t = sumF(r, (x) => x.metric === 'reasoning_total');
         return t ? (100 * sumF(r, (x) => x.metric === 'reasoning_correct')) / t : null;
      },
   },
   triage: {
      fn: (r) => {
         const v = avgF(r, (x) => /^triage_[RC]\d+$/.test(x.metric));
         return v == null ? null : 100 * v;
      },
   },
   summarization: {
      fn: (r) => {
         const v = avgF(r, (x) => /^summ_/.test(x.metric));
         return v == null ? null : 100 * v;
      },
   },
   docqa: {
      fn: (r) => {
         const v = avgF(r, (x) => /^docqa_/.test(x.metric));
         return v == null ? null : 10 * v;
      },
   },
   'struct_output %': { fn: (r) => avgF(r, (x) => x.bench === 'struct_output' && x.metric === 'score') },
   'instruction %': { fn: (r) => avgF(r, (x) => x.bench === 'instruction_following' && x.metric === 'score') },
   'agentic %': { fn: (r) => avgF(r, (x) => x.bench === 'agentic_loop' && x.metric === 'score') },
   'coding pass@1 %': {
      fn: (r) => {
         const t = sumF(r, (x) => x.metric === 'coding_total');
         return t ? (100 * sumF(r, (x) => x.metric === 'coding_pass_at_1')) / t : null;
      },
   },
   'decode tok/s': { fn: (r) => avgF(r, (x) => x.bench === 'e2e-8k' && x.metric === 'tok_s') },
   'e2e tok/s': { fn: (r) => avgF(r, (x) => x.bench === 'e2e-8k' && x.metric === 'score') },
   'ttft ms': { fn: (r) => avgF(r, (x) => x.bench === 'ttft-8k' && x.metric === 'score'), lower: true },
   'coder slots': { fn: (r) => maxF(r, (x) => x.bench === 'agent_ctx' && x.metric === 'n_coders') },
   'agent pool k': {
      fn: (r) => {
         const v = maxF(r, (x) => x.bench === 'agent_ctx' && x.metric === 'total_ctx');
         return v == null ? null : v / 1000;
      },
   },
   'planner ctx k': {
      fn: (r) => {
         const v = maxF(r, (x) => x.bench === 'agent_ctx' && x.metric === 'planner_ctx');
         return v == null ? null : v / 1000;
      },
   },
   'fit-ctx': { fn: (r) => maxF(r, (x) => x.bench === 'fit_ctx' && x.metric === 'score') },
   'VRAM MiB': { fn: (r) => maxF(r, (x) => x.bench === 'agent_ctx' && x.metric === 'vram_mib'), lower: true },
   'KV bytes/tok': {
      fn: (r) => {
         const v = avgF(r, (x) => x.bench === 'kv_per_tok' && x.metric === 'score');
         return v == null ? null : 1024 * v;
      },
      lower: true,
   },
};
const M = METRIC_CATALOG;

const filt = (rows, facets) => rows.filter((r) => Object.entries(facets || {}).every(([d, vs]) => !vs || !vs.length || vs.includes(r[d])));
const groupBy = (rows, keyFn) => {
   const m = new Map();
   for (const r of rows) {
      const k = keyFn(r);
      if (!m.has(k)) m.set(k, []);
      m.get(k).push(r);
   }
   return m;
};

export function meta() {
   return {
      metrics: Object.keys(M),
      lowerMetrics: Object.entries(M)
         .filter(([, m]) => m.lower)
         .map(([k]) => k),
      dims: FACET_DIMS,
      pivotDims: PIVOT_DIMS,
   };
}

export function facets(rows) {
   const o = {};
   for (const d of FACET_DIMS) o[d] = [...new Set(rows.map((r) => r[d]).filter((v) => v != null))].sort();
   return o;
}

export function pivot(rows, b) {
   const src = filt(rows, b.facets);
   const mfn = M[b.metric].fn;
   const rset = new Set(),
      cset = new Set(),
      cm = new Map();
   for (const [k, grp] of groupBy(src, (r) => JSON.stringify([r[b.rowsDim], r[b.colsDim]]))) {
      const [rr, cc] = JSON.parse(k);
      if (cc == null) continue;
      rset.add(rr);
      cset.add(cc);
      cm.set(rr + CELL_SEP + cc, mfn(grp));
   }
   const rows2 = [...rset].sort(),
      cols = [...cset].sort();
   const cells = rows2.map((rr) => {
      const base = b.baseline != null ? cm.get(rr + CELL_SEP + b.baseline) : null;
      return {
         r: rr,
         vals: cols.map((cc) => {
            const v = cm.get(rr + CELL_SEP + cc) ?? null;
            return { c: cc, v, delta: base != null && v != null ? v - base : null };
         }),
      };
   });
   return { rows: rows2, cols, cells, metric: b.metric, lower: !!M[b.metric].lower, baseline: b.baseline };
}

// One think mode's worth of pareto points (the chosen think + n/a rows collapse onto one entity).
function paretoPts(rows, xf, yf, vf, think) {
   const rs = rows.filter((r) => r.think_mode === 'n/a' || r.think_mode === think);
   const out = [];
   for (const [k, grp] of groupBy(rs, (r) =>
      JSON.stringify([r.gguf_file, r.quant, r.kv_quant, r.chat_template, r.arch, r.active_params, r.total_params]),
   )) {
      const [g, q, kv, ct, arch, ap, tp] = JSON.parse(k);
      const x = xf(grp),
         y = yf(grp);
      if (x == null || y == null) continue;
      out.push({
         x,
         y,
         vram: vf(grp),
         arch,
         think,
         cfg: { gguf_file: g, quant: q, kv_quant: kv, chat_template: ct, think },
         label: `${g.replace('.gguf', '')} ${kv || ''} ${ct} [${think}]`.replace(/\s+/g, ' ').trim(),
         dims: { gguf_file: g, arch, active_params: ap, total_params: tp },
      });
   }
   return out;
}

export function pareto(rows, b) {
   const think = b.think || 'both';
   const src = filt(rows, b.facets);
   const xf = M[b.xMetric].fn,
      yf = M[b.yMetric].fn,
      vf = M['VRAM MiB'].fn;
   const modes = think === 'both' ? ['no_think', 'think'] : [think];
   const points = modes.flatMap((m) => paretoPts(src, xf, yf, vf, m));
   return { points, xMetric: b.xMetric, yMetric: b.yMetric, think };
}

export function leaderboard(rows, b) {
   const think = b.think || 'both';
   const src = filt(rows, b.facets);
   const dials = b.dials || DEFAULT_DIALS;
   if (think !== 'both') {
      const { entities, denom } = scoreSelection(src, { think, dials });
      return { entities, denom, count: src.length };
   }
   // "both": one row per (config × think variant it actually has). Configs with no
   // think-dependent benches collapse to a single 'n/a' row (not two identical rows).
   const variants = new Map();
   for (const r of src) {
      const k = entityKey(r);
      const tm = r.think_mode || 'n/a';
      if (!variants.has(k)) variants.set(k, new Set());
      if (tm !== 'n/a') variants.get(k).add(tm);
   }
   const noT = scoreSelection(src, { think: 'no_think', dials });
   const yesT = scoreSelection(src, { think: 'think', dials });
   const entities = [];
   for (const e of noT.entities) {
      const v = variants.get(e.key) || new Set();
      if (v.size === 0) {
         e.think = 'n/a';
         entities.push(e);
      } else if (v.has('no_think')) {
         entities.push(e);
      }
   }
   for (const e of yesT.entities) {
      if ((variants.get(e.key) || new Set()).has('think')) entities.push(e);
   }
   return { entities, denom: noT.denom, count: src.length };
}

export function coverage(rows, b) {
   const src = filt(rows, b.facets);
   const cfg = (r) => `${r.gguf_file.replace('.gguf', '')}|${r.kv_quant || ''}|${r.chat_template}`;
   const configs = [...new Set(src.map(cfg))].sort(),
      benches = [...new Set(src.map((r) => r.bench))].sort();
   const have = new Set(src.map((r) => cfg(r) + CELL_SEP + r.bench));
   return { configs, benches, cells: configs.map((c) => ({ cfg: c, has: benches.map((bn) => have.has(c + CELL_SEP + bn)) })) };
}
