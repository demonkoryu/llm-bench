// Central-Postgres store — mirrors the tidy Parquet dataset into the `llmbench`
// database on the house server (central-db, llm2:5432) and reads it back.
//
// Both directions go through DuckDB's `postgres` extension, so the SAME SQL engine
// the rest of the app uses reads Parquet AND talks to Postgres — no separate pg driver.
// The table schema is GENERATED from shared/tidy-schema.mjs (COLUMNS) so it can't drift
// from the Parquet schema. NOTE: measurement_id is a SOFT dedup hint, not unique — a few
// ids legitimately map to >1 row (e.g. a bench sampled twice in one run), and the engine
// reads every row, so the mirror is a faithful copy (no PK, no dedup).
//
// Connection comes from the environment (never committed):
//   LLMBENCH_PG_HOST      (default 192.168.1.120)
//   LLMBENCH_PG_PORT      (default 5432)
//   LLMBENCH_PG_DB        (default llmbench)
//   LLMBENCH_PG_USER      (default llmbench)
//   LLMBENCH_DB_PASSWORD  (required; also accepts LLMBENCH_PG_PASSWORD / PGPASSWORD)
import { DuckDBInstance } from '@duckdb/node-api';
import { COLUMN_NAMES, COLUMNS } from '../shared/tidy-schema.mjs';
import { tidyGlob } from '../shared/tidy-store.mjs';

// DuckDB type (tidy-schema) → PostgreSQL column type.
const PG_TYPE = { VARCHAR: 'TEXT', DOUBLE: 'DOUBLE PRECISION', TIMESTAMP: 'TIMESTAMP', BOOLEAN: 'BOOLEAN', BIGINT: 'BIGINT' };

function pgConfig() {
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
      if (!t) throw new Error(`no PG type mapping for ${c} (${COLUMNS[c]})`);
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
   if (_conn) return _conn;
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
   if (typeof v === 'bigint') return Number(v);
   if (Array.isArray(v)) return v.map(deBig);
   if (v && typeof v === 'object') {
      const o = {};
      for (const k in v) o[k] = deBig(v[k]);
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
 * Full idempotent refresh: replace the Postgres table with the current Parquet dataset,
 * in ONE transaction (readers see old-or-new, never empty). Parquet stays the source of
 * record during the migration; re-running always makes Postgres match it exactly.
 * @returns {{ rows: number }}
 */
export async function sync(resultsDir) {
   const c = await conn();
   await ensureSchema();
   const colList = COLUMN_NAMES.map((c) => `"${c}"`).join(', ');
   await c.run('BEGIN TRANSACTION');
   try {
      await c.run('DELETE FROM pg.measurements');
      await c.run(`INSERT INTO pg.measurements (${colList}) SELECT ${colList} FROM ${tidyGlob(resultsDir)}`);
      await c.run('COMMIT');
   } catch (e) {
      await c.run('ROLLBACK').catch(() => {});
      throw e;
   }
   const r = await c.runAndReadAll('SELECT count(*)::BIGINT AS n FROM pg.measurements');
   return { rows: Number(r.getRowObjects()[0].n) };
}

/** Run engine SQL against Postgres. `$TIDY` expands to the attached `pg.measurements` table. */
export async function query(sql) {
   const c = await conn();
   const reader = await c.runAndReadAll(sql.replaceAll('$TIDY', 'pg.measurements'));
   return reader.getRowObjects().map(deBig);
}
