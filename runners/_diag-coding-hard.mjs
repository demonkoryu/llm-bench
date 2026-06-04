/**
 * Post-run diagnostic: dump the raw model outputs for the coding_hard bench so
 * we can see WHY a model scored 0/12 (no fence? wrong class name? trailing prose
 * that throws at definition?). Reads the newest results/run-*.json.
 *   node runners/_diag-coding-hard.mjs            # all coding_hard outputs
 *   node runners/_diag-coding-hard.mjs zero       # only the 0/12 ones
 */
import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

const onlyZero = process.argv[2] === 'zero';
const dir = 'results';
const newest = readdirSync(dir)
   .filter((f) => /^run-.*\.json$/.test(f))
   .sort()
   .pop();
console.log(`reading ${newest}\n`);
const j = JSON.parse(readFileSync(join(dir, newest), 'utf8'));
const all = Array.isArray(j.results) ? j.results : (j.results?.results ?? []);
const rows = all.filter((r) => r.prompt?.label === 'coding_hard');

for (const r of rows) {
   const gr = r.gradingResult ?? {};
   if (onlyZero && (gr.passed ?? 0) > 0) {
      continue;
   }
   const out = r.response?.output ?? '';
   console.log('━'.repeat(78));
   console.log(`${r.provider?.label}   →  ${gr.passed ?? '?'}/${gr.total ?? '?'}  (${gr.reason ?? ''})`);
   console.log(`output length: ${out.length} chars`);
   console.log('first 600 chars:');
   console.log(out.slice(0, 600));
   console.log('…last 200 chars:');
   console.log(out.slice(-200));
   console.log();
}
console.log(`\n${rows.length} coding_hard rows.`);
