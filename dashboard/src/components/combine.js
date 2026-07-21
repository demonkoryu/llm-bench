// Pure combine/normalize logic for the Compromise page (no Observable/DOM deps → unit-testable
// in Node). The x-axis is a user-weighted blend of capability dimensions; each dimension maps a
// scored entity (from query-engine leaderboard) to a 0–100 higher-is-better value.

const pct = (v) => (v == null ? null : v * 100);
const normDim = (key, label) => ({ key, label: label ?? key, get: (e) => (e.norm?.[key] == null ? null : e.norm[key] * 100) });

// The capability dimensions offered for the weighted x-axis. Composites come straight off the
// entity (capability already 0–100; comprehension/coding are 0–1 → ×100); leaves read the engine's
// per-metric normalized score e.norm[k] (0–1, direction-corrected) → ×100.
export const X_DIMS = [
   { key: 'capability', label: 'capability', get: (e) => e.capability },
   { key: 'comprehension', label: 'comprehension', get: (e) => pct(e.comprehension) },
   { key: 'coding', label: 'coding', get: (e) => pct(e.coding) },
   normDim('reasoning'),
   normDim('triage'),
   normDim('docqa'),
   normDim('summarization'),
   normDim('toolcalling'),
   normDim('struct_output', 'struct out'),
   normDim('instruction_following', 'instruction'),
   normDim('agentic_loop', 'agentic'),
   normDim('coding_grade', 'coding grade'),
];

export const X_DIM_KEYS = X_DIMS.map((d) => d.key);

/** Per-entity 0–100 score for every x dimension (null where the config lacks that metric). */
export function capabilityScores(entity) {
   const out = {};
   for (const d of X_DIMS) { out[d.key] = d.get(entity); }
   return out;
}

/**
 * Weighted arithmetic mean of the dimensions with weight > 0 that have a value. A dimension with
 * weight > 0 but a null score is skipped (its weight doesn't count) rather than treated as 0.
 * @param {Object<string,number>} scores   { dimKey: 0–100 | null }
 * @param {Object<string,number>} weights  { dimKey: weight }
 * @returns {{ combined: number|null, parts: {key,score,weight}[] }}
 */
export function combine(scores, weights) {
   let wsum = 0;
   let acc = 0;
   const parts = [];
   for (const [key, w] of Object.entries(weights || {})) {
      if (!(w > 0)) { continue; }
      const s = scores?.[key];
      if (s == null || Number.isNaN(s)) { continue; }
      wsum += w;
      acc += w * s;
      parts.push({ key, score: s, weight: w });
   }
   return { combined: wsum > 0 ? acc / wsum : null, parts };
}

/**
 * Indices of the non-dominated ("Pareto frontier") points, maximizing both x and y. A point is
 * dominated if another point is >= on both axes and strictly greater on at least one. Points with
 * a null x or y are excluded. Identical points are all kept (none strictly dominates another).
 * @param {{x:number,y:number}[]} points
 * @returns {number[]} indices into `points`
 */
export function frontier(points) {
   const out = [];
   for (let i = 0; i < points.length; i++) {
      const pi = points[i];
      if (pi?.x == null || pi?.y == null) { continue; }
      let dominated = false;
      for (let j = 0; j < points.length; j++) {
         if (j === i) { continue; }
         const pj = points[j];
         if (pj?.x == null || pj?.y == null) { continue; }
         if (pj.x >= pi.x && pj.y >= pi.y && (pj.x > pi.x || pj.y > pi.y)) { dominated = true; break; }
      }
      if (!dominated) { out.push(i); }
   }
   return out;
}
