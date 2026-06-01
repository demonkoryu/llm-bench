/**
 * Convert results/results.tsv to a consolidated markdown report.
 * Usage: node runners/results-to-md.mjs [--output results/report.md]
 */

import { readFileSync, writeFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseArgs } from 'node:util';

const __dir = dirname(fileURLToPath(import.meta.url));
const ROOT = join(__dir, '..');

const { values: flags } = parseArgs({
   options: { output: { type: 'string', default: join(ROOT, 'results/report.md') } },
});

const tsv = readFileSync(join(ROOT, 'results/results.tsv'), 'utf8');
const lines = tsv.trim().split('\n');
const headers = lines[0].split('\t');
const rows = lines.slice(1).filter(Boolean).map((l) => {
   const cols = l.split('\t');
   return Object.fromEntries(headers.map((h, i) => [h, cols[i] ?? '']));
});

// Group by bench type
const byBench = {};
for (const r of rows) {
   (byBench[r.bench] ??= []).push(r);
}

const lines_out = [
   '# LLM Benchmark Report',
   '',
   `Generated from \`results/results.tsv\` — ${rows.length} result rows across ${Object.keys(byBench).length} bench types.`,
   '',
];

const benchOrder = ['triage', 'reasoning', 'toolcalling', 'toolcalling_decay', 'summarization', 'speed', 'maxctx', 'longctx'];

for (const bench of benchOrder) {
   const bRows = byBench[bench];
   if (!bRows?.length) continue;

   lines_out.push(`## ${bench}`);
   lines_out.push('');

   // Group by KV type
   const kvGroups = [...new Set(bRows.map((r) => r.kv))].sort();

   for (const kv of kvGroups) {
      const kvRows = bRows.filter((r) => r.kv === kv).sort((a, b) =>
         parseFloat(b.score) - parseFloat(a.score)
      );
      if (!kvRows.length) continue;

      lines_out.push(`### KV=${kv}`);
      lines_out.push('');

      // Determine columns based on bench type
      if (bench === 'triage') {
         lines_out.push('| Model | Think | Score | Halls | JSON fail | tok/s | VRAM | Status |');
         lines_out.push('|---|---|---|---|---|---|---|---|');
         for (const r of kvRows) {
            lines_out.push(`| ${r.model} | ${r.think} | ${r.score} | ${r.halls} | ${r.json_fail} | ${r.tok_s} | ${r.vram_mib} MiB | ${r.status} |`);
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
            const chars = isNaN(parseInt(r.score)) ? '?' : (parseInt(r.score) * 4).toLocaleString();
            lines_out.push(`| ${r.model} | ${r.score} | ${chars} | ${r.vram_mib} |`);
         }
      } else if (bench === 'longctx') {
         lines_out.push('| Model | KV | Passkey | Multi-fact | VRAM MiB |');
         lines_out.push('|---|---|---|---|---|');
         for (const r of kvRows) {
            lines_out.push(`| ${r.model} | ${r.kv} | ${r.score} | ${r.notes.replace('multifact=', '')} | ${r.vram_mib} |`);
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
