/**
 * Convert one or more runs to a consolidated markdown report.
 * Usage: node runners/results-to-md.mjs [--input <run-id>] [--output results/report.md]
 */

import { writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseArgs } from 'node:util';
import { loadRuns, mergeResultRows } from '../shared/results-store.mjs';

const __dir = dirname(fileURLToPath(import.meta.url));
const ROOT = join(__dir, '..');
const RESULTS_DIR = join(ROOT, 'results');

const { values: flags } = parseArgs({
   options: {
      input: { type: 'string', multiple: true },
      output: { type: 'string', default: join(RESULTS_DIR, 'report.md') },
   },
});

// Accepts one or more --input (run id | run dir | run.json); rows merged by ts/status.
const runs = loadRuns(RESULTS_DIR, flags.input);
if (!runs.length) {
   console.error('No runs found. Run the suite first, or pass --input <run-id>.');
   process.exit(1);
}
const rows = mergeResultRows(runs.flatMap((r) => r.results));

// Group by bench type
const byBench = {};
for (const r of rows) {
   if (!byBench[r.bench]) {
      byBench[r.bench] = [];
   }
   byBench[r.bench].push(r);
}

const lines_out = [
   '# LLM Benchmark Report',
   '',
   `Generated from ${runs.map((r) => `\`${r.run_id}\``).join(', ')} — ${rows.length} result rows across ${Object.keys(byBench).length} bench types.`,
   '',
];

const benchOrder = ['triage', 'reasoning', 'toolcalling', 'toolcalling_decay', 'summarization', 'speed', 'maxctx', 'longctx'];

for (const bench of benchOrder) {
   const bRows = byBench[bench];
   if (!bRows?.length) {
      continue;
   }

   lines_out.push(`## ${bench}`);
   lines_out.push('');

   // Group by backend (vulkan / rocm)
   const backends = [...new Set(bRows.map((r) => r.backend))].sort();

   for (const backend of backends) {
      const kvRows = bRows.filter((r) => r.backend === backend).sort((a, b) => parseFloat(b.score) - parseFloat(a.score));
      if (!kvRows.length) {
         continue;
      }

      lines_out.push(`### backend=${backend}`);
      lines_out.push('');

      // Determine columns based on bench type
      if (bench === 'triage') {
         lines_out.push('| Model | Think | Score | Halls | JSON fail | tok/s | VRAM | Status |');
         lines_out.push('|---|---|---|---|---|---|---|---|');
         for (const r of kvRows) {
            lines_out.push(
               `| ${r.model} | ${r.think} | ${r.score} | ${r.halls} | ${r.json_fail} | ${r.tok_s} | ${r.vram_mib} MiB | ${r.status} |`,
            );
         }
      } else if (bench === 'reasoning') {
         lines_out.push('| Model | Think | Accuracy | tok/s | Status |');
         lines_out.push('|---|---|---|---|---|');
         for (const r of kvRows) {
            lines_out.push(`| ${r.model} | ${r.think} | ${r.score} | ${r.tok_s} | ${r.status} |`);
         }
      } else if (bench === 'toolcalling') {
         lines_out.push('| Model | Accuracy | Status |');
         lines_out.push('|---|---|---|');
         for (const r of kvRows) {
            lines_out.push(`| ${r.model} | ${r.score} | ${r.status} |`);
         }
      } else if (bench === 'speed') {
         lines_out.push('| Model | tok/s | VRAM MiB | Status |');
         lines_out.push('|---|---|---|---|');
         for (const r of kvRows) {
            lines_out.push(`| ${r.model} | ${r.tok_s} | ${r.vram_mib} | ${r.status} |`);
         }
      } else if (bench === 'maxctx') {
         lines_out.push('| Model | Max ctx (tokens) | ≈ chars | VRAM MiB |');
         lines_out.push('|---|---|---|---|');
         for (const r of kvRows) {
            const chars = Number.isNaN(parseInt(r.score, 10)) ? '?' : (parseInt(r.score, 10) * 4).toLocaleString();
            lines_out.push(`| ${r.model} | ${r.score} | ${chars} | ${r.vram_mib} |`);
         }
      } else if (bench === 'longctx') {
         lines_out.push('| Model | Backend | Passkey | Multi-fact | VRAM MiB |');
         lines_out.push('|---|---|---|---|---|');
         for (const r of kvRows) {
            lines_out.push(`| ${r.model} | ${r.backend} | ${r.score} | ${r.notes.replace('multifact=', '')} | ${r.vram_mib} |`);
         }
      } else {
         lines_out.push('| Model | Think | Score | Status |');
         lines_out.push('|---|---|---|---|');
         for (const r of kvRows) {
            lines_out.push(`| ${r.model} | ${r.think} | ${r.score} | ${r.status} |`);
         }
      }
      lines_out.push('');
   }
}

writeFileSync(flags.output, lines_out.join('\n'));
console.log(`Report written to ${flags.output}`);
