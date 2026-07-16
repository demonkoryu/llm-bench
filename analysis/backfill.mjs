#!/usr/bin/env node
// Backfill: historical results/runs/**/run.json  ->  tidy Parquet dataset.
//
// Resolves every configuration dimension that today is smeared across the model-id
// string + the per-run environment blob into explicit columns, so the froggeric arms
// (which shared an identical model id) separate cleanly. Idempotent per run_id.
//
// Usage: node analysis/backfill.mjs [--results results] [--only <run-id-substr>]
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { basename, dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseArgs } from 'node:util';
import { deriveSubjectDims, loadModelsConfig } from '../shared/models-config.mjs';
import { metricRowsFromResult } from '../shared/tidy-schema.mjs';
import { writeRunParquet } from '../shared/tidy-store.mjs';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const { values: flags } = parseArgs({
   options: {
      results: { type: 'string', default: join(ROOT, 'results') },
      only: { type: 'string' },
   },
});
const RESULTS = flags.results;

// ── model-id string parsing (base / kv_quant / think_mode) ──────────────────────
export function parseModelId(model = '') {
   let s = String(model);
   let think_mode = 'n/a';
   const tm = /--(nothi|think)$/.exec(s);
   if (tm) {
      think_mode = tm[1] === 'nothi' ? 'no_think' : 'think';
      s = s.slice(0, tm.index);
   }
   let kv_quant = null;
   const kv = /--kv([a-z0-9_]+)$/i.exec(s);
   if (kv) {
      kv_quant = kv[1];
      s = s.slice(0, kv.index);
   }
   return { base: s, kv_quant, think_mode };
}
const normThink = (t) => (t === 'no_think' || t === 'nothi' ? 'no_think' : t === 'think' ? 'think' : t === '-' || t == null ? 'n/a' : t);

// ── config lookup: base gguf name -> derived subject dims + config entry ─────────
function buildConfigIndex() {
   const cfg = loadModelsConfig(join(ROOT, 'config/models.yaml'), { includeDisabled: true });
   const byBase = new Map();
   for (const m of cfg.models) {
      const base = String(m.hf_file ?? '').replace(/\.gguf$/i, '');
      if (!byBase.has(base)) byBase.set(base, m);
   }
   return { cfg, byBase, hosts: loadHosts() };
}
function loadHosts() {
   try {
      const raw = readFileSync(join(ROOT, 'config/hosts.yaml'), 'utf8');
      // tiny grep: gpu -> vram_total_mib pairs are enough; fall back to null
      return raw;
   } catch {
      return '';
   }
}

// froggeric chat_template map: run_id -> 'builtin'|'froggeric'
function froggericArms() {
   const p = join(RESULTS, 'ab-froggeric-manifest.tsv');
   const map = new Map();
   if (!existsSync(p)) return map;
   for (const line of readFileSync(p, 'utf8').trim().split('\n')) {
      const [, arm, , run_id] = line.split('\t');
      if (run_id) map.set(run_id, arm === 'treatment' ? 'froggeric' : 'builtin');
   }
   return map;
}

function servingDims(env, cfgModel) {
   const sf = env?.server_flags ?? {};
   const df = env?.defaults_extra_flags ?? {};
   const ef = cfgModel?.extra_flags ?? {};
   return {
      flash_attn: sf.flash_attn == null ? null : /on|1|true/i.test(String(sf.flash_attn)),
      n_parallel: sf.np ?? (typeof ef === 'object' ? ef.parallel : null) ?? null,
      batch: df['batch-size'] ?? (typeof ef === 'object' ? ef['batch-size'] : null) ?? null,
      ubatch: df['ubatch-size'] ?? (typeof ef === 'object' ? ef['ubatch-size'] : null) ?? null,
      spec_decode: typeof ef === 'object' && ef['spec-type'] ? ef['spec-type'] : null,
   };
}

function listRunJsons() {
   const dir = join(RESULTS, 'runs');
   if (!existsSync(dir)) return [];
   return readdirSync(dir, { withFileTypes: true })
      .filter((e) => e.isDirectory() && e.name !== '_archive')
      .map((e) => join(dir, e.name, 'run.json'))
      .filter(existsSync);
}

async function main() {
   const { byBase } = buildConfigIndex();
   const arms = froggericArms();
   const files = listRunJsons().filter((f) => !flags.only || f.includes(flags.only));
   let totalRows = 0,
      totalRuns = 0,
      orphans = new Set();

   for (const f of files) {
      let run;
      try {
         run = JSON.parse(readFileSync(f, 'utf8'));
      } catch {
         continue;
      }
      const run_id = run.run_id ?? basename(dirname(f));
      const chat_template = arms.get(run_id) ?? 'builtin';
      const platform = {
         host: run.host ?? null,
         gpu: run.gpu ?? null,
         backend: run.backend ?? null,
         vram_total: run.environment?.vram_total ?? null,
         llamacpp_build: run.environment?.llamacpp_build ?? null,
         driver: null,
      };
      const tidyRows = [];
      for (const row of run.results ?? []) {
         const { base, kv_quant, think_mode } = parseModelId(row.model ?? '');
         const cfgModel = byBase.get(base) ?? null;
         if (!cfgModel) orphans.add(base);
         const subject = deriveSubjectDims(cfgModel ?? { hf_file: `${base}.gguf`, label: base });
         const dims = {
            run_id,
            run_kind: run.kind ?? 'suite',
            ts: row.ts ?? run.started ?? null,
            seed_run_id: run.seed ?? null,
            ...subject,
            chat_template,
            kv_quant,
            ctx: row.ctx_loaded ?? null,
            sampling_profile: subject.family ? `${subject.family}/${normThink(row.think ?? think_mode)}` : null,
            think_mode: normThink(row.think ?? think_mode),
            ...servingDims(run.environment, cfgModel),
            ...platform,
         };
         for (const r of metricRowsFromResult(row, dims)) tidyRows.push(r);
      }
      const res = await writeRunParquet(RESULTS, {
         host: platform.host ?? 'unknown',
         backend: platform.backend ?? 'unknown',
         run_id,
         rows: tidyRows,
      });
      totalRows += res.rows;
      totalRuns += 1;
      if (process.env.DEBUG) console.error(`  ${run_id}: ${res.rows} rows (template=${chat_template})`);
   }
   console.error(`\n[backfill] ${totalRuns} runs -> ${totalRows} tidy rows`);
   if (orphans.size)
      console.error(
         `[backfill] ${orphans.size} model bases not in config (kept, subject dims parsed from name): ${[...orphans].slice(0, 6).join(', ')}${orphans.size > 6 ? '…' : ''}`,
      );
}
main().catch((e) => {
   console.error(e);
   process.exit(1);
});
