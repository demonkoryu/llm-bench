#!/usr/bin/env node
/**
 * One-shot: convert an existing results table (legacy results.tsv) into a
 * canonically-named CSV — llm-benchmarks-<host>-<gpu>-<backend>-<datetime>.csv —
 * WITHOUT re-running any benchmarks. Preserves the input's columns verbatim.
 *
 * Usage:
 *   node runners/migrate-tsv-to-csv.mjs
 *   node runners/migrate-tsv-to-csv.mjs --in results/results.tsv --out <name.csv>
 *   node runners/migrate-tsv-to-csv.mjs --target rose --backend vulkan
 */

import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, isAbsolute, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseArgs } from 'node:util';
import yaml from 'js-yaml';
import { csvFilename, formatRow, headerLine, readTable } from '../shared/results-csv.mjs';

const __dir = dirname(fileURLToPath(import.meta.url));
const ROOT = join(__dir, '..');
const RESULTS_DIR = join(ROOT, 'results');

const { values: flags } = parseArgs({
   options: {
      in: { type: 'string', default: join(RESULTS_DIR, 'results.tsv') },
      out: { type: 'string' },
      target: { type: 'string' },
      gpu: { type: 'string' },
      backend: { type: 'string' },
   },
});

if (!existsSync(flags.in)) {
   console.error(`Input not found: ${flags.in}`);
   process.exit(1);
}

const rows = readTable(flags.in);
if (!rows.length) {
   console.error(`No rows in ${flags.in}`);
   process.exit(1);
}

const columns = Object.keys(rows[0]);
const host = flags.target ?? rows[0].target ?? 'rose';
const backend = flags.backend ?? rows[0].backend ?? 'vulkan';

// GPU only lives in hosts.yaml (not the row data).
let gpu = flags.gpu ?? '';
if (!gpu) {
   try {
      const hosts = yaml.load(readFileSync(join(ROOT, 'config/hosts.yaml'), 'utf8'));
      gpu = hosts?.[host]?.gpu ?? '';
   } catch {
      /* fall through to empty */
   }
}

const outName = flags.out ?? csvFilename({ host, gpu, backend, date: new Date() });
const outPath = isAbsolute(outName) ? outName : join(RESULTS_DIR, outName);

const csv = [headerLine(columns), ...rows.map((r) => formatRow(r, columns))].join('\n');
writeFileSync(outPath, `${csv}\n`, 'utf-8');

console.log(`Migrated ${rows.length} rows: ${flags.in} → ${outPath}`);
