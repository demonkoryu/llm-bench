#!/usr/bin/env node
// Retire swe_live rows that a later measurement of the same configuration has superseded.
//
// WHY THIS IS NEEDED AT ALL. `host` is part of pg-store's IDENTITY_KEY, so a rose row never
// supersedes a rose-gpu1 one. But which of the two V100 lanes claimed a configuration is an
// accident of a shared work queue, not a property of the result -- hosts.yaml deliberately gives
// both targets the same `gpu: V100` slug because they are the same silicon. So a configuration that
// the v1 sweep ran on one card and the v2 sweep on the other ends up with BOTH row sets live, and
// nothing downstream keys on host: the dashboard's SWE page groups by (artifact x spec_decode) and
// takes last-writer-wins per metric, so it can pair a 5 from the old rows with a total of 16 from
// the new ones and publish 31%. The number would be wrong in a way no one could reproduce, because
// it depends on row order in a JSON file.
//
// This is the same failure analysis/invalidate-superseded-host.mjs was written for, generalised
// from one hardcoded artifact to the rule that actually applies: for one configuration there is
// exactly one current swe_live measurement, and it is the newest one.
//
// A configuration whose ONLY measurement is against an older pin is LEFT ALONE. Retiring it would
// blank it from the page rather than de-duplicate anything, and the page already labels it as
// measured against a smaller pin.
//
// Nothing is deleted. Rows keep their values in $TIDY for provenance and only stop being
// publishable ($LATEST drops 'invalid') and stop counting as measured (bench-run's resume done-set
// filters status='ok').
//
// CLI:  node analysis/retire-superseded-swe-pins.mjs           # dry run
//       node analysis/retire-superseded-swe-pins.mjs --apply
import { query } from './pg-store.mjs';

const APPLY = process.argv.includes('--apply');

const rows = await query("SELECT gguf_file, host, metric, metric_value, ts FROM $LATEST WHERE bench = 'swe_live' AND status = 'ok'");

// When each (artifact, host) was last MEASURED, as opposed to last written. A backfill supersedes
// rows at the identity it corrects and stamps them with a fresh timestamp, so "newest row" can point
// at a host the configuration has not run on since the previous pin -- which is exactly how the
// phantom entity this script cleans up came to exist. Rows whose run_id carries the backfill's
// `-swefix` suffix are therefore excluded: a correction is not a measurement.
const measured = new Map();
for (const r of await query(
   "SELECT gguf_file, host, max(ts) AS ts FROM $TIDY WHERE bench = 'swe_live' AND run_id NOT LIKE '%-swefix' GROUP BY 1, 2",
)) {
   measured.set(`${r.gguf_file}\u241F${r.host}`, r.ts);
}

// One bucket per (artifact, host): the two dimensions that can disagree for what is meant to be a
// single measurement.
const buckets = new Map();
for (const r of rows) {
   const k = `${r.gguf_file}␟${r.host}`;
   const b = buckets.get(k) ?? {
      gguf_file: r.gguf_file,
      host: r.host,
      ts: r.ts,
      // Falls back to the row timestamp for an entity with no un-suffixed run at all, which would
      // mean every row it has came from a correction — rare, and better ranked than skipped.
      measuredAt: measured.get(k) ?? r.ts,
      n: 0,
   };
   b.n += 1;
   if (new Date(r.ts) > new Date(b.ts)) {
      b.ts = r.ts;
   }
   if (r.metric === 'swe_total') {
      b.total = r.metric_value;
   }
   if (r.metric === 'swe_resolved') {
      b.resolved = r.metric_value;
   }
   buckets.set(k, b);
}

const byArtifact = new Map();
for (const b of buckets.values()) {
   byArtifact.set(b.gguf_file, [...(byArtifact.get(b.gguf_file) ?? []), b]);
}

let retired = 0;
for (const [gguf, list] of [...byArtifact].sort()) {
   if (list.length < 2) {
      continue;
   }
   // The most recently MEASURED entity wins. Not "largest swe_total": a later measurement is
   // authoritative even when it scores the same instance count, and ranking by total would keep a
   // stale row alive forever the moment two pins happened to be the same size.
   const keep = list.reduce((a, b) => (new Date(b.measuredAt) > new Date(a.measuredAt) ? b : a));
   console.log(`${gguf}`);
   for (const b of list) {
      const tag = b === keep ? 'KEEP   ' : 'RETIRE ';
      console.log(
         `  ${tag} ${String(b.resolved ?? '?')}/${String(b.total ?? '?')}  ${b.n} rows  measured ${new Date(b.measuredAt).toISOString()}  host=${b.host}`,
      );
   }
   for (const b of list) {
      if (b === keep) {
         continue;
      }
      retired += 1;
      if (!APPLY) {
         continue;
      }
      const res = await query(
         `UPDATE measurements SET status = 'invalid'
          WHERE bench = 'swe_live' AND gguf_file = '${b.gguf_file}' AND host = '${b.host}' AND status = 'ok'
          RETURNING 1`,
      );
      console.log(`           -> marked ${res.length} rows invalid`);
   }
}
console.log(retired === 0 ? 'nothing to retire' : `${retired} superseded entit${retired === 1 ? 'y' : 'ies'}${APPLY ? ' retired' : ' would be retired (dry run)'}`);
