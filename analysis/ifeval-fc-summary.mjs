#!/usr/bin/env node
// Print the stored ifeval_fc results as a funnel. A committed script rather than an inline heredoc,
// for the reason swe-live-summary.mjs exists: quoting SQL through several layers of shell escaping
// is how a post-sweep log came to report `column "swe_live" does not exist` on an otherwise clean run.
//
// The FUNNEL is the point. A rate alone cannot distinguish a configuration that never emitted a tool
// call from one that called correctly and then miscounted commas, and those are different failures.
import { loadManifest } from '../benches/ifeval_fc.mjs';
import { query } from './pg-store.mjs';
import { wilson } from './score.mjs';

const checkers = loadManifest().checkers.map((c) => c.replace(/Checker$/, ''));
const rows = await query(
   "SELECT gguf_file, think_mode, metric, metric_value FROM $LATEST WHERE bench = 'ifeval_fc' AND status = 'ok'",
);
const by = {};
for (const r of rows) {
   const k = `${r.gguf_file}␟${r.think_mode}`;
   by[k] ??= { gguf: r.gguf_file, think: r.think_mode };
   by[k][r.metric] = r.metric_value;
}
const pct = (v) => (v == null ? '   -' : `${(v * 100).toFixed(0)}%`.padStart(4));
const entries = Object.values(by).sort((a, b) => (b.ifeval_fc_rate ?? 0) - (a.ifeval_fc_rate ?? 0));
if (entries.length === 0) {
   console.log('no ifeval_fc rows stored yet');
} else {
   for (const m of entries) {
      const w = wilson(m.ifeval_fc_pass, m.ifeval_fc_total);
      console.log(
         `  ${`${m.ifeval_fc_pass}/${m.ifeval_fc_total}`.padEnd(8)} ${pct(w?.p)} [${((w?.lo ?? 0) * 100).toFixed(0)}-${((w?.hi ?? 0) * 100).toFixed(0)}%]` +
            `  called ${String(m.ifeval_fc_called).padStart(3)} param ${String(m.ifeval_fc_param).padStart(3)} req_fail ${String(m.ifeval_fc_req_fail ?? 0).padStart(2)}` +
            `  ${String(m.think).padEnd(8)} ${m.gguf}`,
      );
   }
   // Per-checker, across configurations: which constraints the fleet as a whole fails.
   console.log('\n  per-checker mean pass rate (all configurations):');
   for (const c of checkers) {
      const vals = entries.map((m) => m[`ifeval_fc_chk_${c}`]).filter((v) => v != null);
      if (vals.length) {
         console.log(`    ${c.padEnd(28)} ${pct(vals.reduce((a, b) => a + b, 0) / vals.length)}  (n=${vals.length})`);
      }
   }
}
