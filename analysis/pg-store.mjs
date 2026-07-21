// Central-Postgres store — the PRIMARY store for measurement rows: the `llmbench.measurements`
// table on the house server (central-db, 192.168.1.120:5432). bench-run writes here directly
// (insertRows), and the dashboard/analysis read here (query). There is no Parquet dataset and
// no sync step — Postgres is the single source of truth.
//
// All access goes through DuckDB's `postgres` extension, so the SAME SQL engine the rest of the
// app uses talks to Postgres — no separate pg driver. The table schema is GENERATED from
// shared/tidy-schema.mjs (COLUMNS) so it can't drift. NOTE: measurement_id is a SOFT dedup hint,
// not unique — a few ids legitimately map to >1 row (a bench sampled twice, the same config
// re-measured across runs); the engine reads every row and scoring averages duplicates.
//
// Connection comes from the environment (never committed):
//   LLMBENCH_PG_HOST      (default 192.168.1.120)
//   LLMBENCH_PG_PORT      (default 5432)
//   LLMBENCH_PG_DB        (default llmbench)
//   LLMBENCH_PG_USER      (default llmbench)
//   LLMBENCH_DB_PASSWORD  (required; also accepts LLMBENCH_PG_PASSWORD / PGPASSWORD)
import { existsSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { DuckDBInstance } from '@duckdb/node-api';
import { COLUMN_NAMES, COLUMNS } from '../shared/tidy-schema.mjs';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');

// DuckDB type (tidy-schema) → PostgreSQL column type.
const PG_TYPE = { VARCHAR: 'TEXT', DOUBLE: 'DOUBLE PRECISION', TIMESTAMP: 'TIMESTAMP', BOOLEAN: 'BOOLEAN', BIGINT: 'BIGINT' };

// Load the repo-root `.env` into process.env ONCE, but only for keys not already set — so an
// explicit env var (e.g. the CI Actions secret) always wins and CI needs no `.env` file. This
// lets every entrypoint (bench-run, caps-seed, the dashboard loader) pick up the DB credential
// with zero per-script plumbing. Minimal KEY=VALUE parser (skips blanks/`#`; strips one layer
// of surrounding quotes). Never logs values.
let _envLoaded = false;
function loadDotEnv() {
   if (_envLoaded) { return; }
   _envLoaded = true;
   const path = join(ROOT, '.env');
   if (!existsSync(path)) { return; }
   for (const line of readFileSync(path, 'utf8').split('\n')) {
      const t = line.trim();
      if (!t || t.startsWith('#')) { continue; }
      const eq = t.indexOf('=');
      if (eq < 0) { continue; }
      const key = t.slice(0, eq).trim();
      if (key in process.env) { continue; }
      let val = t.slice(eq + 1).trim();
      if (val.length >= 2 && ((val[0] === '"' && val.at(-1) === '"') || (val[0] === "'" && val.at(-1) === "'"))) { val = val.slice(1, -1); }
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

const sqlStr = (v) => `'${String(v).replaceAll("'", "''")}'`;

// One CREATE TABLE, generated from the tidy COLUMNS (order + types). No PK — the mirror is
// a faithful copy and measurement_id is not unique across the dataset (see header note).
function ddl() {
   const cols = COLUMN_NAMES.map((c) => {
      const t = PG_TYPE[COLUMNS[c]];
      if (!t) { throw new Error(`no PG type mapping for ${c} (${COLUMNS[c]})`); }
      return `"${c}" ${t}`;
   });
   return `CREATE TABLE IF NOT EXISTS measurements (${cols.join(', ')})`;
}

// Redact the password out of any error/log surface.
function scrub(msg, pw) {
   return pw ? String(msg).replaceAll(pw, '***') : String(msg);
}

let _conn = null;
async function conn() {
   if (_conn) { return _conn; }
   const cfg = pgConfig();
   const c = await (await DuckDBInstance.create(':memory:')).connect();
   try {
      await c.run('INSTALL postgres; LOAD postgres;');
      // A DuckDB SECRET keeps the credential out of the ATTACH statement text.
      await c.run(
         `CREATE OR REPLACE SECRET pgsecret (TYPE postgres, HOST ${sqlStr(cfg.host)}, PORT ${cfg.port}, ` +
            `DATABASE ${sqlStr(cfg.database)}, USER ${sqlStr(cfg.user)}, PASSWORD ${sqlStr(cfg.password)})`,
      );
      await c.run("ATTACH '' AS pg (TYPE postgres, SECRET pgsecret)");
   } catch (e) {
      throw new Error(scrub(e.message || e, cfg.password));
   }
   _conn = c;
   return c;
}

// DuckDB hands back BigInt for integer columns; coerce to Number at the JS boundary.
function deBig(v) {
   if (typeof v === 'bigint') { return Number(v); }
   if (Array.isArray(v)) { return v.map(deBig); }
   if (v && typeof v === 'object') {
      const o = {};
      for (const k in v) { o[k] = deBig(v[k]); }
      return o;
   }
   return v;
}

/** Create the measurements table in Postgres if absent (idempotent). */
export async function ensureSchema() {
   const c = await conn();
   // Run the DDL natively on the Postgres side (via the postgres extension).
   await c.run(`CALL postgres_execute('pg', ${sqlStr(ddl())})`);
}

/**
 * Append tidy measurement rows to pg.measurements — the PG-native write path used by bench-run.
 * Rows go through a temp NDJSON → read_json(columns=…) so column TYPES and nulls are explicit
 * (DuckDB won't infer DECIMAL from literals; metric_value stays DOUBLE), matching the schema
 * exactly. Append-only by design: the dataset has always unioned every run and scoring averages
 * duplicates; re-run idempotency comes from bench-run's --resume, not from dedup here.
 * @returns {{ rows: number }}
 */
export async function insertRows(rows) {
   if (!rows.length) { return { rows: 0 }; }
   await ensureSchema();
   const c = await conn();
   const colList = COLUMN_NAMES.map((k) => `"${k}"`).join(', ');
   const colsSpec = Object.entries(COLUMNS)
      .map(([k, t]) => `'${k}': '${t}'`)
      .join(', ');
   const tmp = join(tmpdir(), `pgins-${process.pid}-${Date.now()}-${Math.random().toString(36).slice(2)}.ndjson`);
   writeFileSync(tmp, rows.map((r) => JSON.stringify(r)).join('\n'));
   try {
      await c.run(
         `INSERT INTO pg.measurements (${colList}) ` +
            `SELECT ${colList} FROM read_json('${tmp}', format='newline_delimited', columns={${colsSpec}})`,
      );
   } finally {
      rmSync(tmp, { force: true });
   }
   return { rows: rows.length };
}

/** Run engine SQL against Postgres. `$TIDY` expands to the attached `pg.measurements` table. */
export async function query(sql) {
   const c = await conn();
   const reader = await c.runAndReadAll(sql.replaceAll('$TIDY', 'pg.measurements'));
   return reader.getRowObjects().map(deBig);
}
