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

const rows = (await query("SELECT * FROM $TIDY WHERE status IS DISTINCT FROM 'partial'")).filter((r) => active.has(r.gguf_file));
process.stdout.write(JSON.stringify(rows));
