// Capabilities cache — memoizes the EXPENSIVE, config-invariant facts (context
// ceilings, KV footprint, VRAM) so the orchestrator doesn't re-probe them every run.
//
// Keyed by the tuple those facts actually depend on:
//   (gguf_file, quant, kv_quant, backend, gpu)
//
// llamacpp_build was in this key until 2026-08-26, on the reasoning that a silent llama.cpp
// upgrade changes RoPE/ctx behavior and should force a clean re-probe. In practice that made
// EVERY ceiling expire on every build bump, silently: `maxctx` falls back
// `coherence_ceiling → ctx_cap → --ctx`, so a model with no ctx_cap quietly dropped to the 16384
// default and its depth probes then measured one depth instead of a curve, with nothing flagging it.
// Measured on 2026-08-26: zero configs on the then-current V100 build had a usable ceiling, while
// twelve hard-won Vulkan ceilings sat in the cache unreachable. A cache that always misses is not a
// conservative cache, it is an absent one. The build is still RECORDED on each entry as provenance
// (`llamacpp_build`), so a stale ceiling is auditable — it just no longer partitions the key.
//
// Small keyed store → a single JSON file (results/caps/capabilities.json), which is
// git-diffable and trivial to upsert; the big measurement store is Postgres (pg-store.mjs).
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { loadModelsConfig } from '../shared/models-config.mjs';
import { query } from './pg-store.mjs';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const capsPath = (resultsDir) => join(resultsDir, 'caps', 'capabilities.json');

// Postgres timestamps arrive from the driver as `{ micros }`, not a string. Writing that straight
// into the JSON cache produced 5 entries whose `measured_at` was an object — unusable for ordering,
// and truthy, so it silently defeated the `?? new Date().toISOString()` fallback in upsertCap.
function isoTs(v) {
   if (v == null) {
      return null;
   }
   if (typeof v === 'string') {
      return v;
   }
   if (typeof v === 'object' && typeof v.micros === 'number') {
      return new Date(v.micros / 1000).toISOString();
   }
   if (v instanceof Date) {
      return v.toISOString();
   }
   return null;
}

export function capKey({ gguf_file, quant, kv_quant, backend, gpu }) {
   return [gguf_file, quant, kv_quant, backend, gpu].map((x) => x ?? '∅').join('|');
}
function load(resultsDir) {
   const p = capsPath(resultsDir);
   if (!existsSync(p)) {
      return {};
   }
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
   // Existing entry FIRST so this run's keyFields win. That order matters now that llamacpp_build
   // is provenance rather than part of the key: with the old ordering a stale entry's build would
   // overwrite the current one and the recorded provenance would never advance.
   all[k] = { ...(all[k] ?? {}), ...keyFields, ...values, measured_at: isoTs(values.measured_at) ?? new Date().toISOString() };
   save(resultsDir, all);
   return all[k];
}

/**
 * Seed the cache from the measurement store (Postgres): derive ceilings from `agent_ctx` rows and
 * KV footprint from `kv_per_tok` rows, per config key. `llamacpp_build` is recorded on the entry
 * but is NOT part of the key (see header), so a ceiling measured under an older build does satisfy
 * a run on a newer one; check the entry's build if a ceiling looks wrong for the current binary.
 *
 * agent_ctx measures a shared multi-agent KV pool, so the single-slot ceiling used by the
 * depth probes is taken as its verified planner_ctx; total_ctx / vram document the pool.
 */
export async function seedFromTidy(resultsDir = join(ROOT, 'results')) {
   const nativeByGguf = new Map();
   for (const m of loadModelsConfig(join(ROOT, 'config/models.yaml'), { includeDisabled: true }).models) {
      if (m.hf_file && m.native_max_ctx) {
         nativeByGguf.set(m.hf_file, m.native_max_ctx);
      }
   }
   const ceil = await query(
      `
    SELECT gguf_file, quant, kv_quant, backend, gpu, llamacpp_build,
           max(CASE WHEN metric='planner_ctx' THEN metric_value END) AS coherence_ceiling,
           max(CASE WHEN metric='total_ctx'   THEN metric_value END) AS oom_ceiling,
           max(CASE WHEN metric='total_ctx'   THEN metric_value END) AS ctx_ceiling,
           max(CASE WHEN metric='vram_mib'    THEN metric_value END) AS vram_at_ctx,
           max(ts) AS measured_at, (array_agg(run_id ORDER BY ts DESC))[1] AS source_run_id
    FROM $LATEST WHERE bench='agent_ctx' GROUP BY 1,2,3,4,5,6`,
   );
   const kv = await query(
      `
    SELECT gguf_file, quant, kv_quant, backend, gpu, llamacpp_build,
           avg(CASE WHEN metric='score' THEN metric_value END) AS kv_kib_per_tok
    FROM $LATEST WHERE bench='kv_per_tok' GROUP BY 1,2,3,4,5,6`,
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
         measured_at: isoTs(r.measured_at),
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
