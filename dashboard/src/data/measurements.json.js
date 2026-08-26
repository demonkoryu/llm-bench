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

process.stdout.write(JSON.stringify(rows));
