// One-shot backfill for the `model` dimension (and the two derivation bugs it exposed).
// Resolves each distinct gguf_file through models.yaml so stored rows get exactly the dims a
// fresh run would now write; rows whose artifact is no longer in the config fall back to
// deriving from the family/params already on the row.

import { readFileSync } from 'node:fs';
import yaml from 'js-yaml';
import { deriveArch, deriveModelId, deriveSubjectDims } from '../shared/models-config.mjs';
import { ensureSchema, query } from './pg-store.mjs';

const cfg = yaml.load(readFileSync(new URL('../config/models.yaml', import.meta.url), 'utf8'));
const byFile = new Map();
for (const e of cfg.models ?? []) {
   const d = deriveSubjectDims(e);
   if (d.gguf_file && !byFile.has(d.gguf_file)) {
      byFile.set(d.gguf_file, d);
   }
}

await ensureSchema();
const before = await query(`select gguf_file, family, arch, total_params, active_params, count(*) n
   from measurements group by 1,2,3,4,5 order by 1`);
const plan = [];
for (const r of before) {
   // The two v100-skinny runs predate artifact recording and carry no gguf_file, so they cannot
   // resolve through models.yaml — but family+params identify the model perfectly well, which is
   // the whole point of deriving the id from dims rather than from a filename.
   const d = r.gguf_file == null ? null : byFile.get(r.gguf_file);
   const model = d?.model ?? deriveModelId(r.family, r.total_params, r.active_params);
   const arch = d?.arch ?? deriveArch(r.family, r.total_params, r.active_params) ?? r.arch;
   const active = d?.active_params ?? r.active_params;
   if (model !== null || arch !== r.arch || active !== r.active_params) {
      plan.push({ file: r.gguf_file, n: Number(r.n), model, arch, active, wasArch: r.arch, wasActive: r.active_params });
   }
}
for (const p of plan) {
   const changed = [
      p.arch !== p.wasArch ? `arch ${p.wasArch}→${p.arch}` : null,
      p.active !== p.wasActive ? `active ${p.wasActive}→${p.active}` : null,
   ].filter(Boolean);
   console.log(
      `${String(p.n).padStart(5)}  ${String(p.file ?? '(no artifact)').padEnd(44)} model=${p.model}${changed.length ? '  [' + changed.join(', ') + ']' : ''}`,
   );
}
if (process.argv.includes('--apply')) {
   let total = 0;
   for (const p of plan) {
      const res =
         await query(`update measurements set model=${lit(p.model)}, arch=${lit(p.arch)}, active_params=${p.active == null ? 'null' : Number(p.active)}
         where gguf_file is not distinct from ${lit(p.file)}`);
      total += p.n;
   }
   console.log(`\napplied to ${total} rows`);
   const chk = await query(`select model, count(*) n from measurements group by 1 order by 1`);
   for (const r of chk) {
      console.log(String(r.n).padStart(6), r.model);
   }
}
function lit(v) {
   return v == null ? 'null' : `'${String(v).replace(/'/g, "''")}'`;
}
process.exit(0);
