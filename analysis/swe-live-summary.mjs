#!/usr/bin/env node
// Print the stored swe_live results with Wilson intervals. A committed script rather than an inline
// shell heredoc, because quoting SQL string literals through several layers of shell escaping is how
// the post-sweep log came to report `column "swe_live" does not exist` on an otherwise clean run.
import { loadManifest } from '../benches/swe_live.mjs';
import { query } from './pg-store.mjs';
import { wilson } from './score.mjs';

// Languages come from the ACTIVE pin rather than a literal list. The four were hardcoded here, so
// adding cpp in v6 would have dropped its column silently -- the one failure mode a summary must not
// have, since its whole job is to be the thing you read instead of the database.
const LANGS = loadManifest().languages;

const rows = await query("SELECT gguf_file, metric, metric_value FROM $LATEST WHERE bench = 'swe_live' AND status = 'ok'");
const by = {};
for (const r of rows) {
   by[r.gguf_file] ??= {};
   by[r.gguf_file][r.metric] = r.metric_value;
}
const pct = (v) => (v == null ? '  - ' : `${(v * 100).toFixed(0)}%`.padStart(4));
for (const [gguf, m] of Object.entries(by).sort((a, b) => b[1].swe_resolved - a[1].swe_resolved)) {
   const w = wilson(m.swe_resolved, m.swe_total);
   console.log(
      `  ${`${m.swe_resolved}/${m.swe_total}`.padEnd(6)} ${pct(w.p)} [${(w.lo * 100).toFixed(0)}-${(w.hi * 100).toFixed(0)}%]` +
         `  no-patch ${String(m.swe_no_patch).padEnd(2)} timeouts ${m.swe_timeouts}` +
         `  | ${LANGS.map((l) => `${l} ${pct(m[`swe_lang_${l}`])}`).join(' ')}` +
         `  | ${gguf}`,
   );
}
