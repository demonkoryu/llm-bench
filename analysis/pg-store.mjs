// Central-Postgres store — the PRIMARY store for measurement rows: the `llmbench.measurements`
// table on the house server (central-db, 192.168.1.120:5432). bench-run writes here directly
// (insertRows), and the dashboard/analysis read here (query). There is no Parquet dataset and
// no sync step — Postgres is the single source of truth.
//
// Access is a thin native-Postgres client (porsager `postgres`). The table schema is GENERATED
// from shared/tidy-schema.mjs (COLUMNS) so it can't drift. NOTE: measurement_id is a SOFT dedup hint,
// not unique — the same config re-measured across runs appends a second row rather than replacing the
// first. Reads that report a number must therefore go through `$LATEST` (latest-wins, see below), NOT
// `$TIDY`. Averaging every row, which is what consumers did before 2026-08-26, blends superseded
// measurements into live ones.
//
// Connection comes from the environment (never committed):
//   LLMBENCH_PG_HOST      (default 192.168.1.120)
//   LLMBENCH_PG_PORT      (default 5432)
//   LLMBENCH_PG_DB        (default llmbench)
//   LLMBENCH_PG_USER      (default llmbench)
//   LLMBENCH_DB_PASSWORD  (required; also accepts LLMBENCH_PG_PASSWORD / PGPASSWORD)
import { existsSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import postgres from 'postgres';
import { COLUMN_NAMES, COLUMNS } from '../shared/tidy-schema.mjs';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');

// Schema type token (tidy-schema COLUMNS) → PostgreSQL column type.
const PG_TYPE = { VARCHAR: 'TEXT', DOUBLE: 'DOUBLE PRECISION', TIMESTAMP: 'TIMESTAMP', BOOLEAN: 'BOOLEAN', BIGINT: 'BIGINT' };

// Load the repo-root `.env` into process.env ONCE, but only for keys not already set — so an
// explicit env var (e.g. the CI Actions secret) always wins and CI needs no `.env` file. This
// lets every entrypoint (bench-run, caps-seed, the dashboard loader) pick up the DB credential
// with zero per-script plumbing. Minimal KEY=VALUE parser (skips blanks/`#`; strips one layer
// of surrounding quotes). Never logs values.
let _envLoaded = false;
function loadDotEnv() {
   if (_envLoaded) {
      return;
   }
   _envLoaded = true;
   const path = join(ROOT, '.env');
   if (!existsSync(path)) {
      return;
   }
   for (const line of readFileSync(path, 'utf8').split('\n')) {
      const t = line.trim();
      if (!t || t.startsWith('#')) {
         continue;
      }
      const eq = t.indexOf('=');
      if (eq < 0) {
         continue;
      }
      const key = t.slice(0, eq).trim();
      if (key in process.env) {
         continue;
      }
      let val = t.slice(eq + 1).trim();
      if (val.length >= 2 && ((val[0] === '"' && val.at(-1) === '"') || (val[0] === "'" && val.at(-1) === "'"))) {
         val = val.slice(1, -1);
      }
      process.env[key] = val;
   }
}

function pgConfig() {
   loadDotEnv();
   const password = process.env.LLMBENCH_DB_PASSWORD || process.env.LLMBENCH_PG_PASSWORD || process.env.PGPASSWORD;
   if (!password) {
      throw new Error('missing DB password — set LLMBENCH_DB_PASSWORD (the llmbench role password from infra/postgres/.env)');
   }
   return {
      host: process.env.LLMBENCH_PG_HOST || '192.168.1.120',
      port: Number(process.env.LLMBENCH_PG_PORT || 5432),
      database: process.env.LLMBENCH_PG_DB || 'llmbench',
      user: process.env.LLMBENCH_PG_USER || 'llmbench',
      password,
   };
}
/** Non-secret description for logs (never includes the password). */
export function pgInfo() {
   const c = pgConfig();
   return `${c.user}@${c.host}:${c.port}/${c.database}`;
}

// One CREATE TABLE, generated from the tidy COLUMNS (order + types). No PK — the store is
// append-only and measurement_id is not unique across the dataset (see header note).
function ddl() {
   const cols = COLUMN_NAMES.map((c) => {
      const t = PG_TYPE[COLUMNS[c]];
      if (!t) {
         throw new Error(`no PG type mapping for ${c} (${COLUMNS[c]})`);
      }
      return `"${c}" ${t}`;
   });
   return `CREATE TABLE IF NOT EXISTS measurements (${cols.join(', ')})`;
}

// Redact the password out of any error/log surface.
function scrub(msg, pw) {
   return pw ? String(msg).replaceAll(pw, '***') : String(msg);
}

// Numeric column OIDs: int2/int4/int8, float4/float8, numeric. Some (int8, numeric — and, under
// the simple-query path, floats) arrive as strings to guard precision; coerce them all to JS
// Number so consumers see numbers, matching the old DuckDB boundary. Non-numeric types (text,
// timestamp→Date, bool) are left as the driver returns them.
const NUMERIC_OIDS = new Set([20, 21, 23, 700, 701, 1700]);

let _sql = null;
function conn() {
   if (_sql) {
      return _sql;
   }
   const cfg = pgConfig();
   _sql = postgres({
      host: cfg.host,
      port: cfg.port,
      database: cfg.database,
      username: cfg.user,
      password: cfg.password,
      max: 4,
      // Let idle connections close so short-lived CLIs (dashboard loader, caps-seed) exit
      // naturally without a caller having to close the pool.
      idle_timeout: 3,
      onnotice: () => {},
   });
   return _sql;
}

// Columns added after the table's first creation. CREATE TABLE IF NOT EXISTS never alters an
// existing table, so new COLUMNS entries need an explicit idempotent ADD COLUMN here.
const ADDED_COLUMNS = ['scope', 'sampling_hash', 'engine_version', 'model'];

/** Create the measurements table in Postgres if absent, and add any later columns (idempotent). */
export async function ensureSchema() {
   const sql = conn();
   const { password } = pgConfig();
   try {
      await sql.unsafe(ddl());
      for (const c of ADDED_COLUMNS) {
         await sql.unsafe(`ALTER TABLE measurements ADD COLUMN IF NOT EXISTS "${c}" ${PG_TYPE[COLUMNS[c]]}`);
      }
   } catch (e) {
      throw new Error(scrub(e.message || e, password));
   }
}

/**
 * Append tidy measurement rows to measurements — the write path used by bench-run. A
 * parameterized bulk insert, chunked to stay under Postgres' parameter cap; JS numbers/nulls
 * map straight onto the DOUBLE/BIGINT/NULL column types. Append-only by design: the dataset
 * unions every run and scoring averages duplicates; re-run idempotency comes from bench-run's
 * --resume, not from dedup here.
 * @returns {{ rows: number }}
 */
export async function insertRows(rows) {
   if (!rows.length) {
      return { rows: 0 };
   }
   await ensureSchema();
   const sql = conn();
   const { password } = pgConfig();
   // ~37 columns/row; keep params well under Postgres' 65535 cap.
   const CHUNK = 1000;
   try {
      for (let i = 0; i < rows.length; i += CHUNK) {
         const batch = rows.slice(i, i + CHUNK);
         await sql`INSERT INTO measurements ${sql(batch, ...COLUMN_NAMES)}`;
      }
   } catch (e) {
      throw new Error(scrub(e.message || e, password));
   }
   return { rows: rows.length };
}

/**
 * Promote a run's `partial` rows for the named benches to `status='ok'` — the completion marker
 * bench-run writes once a bench's run() returns without throwing.
 *
 * Rows are inserted as 'partial' the moment they are measured (so a crash never loses work) and
 * only become 'ok' here. That makes a half-finished bench VISIBLY half-finished: resume counts a
 * combo done only when it has 'ok' rows, so a probe that died after 3 of its 12 rungs is retried
 * instead of being treated as complete forever.
 *
 * Deliberately narrow: scoped to ONE run_id, touches ONLY the `status` column, and only ever
 * 'partial' → 'ok'. It can never alter a measurement value or another run's rows.
 * @returns {{ rows: number }} rows promoted
 */
export async function markBenchesComplete(run_id, benches) {
   if (!run_id || !benches?.length) {
      return { rows: 0 };
   }
   const sql = conn();
   const { password } = pgConfig();
   try {
      const r = await sql`UPDATE measurements SET status = 'ok'
         WHERE run_id = ${run_id} AND status = 'partial' AND bench IN ${sql(benches)}`;
      return { rows: r.count ?? 0 };
   } catch (e) {
      throw new Error(scrub(e.message || e, password));
   }
}

// The config identity of a measurement: two rows sharing these dims (plus metric/case_id) measure
// THE SAME THING, so a later one supersedes an earlier one rather than adding a second sample. This
// is deliberately the same list as bench-run's RESUME_KEY — if resume considers a combo already
// measured, then a re-measurement of it must supersede, or the two would disagree. Keep them in step.
const IDENTITY_KEY = [
   'gguf_file',
   'kv_quant',
   'chat_template',
   'sampling_hash',
   'ctx',
   'n_parallel',
   'batch',
   'ubatch',
   'spec_decode',
   'host',
   'backend',
   'gpu',
   'bench',
   'think_mode',
   // Not in RESUME_KEY because resume works per (config x bench) while a bench emits many rows;
   // these split one bench's rows apart so dedup never collapses distinct metrics or cases.
   'metric',
   'case_id',
];
// Known limit, verified harmless as of 2026-08-26: sampling_hash is NULL on all pre-August rows and on
// probes, and a NULL identity never matches a hashed one — so a legacy measurement re-measured after
// the hash landed would keep BOTH rows. Audited: 0 such groups exist. Self-healing too, since resume
// keys on the same column and re-measures the legacy combo rather than skipping it.

// Latest-wins is a RESTORED policy, not a new one. `shared/results-csv.mjs` enforced it explicitly
// ("Newest row wins: a re-run supersedes the prior value for the same model/think/bench, regardless of
// whether it's higher or lower") until commit 53d7540 purged the legacy CSV path; the Postgres-native
// replacement never carried it over, and re-runs silently went from superseding to averaging. Do not
// delete this projection without putting the policy somewhere else first.
//
// Latest-wins projection of `measurements`. The table is append-only with no PK, so re-measuring a
// config INSERTS a second row instead of replacing the first, and every consumer that aggregates
// (the dashboard's scoring average, caps-cache's avg/max) silently folded the stale value into the
// live one. Measured on 2026-08-26 before this existed: 554 duplicate groups / 1209 rows, 549 of
// them cross-run supersessions — including ttft-32k on qwen3.6-27b averaging a 62,328 ms row with a
// 5,116 ms one, and speed_prefill-12k on qwen3.8-27b averaging 71 tok/s with 940. Those were
// published numbers.
//
// `status <> 'partial'` sits INSIDE the projection on purpose: rows land 'partial' and are promoted
// by markBenchesComplete, so a crashed re-run would otherwise supersede a good row and then be
// filtered out by the caller, making the combo vanish entirely instead of falling back to the older
// measurement. History is preserved — nothing is deleted, `$TIDY` still sees every row.
const LATEST_VIEW = `(SELECT DISTINCT ON (${IDENTITY_KEY.map((c) => `"${c}"`).join(', ')}) *
   FROM measurements WHERE status IS DISTINCT FROM 'partial'
   ORDER BY ${IDENTITY_KEY.map((c) => `"${c}"`).join(', ')}, ts DESC NULLS LAST, run_id DESC) AS latest`;

/**
 * Run engine SQL against Postgres.
 *   `$LATEST` expands to the latest-wins projection — one row per config x metric x case, newest
 *             measurement only. Use this for ANY read that reports a number.
 *   `$TIDY`   expands to the raw `measurements` table, superseded rows included. Use it only when
 *             you genuinely want the history (bench-run's resume set, provenance queries).
 */
export async function query(text) {
   const sql = conn();
   const { password } = pgConfig();
   try {
      const rows = await sql.unsafe(text.replaceAll('$LATEST', LATEST_VIEW).replaceAll('$TIDY', 'measurements'));
      const numCols = (rows.columns || []).filter((c) => NUMERIC_OIDS.has(c.type)).map((c) => c.name);
      return rows.map((r) => {
         const o = { ...r };
         for (const c of numCols) {
            if (o[c] != null) {
               o[c] = Number(o[c]);
            }
         }
         return o;
      });
   } catch (e) {
      throw new Error(scrub(e.message || e, password));
   }
}
