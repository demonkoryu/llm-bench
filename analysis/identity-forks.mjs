// Audit: one physical config appearing as TWO live measurements because an identity dimension's
// stamping changed between runs.
//
// $LATEST is a latest-wins DISTINCT ON over IDENTITY_KEY (analysis/pg-store.mjs). Latest-wins only
// works when a re-measurement lands on the SAME key. When the value written into an identity
// dimension changes — a bug fix that makes `ctx` reflect what was measured (3f7f9b9), a model entry
// gaining `spec_decode: draft-mtp`, a template rename — the new rows land on a DIFFERENT key, so
// they never supersede the old ones and BOTH stay live. The stale half keeps publishing.
//
// This has bitten three times, each with a different dimension and a different symptom:
//   · ctx          → Qwen3.8-27B agent_ctx published `n_coders=0` (a pre-fix false skip verdict)
//                    beside the correct `n_coders=5`.
//   · spec_decode  → 362 rows stamped NULL gave Qwen3.8-27B a second entity that scored 100 on the
//                    speed board with no throughput measured at all.
//   · unresolved   → qwen3_6_35b_a3b.ninfer reports 4 AND 6 coders at ctx=131072 on one host.
//
// Two distinct symptoms, both reported here:
//   ROW FORK     the differing dimension is NOT an ENTITY_DIM, so both rows land in the same
//                dashboard entity and score.mjs's pickMean AVERAGES them. An old 0 and a new 5
//                silently become 2.5. This is the dangerous one — nothing looks wrong.
//   ENTITY FORK  the differing dimension IS an ENTITY_DIM, so the config splits into two dashboard
//                rows. Visible, but the stale row competes in every ranking.
import { ENTITY_DIMS } from './scoring-config.mjs';

// The dimensions that identify WHICH MEASUREMENT this is, independent of serving details. Two live
// rows agreeing on all of these are the same number measured twice and must not coexist.
const MEASUREMENT_DIMS = ['gguf_file', 'quant', 'kv_quant', 'backend', 'gpu', 'host', 'bench', 'metric', 'case_id', 'think_mode'];
// The rest of IDENTITY_KEY: serving details whose stamping has changed before and will again.
const DETAIL_DIMS = ['chat_template', 'sampling_hash', 'ctx', 'n_parallel', 'batch', 'ubatch', 'spec_decode'];

const key = (r, dims) => dims.map((d) => (r[d] == null ? '∅' : String(r[d]))).join('␟');

/**
 * @param rows live rows ($LATEST), already filtered to whatever scope you care about
 * @returns array of forks, worst first: { dims, kind, group, variants: [{value, rows, first, last, sample}] }
 */
export function findIdentityForks(rows) {
   const groups = new Map();
   for (const r of rows) {
      const k = key(r, MEASUREMENT_DIMS);
      if (!groups.has(k)) {
         groups.set(k, []);
      }
      groups.get(k).push(r);
   }
   const forks = [];
   for (const [, list] of groups) {
      if (list.length < 2) {
         continue;
      }
      // Which detail dimension(s) actually differ across these otherwise-identical measurements?
      const differing = DETAIL_DIMS.filter((d) => new Set(list.map((r) => String(r[d] ?? '∅'))).size > 1);
      if (!differing.length) {
         continue; // same key twice would be a pg-store bug, not a fork; not this audit's business
      }
      const byVariant = new Map();
      for (const r of list) {
         const vk = differing.map((d) => `${d}=${r[d] ?? 'NULL'}`).join(' ');
         if (!byVariant.has(vk)) {
            byVariant.set(vk, []);
         }
         byVariant.get(vk).push(r);
      }
      const variants = [...byVariant].map(([value, rs]) => ({
         value,
         rows: rs.length,
         // The actual live rows, so a caller can act on a fork by measurement_id instead of
         // reconstructing a query from the display string (which silently mismatched on a trailing
         // space the first time it was tried).
         ids: rs.map((r) => r.measurement_id),
         first: new Date(Math.min(...rs.map((r) => +new Date(r.ts)))),
         last: new Date(Math.max(...rs.map((r) => +new Date(r.ts)))),
         sample: rs[0].metric_value,
      }));
      variants.sort((a, b) => +a.last - +b.last);
      const spread = Math.max(...variants.map((v) => Number(v.sample) || 0)) - Math.min(...variants.map((v) => Number(v.sample) || 0));
      forks.push({
         dims: differing,
         // An ENTITY_DIM fork splits the dashboard row; anything else gets averaged by pickMean.
         kind: differing.some((d) => ENTITY_DIMS.includes(d)) ? 'ENTITY FORK' : 'ROW FORK',
         group: `${list[0].gguf_file ?? '—'} kv=${list[0].kv_quant ?? '—'} ${list[0].backend}/${list[0].host} · ${list[0].bench}.${list[0].metric}${list[0].case_id ? `[${list[0].case_id}]` : ''} · ${list[0].think_mode}`,
         variants,
         // Disjoint in time. For a ROW FORK that means one superseded the other in intent but not in
         // identity — i.e. stale. For an ENTITY FORK it means nothing on its own: a deliberate A/B is
         // also measured sequentially, which is exactly how the ninfer spec_decode none-vs-mtp pair
         // got mistaken for a conflict twice. Reported, never interpreted, for entity forks.
         staleLooking: variants.length === 2 && +variants[0].last < +variants[1].first,
         spread,
      });
   }
   // Worst first: a ROW FORK silently averages, and a wide value spread means the average is far off.
   return forks.sort((a, b) => (a.kind === b.kind ? b.spread - a.spread : a.kind === 'ROW FORK' ? -1 : 1));
}

/** One-line-per-fork report. Returns [] when clean, so callers can print nothing. */
export function formatForks(forks, { limit = 20 } = {}) {
   const out = [];
   for (const f of forks.slice(0, limit)) {
      const disjoint = f.staleLooking
         ? f.kind === 'ROW FORK'
            ? ' · time-disjoint → the older one is stale'
            : ' · measured sequentially (A/B or stale — needs a read)'
         : '';
      out.push(`${f.kind} · ${f.dims.join(',')} · ${f.group}${disjoint}`);
      for (const v of f.variants) {
         out.push(
            `    ${v.value} → ${v.rows} row(s), value ${v.sample}, ${v.first.toISOString().slice(0, 16)}..${v.last.toISOString().slice(0, 16)}`,
         );
      }
   }
   if (forks.length > limit) {
      out.push(`… ${forks.length - limit} more`);
   }
   return out;
}
