// Capabilities cache — memoizes the EXPENSIVE, config-invariant facts (context
// ceilings, KV footprint, VRAM) so the orchestrator doesn't re-probe them every run.
//
// Keyed by the tuple those facts actually depend on:
//   (gguf_file, quant, kv_quant, backend, gpu, llamacpp_build)
// llamacpp_build is in the key on purpose: a silent llama.cpp upgrade (e.g. 9780→9945)
// changes RoPE/ctx behavior, so it misses the cache and forces a clean re-probe.
//
// Small keyed store → a single JSON file (results/caps/capabilities.json), which is
// git-diffable and trivial to upsert; the big measurement store stays Parquet.
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { loadModelsConfig } from '../shared/models-config.mjs';
import { query } from '../shared/tidy-store.mjs';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const capsPath = (resultsDir) => join(resultsDir, 'caps', 'capabilities.json');

export function capKey({ gguf_file, quant, kv_quant, backend, gpu, llamacpp_build }) {
   return [gguf_file, quant, kv_quant, backend, gpu, llamacpp_build].map((x) => x ?? '∅').join('|');
}
function load(resultsDir) {
   const p = capsPath(resultsDir);
   if (!existsSync(p)) return {};
   try {
      return JSON.parse(readFileSync(p, 'utf8'));
   } catch {
      return {};
   }
}
function save(resultsDir, obj) {
   const p = capsPath(resultsDir);
   mkdirSync(dirname(p), { recursive: true });
   writeFileSync(p, JSON.stringify(obj, null, 2));
}

/** Lookup by key fields → entry | null. Only returns a hit when the FULL key matches. */
export function readCap(resultsDir, keyFields) {
   return load(resultsDir)[capKey(keyFields)] ?? null;
}

/** Insert/merge a measured capability entry. */
export function upsertCap(resultsDir, keyFields, values) {
   const all = load(resultsDir);
   const k = capKey(keyFields);
   all[k] = { ...keyFields, ...(all[k] ?? {}), ...values, measured_at: values.measured_at ?? new Date().toISOString() };
   save(resultsDir, all);
   return all[k];
}

/**
 * Seed the cache from the backfilled tidy store: derive ceilings from `maxctx` rows and
 * KV footprint from `kv_per_tok` rows, per config key. Historical rows carry
 * llamacpp_build=null, so these entries won't satisfy a fresh run on build 9945 — they
 * document what WAS measured and force one honest re-probe under the new build.
 */
export async function seedFromTidy(resultsDir = join(ROOT, 'results')) {
   const nativeByGguf = new Map();
   for (const m of loadModelsConfig(join(ROOT, 'config/models.yaml'), { includeDisabled: true }).models) {
      if (m.hf_file && m.native_max_ctx) nativeByGguf.set(m.hf_file, m.native_max_ctx);
   }
   const ceil = await query(
      resultsDir,
      `
    SELECT gguf_file, quant, kv_quant, backend, gpu, llamacpp_build,
           max(CASE WHEN metric='coherence_ceiling' THEN metric_value END) AS coherence_ceiling,
           max(CASE WHEN metric='oom_ceiling'       THEN metric_value END) AS oom_ceiling,
           max(CASE WHEN metric='score'             THEN metric_value END) AS ctx_ceiling,
           max(CASE WHEN metric='vram_mib'          THEN metric_value END) AS vram_at_ctx,
           max(ts) AS measured_at, arg_max(run_id, ts) AS source_run_id
    FROM $TIDY WHERE bench='maxctx' GROUP BY 1,2,3,4,5,6`,
   );
   const kv = await query(
      resultsDir,
      `
    SELECT gguf_file, quant, kv_quant, backend, gpu, llamacpp_build,
           avg(CASE WHEN metric='score' THEN metric_value END) AS kv_kib_per_tok
    FROM $TIDY WHERE bench='kv_per_tok' GROUP BY 1,2,3,4,5,6`,
   );
   const kvByKey = new Map(kv.map((r) => [capKey(r), r.kv_kib_per_tok]));

   let n = 0;
   for (const r of ceil) {
      const key = {
         gguf_file: r.gguf_file,
         quant: r.quant,
         kv_quant: r.kv_quant,
         backend: r.backend,
         gpu: r.gpu,
         llamacpp_build: r.llamacpp_build,
      };
      upsertCap(resultsDir, key, {
         native_max_ctx: nativeByGguf.get(r.gguf_file) ?? null,
         ctx_ceiling: r.ctx_ceiling ?? null,
         coherence_ceiling: r.coherence_ceiling ?? null,
         oom_ceiling: r.oom_ceiling ?? null,
         kv_bytes_per_token: kvByKey.get(capKey(r)) != null ? kvByKey.get(capKey(r)) * 1024 : null,
         vram_at_ctx: r.vram_at_ctx ?? null,
         measured_at: r.measured_at ?? null,
         source_run_id: r.source_run_id ?? null,
      });
      n++;
   }
   return { seeded: n };
}

// CLI: `node analysis/caps-cache.mjs seed`
if (process.argv[2] === 'seed') {
   const r = await seedFromTidy();
   console.error(`[caps-cache] seeded ${r.seeded} entries → ${capsPath(join(ROOT, 'results'))}`);
}
