// Central-Postgres store — the PRIMARY store for measurement rows: the `llmbench.measurements`
// table on the house server (central-db, 192.168.1.120:5432). bench-run writes here directly
// (insertRows), and the dashboard/analysis read here (query). There is no Parquet dataset and
// no sync step — Postgres is the single source of truth.
//
// Access is a thin native-Postgres client (porsager `postgres`). The table schema is GENERATED
// from shared/tidy-schema.mjs (COLUMNS) so it can't drift. NOTE: measurement_id is a SOFT dedup hint,
// not unique — a few ids legitimately map to >1 row (a bench sampled twice, the same config
// re-measured across runs); the engine reads every row and scoring averages duplicates.
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
const ADDED_COLUMNS = ['scope'];

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

/** Run engine SQL against Postgres. `$TIDY` expands to the `measurements` table. */
export async function query(text) {
   const sql = conn();
   const { password } = pgConfig();
   try {
      const rows = await sql.unsafe(text.replaceAll('$TIDY', 'measurements'));
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
