// Build-time data loader: snapshot the tidy measurement rows from central-db
// (llmbench.measurements) into a static JSON the client loads with FileAttachment.
// Runs as a plain Node process at build time, so it can import analysis/ + shared/
// freely and needs LLMBENCH_DB_PASSWORD in the env. Benchmark runs write to central-db
// directly, so it is always current — no sync step before building.
//
// Filters to CURRENTLY-ACTIVE models: config/models.yaml entries flagged `disabled: true`
// (parked/retired configs) are dropped so they don't clutter the dashboard.
//
// Also drops `status='partial'` rows: bench-run inserts every row as 'partial' and promotes it to
// 'ok' only once its bench finished, so a partial row is a fragment of a bench that crashed
// mid-way. Charting those would show a half-populated bench as if it were a real result.
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { findIdentityForks, formatForks } from '../../../analysis/identity-forks.mjs';
import { query } from '../../../analysis/pg-store.mjs';
import { loadModelsConfig } from '../../../shared/models-config.mjs';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..', '..');
const active = new Set(loadModelsConfig(join(ROOT, 'config', 'models.yaml')).models.map((m) => m.hf_file));

// $LATEST, not $TIDY: the store is append-only, so a re-measured config keeps its old row too and
// the scoring average downstream would blend the superseded value into the live one. $LATEST already
// excludes 'partial'; the filter below is kept as documentation of intent, not because it is load-bearing.
const all = await query("SELECT * FROM $LATEST WHERE status IS DISTINCT FROM 'partial'");
const rows = all.filter((r) => active.has(r.gguf_file));

// Be loud about what the allowlist ate. The filter is an allowlist over models.yaml `hf_file`, so a
// row whose artifact is not in the config vanishes — and that covers two very different cases: a
// deliberately parked config (fine, that is the point) and a row that no config entry describes at
// all, including any row whose gguf_file is NULL because its engine serves no GGUF. The second case
// is silent data loss: 87 vllm-skinny rows sat unpublished this way with nothing reporting it.
// Publishing is unchanged; only the reporting is. stderr, so the JSON on stdout stays clean.
if (rows.length < all.length) {
   const dropped = all.filter((r) => !active.has(r.gguf_file));
   const byArtifact = new Map();
   for (const r of dropped) {
      const k = `${r.gguf_file ?? '<no artifact>'}  [${r.backend}]`;
      byArtifact.set(k, (byArtifact.get(k) ?? 0) + 1);
   }
   console.warn(`[measurements] ${rows.length}/${all.length} rows published; ${dropped.length} dropped by the models.yaml allowlist:`);
   for (const [k, n] of [...byArtifact].sort((a, b) => b[1] - a[1])) {
      console.warn(`[measurements]   ${String(n).padStart(5)}  ${k}`);
   }
   console.warn(
      '[measurements] A "<no artifact>" line means those rows can never be published — no models.yaml entry can match a NULL gguf_file.',
   );
}

// Identity forks: one physical config live TWICE because an identity dimension's stamping changed
// between runs, so latest-wins never collapsed them. A ROW FORK is the dangerous kind — the differing
// dimension is not an ENTITY_DIM, so both rows land in the same entity and score.mjs AVERAGES them,
// which is how Muse-Glimmer came to publish the mean of a 2-GPU and a single-GPU throughput
// measurement (485.08 for values 488.72 and 481.44). Nothing about that looks wrong on the page,
// which is exactly why it is reported here, at the only point every publish must pass through.
// ENTITY FORKS are listed separately: they split the config into two dashboard rows, and some are
// deliberate A/Bs (spec_decode none-vs-mtp on the ninfer entry), so they need a human read.
const forks = findIdentityForks(rows);
const rowForks = forks.filter((f) => f.kind === 'ROW FORK');
const entityForks = forks.filter((f) => f.kind === 'ENTITY FORK');
if (rowForks.length) {
   console.warn(`[measurements] *** ${rowForks.length} ROW FORK(S): a value below is the AVERAGE of two`);
   console.warn('[measurements] *** measurements of one config, taken under different serving details.');
   for (const l of formatForks(rowForks, { limit: 12 })) {
      console.warn(`[measurements] ${l}`);
   }
   console.warn('[measurements] *** Fix: delete the whole stale STACK at that identity, not just the live');
   console.warn('[measurements] *** row — removing the tip promotes the superseded row underneath it.');
}
if (entityForks.length) {
   console.warn(
      `[measurements] ${entityForks.length} entity fork(s) — one config, two dashboard rows. Deliberate A/Bs look like this too:`,
   );
   for (const l of formatForks(entityForks, { limit: 4 })) {
      console.warn(`[measurements] ${l}`);
   }
}

process.stdout.write(JSON.stringify(rows));
