// Flatten scored entities (from query-engine leaderboard) into table rows + a column spec.
// Mirrors the previous explorer's leaderboard columns; the drag-to-reorder sort priority is
// replaced by Inputs.table's built-in click-to-sort (idiomatic Framework).
const pct = (v) => (v == null ? null : v * 100);

// key → { get(entity), dec, lower? }. `dec` = display decimals; `lower` marks lower-is-better.
export const BOARD_COLUMNS = [
   { key: 'capability', get: (e) => e.capability, dec: 1 },
   { key: 'comp', get: (e) => pct(e.comprehension), dec: 1 },
   { key: 'coding', get: (e) => pct(e.coding), dec: 1 },
   { key: 'speed', get: (e) => pct(e.speed), dec: 1 },
   { key: 'fleet', get: (e) => e.fleet_suitability, dec: 1 },
   { key: 'agent slots', get: (e) => e.fleet_slots, dec: 0 },
   { key: 'pool k', get: (e) => (e.raw?.agent_ctx == null ? null : e.raw.agent_ctx / 1000), dec: 0 },
   { key: 'fit-ctx k', get: (e) => (e.raw?.fit_ctx == null ? null : e.raw.fit_ctx / 1000), dec: 0 },
   { key: 'e2e tok/s', get: (e) => e.raw?.e2e_throughput, dec: 1 },
   { key: 'ttft ms', get: (e) => e.raw?.ttft, dec: 0, lower: true },
   { key: 'vram MiB', get: (e) => e.raw?._vram_at_ctx, dec: 0, lower: true },
   { key: 'kv KiB/tok', get: (e) => e.raw?._kv_per_tok_kib, dec: 2, lower: true },
];

// Per-column number formatters for Inputs.table (nulls render as em dash).
export const boardFormat = Object.fromEntries(
   BOARD_COLUMNS.map((c) => [c.key, (v) => (v == null || Number.isNaN(v) ? '—' : (+v).toFixed(c.dec))]),
);

export function boardRows(entities) {
   return entities.map((e) => {
      const row = {
         model: e.dims.gguf_file.replace('.gguf', ''),
         template: e.dims.chat_template,
         kv: e.dims.kv_quant ?? '—',
         think: e.think ?? '—',
         family: e.dims.family,
      };
      for (const c of BOARD_COLUMNS) row[c.key] = c.get(e);
      return row;
   });
}

// A short "model kv [think]" label for the ranking chart.
export const boardLabel = (r) => `${r.model} ${r.kv === '—' ? '' : r.kv} [${r.think}]`.replace(/\s+/g, ' ').trim();
