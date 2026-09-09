// Flatten scored entities (from query-engine leaderboard) into table rows + a column spec.
// Mirrors the previous explorer's leaderboard columns; the drag-to-reorder sort priority is
// replaced by Inputs.table's built-in click-to-sort (idiomatic Framework).
const pct = (v) => (v == null ? null : v * 100);

// key → { get(entity), dec, lower?, norm100? }. `dec` = display decimals; `lower` marks
// lower-is-better (charts sort ascending and label the axis accordingly); `norm100` marks a score
// already normalized to 0-100 within the selection, so a chart can pin the axis instead of scaling
// to the data and making a weak field look strong.
export const BOARD_COLUMNS = [
   { norm100: true, key: 'capability', get: (e) => e.capability, dec: 1 },
   { norm100: true, key: 'comp', get: (e) => pct(e.comprehension), dec: 1 },
   { norm100: true, key: 'coding', get: (e) => pct(e.coding), dec: 1 },
   { norm100: true, key: 'speed', get: (e) => pct(e.speed), dec: 1 },
   { norm100: true, key: 'fleet', get: (e) => e.fleet_suitability, dec: 1 },
   { key: 'agent slots', get: (e) => e.fleet_slots, dec: 0 },
   { key: 'pool k', get: (e) => (e.raw?.agent_ctx == null ? null : e.raw.agent_ctx / 1000), dec: 0 },
   { key: 'fit-ctx k', get: (e) => (e.raw?.fit_ctx == null ? null : e.raw.fit_ctx / 1000), dec: 0 },
   { key: 'e2e tok/s', get: (e) => e.raw?.e2e_throughput, dec: 1 },
   { key: 'ttft ms', get: (e) => e.raw?.ttft, dec: 0, lower: true },
   { key: 'vram MiB', get: (e) => e.raw?._vram_at_ctx, dec: 0, lower: true },
   // Renamed with the metric (7273549): the scoring key is _vram_per_ctx_tok_kib and the quantity
   // is VRAM-per-context-token, not cache size. The old key silently returned null after that commit.
   { key: 'vram KiB/ctx-tok', get: (e) => e.raw?._vram_per_ctx_tok_kib, dec: 2, lower: true },
];

// Per-column number formatters for Inputs.table (nulls render as em dash).
export const boardFormat = Object.fromEntries(
   BOARD_COLUMNS.map((c) => [c.key, (v) => (v == null || Number.isNaN(v) ? '—' : (+v).toFixed(c.dec))]),
);

// Artifact filename -> display name. `labels` is the build-time map from config/models.yaml
// (data/model-labels.json); anything missing falls back to the stripped basename, which is what
// this used to do unconditionally and still reads fine for llama.cpp-style filenames. Safe to call
// on non-model values too (pivot passes whatever dimension is on its row axis).
export const modelName = (v, labels) => labels?.[v] ?? String(v).replace('.gguf', '');

export function boardRows(entities, labels) {
   return entities.map((e) => {
      const row = {
         model: modelName(e.dims.gguf_file, labels),
         template: e.dims.chat_template,
         kv: e.dims.kv_quant ?? '—',
         spec: e.dims.spec_decode ?? '—',
         think: e.think ?? '—',
         family: e.dims.family,
      };
      for (const c of BOARD_COLUMNS) {
         row[c.key] = c.get(e);
      }
      return row;
   });
}

// A short "model kv [think]" label for the ranking chart. chat_template and spec_decode are entity
// dimensions, so two configs that differ ONLY by template (or only by speculative decoding) are
// distinct rows; without them in the label they collapse onto one bar (two values, one row). Append
// each when it is not the default so those variants are visually distinct. ('—'/missing template is
// treated as default → no suffix; missing spec_decode means plain autoregressive decode.)
export const boardLabel = (r) => {
   const tpl = r.template && r.template !== 'builtin' && r.template !== '—' ? ` ·${r.template}` : '';
   const spec = r.spec && r.spec !== '—' ? ` ·${r.spec}` : '';
   return `${r.model} ${r.kv === '—' ? '' : r.kv} [${r.think}]${tpl}${spec}`.replace(/\s+/g, ' ').trim();
};
