// Tidy store — DuckDB/Parquet I/O for the measurement dataset.
//
// Layout: results/tidy/host=<h>/backend=<b>/run_id=<id>/measurements.parquet
// (immutable per run; Hive-partitioned so DuckDB prunes by host/backend). Read via a
// glob. Writing goes NDJSON -> read_json(columns=…) -> COPY parquet so column TYPES and
// nulls are explicit (avoids DuckDB inferring DECIMAL from literals) and the value
// column is a real DOUBLE.
import { existsSync, mkdirSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DuckDBInstance } from '@duckdb/node-api';
import { COLUMNS } from './tidy-schema.mjs';

const slug = (s) =>
   String(s ?? '')
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, '');

let _conn = null;
async function conn() {
   if (!_conn) _conn = await (await DuckDBInstance.create(':memory:')).connect();
   return _conn;
}

export function tidyDir(resultsDir) {
   return join(resultsDir, 'tidy');
}
export function tidyGlob(resultsDir) {
   return `read_parquet('${tidyDir(resultsDir)}/**/*.parquet', hive_partitioning=true, union_by_name=true)`;
}
function hasData(resultsDir) {
   const d = tidyDir(resultsDir);
   if (!existsSync(d)) return false;
   // any parquet anywhere under tidy/
   const stack = [d];
   while (stack.length) {
      const cur = stack.pop();
      for (const e of readdirSync(cur, { withFileTypes: true })) {
         if (e.isDirectory()) stack.push(join(cur, e.name));
         else if (e.name.endsWith('.parquet')) return true;
      }
   }
   return false;
}

// DuckDB returns BigInt for integer columns; coerce to Number at the JS boundary.
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

/**
 * Write one run's tidy rows to its immutable Parquet file (idempotent — overwrites
 * that run's file only). Returns { path, rows }.
 */
export async function writeRunParquet(resultsDir, { host, backend, run_id, rows, part = null }) {
   const dir = join(tidyDir(resultsDir), `host=${slug(host)}`, `backend=${slug(backend)}`, `run_id=${run_id}`);
   mkdirSync(dir, { recursive: true });
   // `part` → an incremental file (part-0001.parquet) so a long run persists after each
   // result; the dataset glob unions all parts. No part → the single measurements.parquet.
   const out = join(dir, part != null ? `part-${String(part).padStart(4, '0')}.parquet` : 'measurements.parquet');
   if (!rows.length) return { path: out, rows: 0 };
   const tmp = join(tmpdir(), `tidy-${run_id}-${Date.now()}.ndjson`);
   writeFileSync(tmp, rows.map((r) => JSON.stringify(r)).join('\n'));
   const colsSpec = Object.entries(COLUMNS)
      .map(([k, t]) => `'${k}': '${t}'`)
      .join(', ');
   const c = await conn();
   try {
      await c.run(
         `COPY (SELECT * FROM read_json('${tmp}', format='newline_delimited', columns={${colsSpec}}))` + ` TO '${out}' (FORMAT parquet)`,
      );
   } finally {
      rmSync(tmp, { force: true });
   }
   return { path: out, rows: rows.length };
}

/** Run SQL over the dataset. `$TIDY` in the SQL expands to the read_parquet glob. */
export async function query(resultsDir, sql) {
   if (sql.includes('$TIDY') && !hasData(resultsDir)) return [];
   const c = await conn();
   const reader = await c.runAndReadAll(sql.replaceAll('$TIDY', tidyGlob(resultsDir)));
   return reader.getRowObjects().map(deBig);
}

/** Distinct values of a dimension column (for the dashboard facet rail). */
export async function distinctDim(resultsDir, col) {
   if (!/^[a-z_]+$/.test(col)) throw new Error(`bad column ${col}`);
   const rows = await query(resultsDir, `SELECT DISTINCT "${col}" AS v FROM $TIDY WHERE "${col}" IS NOT NULL ORDER BY 1`);
   return rows.map((r) => r.v);
}
