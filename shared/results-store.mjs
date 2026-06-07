/**
 * Result store for llm-bench — a clean, JSON-native run format (node-side I/O).
 *
 * Every runner invocation writes ONE immutable run directory:
 *
 *   results/runs/<run_id>/run.json
 *
 * run.json is fully self-describing — provenance (host/gpu/backend/environment),
 * lifecycle (started/finished/status), the planned work matrix, and the measured
 * result rows all live in a single object:
 *
 *   {
 *     run_id, kind,                       // identity + which runner produced it
 *     host, gpu, backend, environment,    // provenance / readable server fingerprint
 *     started, finished, status,          // lifecycle: running|complete|partial|aborted
 *     seed,                               // run_id this secondary run read maxctx etc. from
 *     planned: [{ model, think, bench }], // the matrix this run intended to cover
 *     results: [{ model, think, bench, status, ts, ...measurements }],
 *   }
 *
 * The pure scoring/merge/identity helpers (aggregateModels, computeMetrics,
 * scoreGroups, computeFleet, mergeResultRows, baseModel, isSharedBench, slugify,
 * GROUPS, DEFAULT_DIALS, SCORING, CARD_TOTAL_MIB) live in shared/scoring.mjs — a pure
 * module with no node imports, so the dashboard can run the identical code in-browser.
 * They are re-exported here so existing importers keep working unchanged.
 */

import { existsSync, mkdirSync, readdirSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import yaml from 'js-yaml';
import {
   aggregateModels,
   baseModel,
   CARD_TOTAL_MIB,
   computeFleet,
   computeMetrics,
   DEFAULT_DIALS,
   GROUPS,
   isSharedBench,
   mergeResultRows,
   SCORING,
   scoreGroups,
   slugify,
   stripVariant,
} from './scoring.mjs';

// Re-export the pure scoring/identity surface so consumers can import either module.
export {
   aggregateModels,
   baseModel,
   CARD_TOTAL_MIB,
   computeFleet,
   computeMetrics,
   DEFAULT_DIALS,
   GROUPS,
   isSharedBench,
   mergeResultRows,
   SCORING,
   scoreGroups,
   slugify,
   stripVariant,
};

// ── Result row shape (documented, not enforced) ──────────────────────────────────
//
// A result row is a plain object identified by (model, think, bench). It always
// carries `status` ('ok' | 'error' | …) and a `ts` (ISO 8601, stamped on append),
// plus whichever measurement fields the bench produces:
//
//   score, halls, json_fail, tok_s, prefill_tps, vram_mib, ctx_loaded,
//   oom_ceiling, coherence_ceiling, wall_s, notes
//
// Provenance (host/gpu/backend/environment/run_id) lives on the RUN, not the row.

const pad = (n) => String(n).padStart(2, '0');

/** Local YYYYMMDD-HHMMSS (NOT for use inside workflow scripts — new Date() is fine here). */
export function timestamp(date) {
   return (
      `${date.getFullYear()}${pad(date.getMonth() + 1)}${pad(date.getDate())}` +
      `-${pad(date.getHours())}${pad(date.getMinutes())}${pad(date.getSeconds())}`
   );
}

/**
 * Build a run id: <host>-<gpu>-<backend>-<datetime>, suffixed with the runner kind
 * for non-suite runs so secondary catch-up runs get distinct directories.
 */
export function runIdFrom({ host, gpu, backend, date, kind }) {
   const base = `${slugify(host)}-${slugify(gpu)}-${slugify(backend)}-${timestamp(date)}`;
   return kind && kind !== 'suite' ? `${base}-${slugify(kind)}` : base;
}

// ── Run-scoped layout (results/runs/<run_id>/run.json) ───────────────────────────

export const RUNS_DIRNAME = 'runs';

/** results/runs/<run_id>/ — one immutable directory per runner invocation. */
export function runDir(resultsDir, runId) {
   return join(resultsDir, RUNS_DIRNAME, runId);
}

/** results/runs/<run_id>/run.json */
export function runJsonPath(resultsDir, runId) {
   return join(runDir(resultsDir, runId), 'run.json');
}

/** Parse a run.json into a run object (results[] guaranteed), or null if unreadable. */
function parseRun(path) {
   try {
      const run = JSON.parse(readFileSync(path, 'utf8'));
      if (!Array.isArray(run.results)) {
         run.results = [];
      }
      return run;
   } catch {
      return null;
   }
}

/** Read a run by id, or null if absent/unparseable. */
export function readRun(resultsDir, runId) {
   const p = runJsonPath(resultsDir, runId);
   return existsSync(p) ? parseRun(p) : null;
}

/** Run ids present under results/runs/ (those with a run.json), oldest → newest. */
export function listRuns(resultsDir) {
   const dir = join(resultsDir, RUNS_DIRNAME);
   if (!existsSync(dir)) {
      return [];
   }
   return readdirSync(dir, { withFileTypes: true })
      .filter((d) => d.isDirectory() && existsSync(join(dir, d.name, 'run.json')))
      .map((d) => d.name)
      .sort(); // run ids embed a sortable timestamp
}

/** Newest run id, optionally filtered by run kind (e.g. 'suite'). */
export function latestRun(resultsDir, { kind } = {}) {
   const runs = listRuns(resultsDir);
   for (let i = runs.length - 1; i >= 0; i--) {
      if (!kind || readRun(resultsDir, runs[i])?.kind === kind) {
         return runs[i];
      }
   }
   return null;
}

/** Resolve a single --input token (run id | run dir | run.json path) to a run object. */
function loadRunFromToken(resultsDir, token) {
   if (existsSync(token)) {
      const p = statSync(token).isDirectory() ? join(token, 'run.json') : token;
      return existsSync(p) ? parseRun(p) : null;
   }
   return readRun(resultsDir, token); // a bare run id
}

/**
 * Resolve --input tokens to run objects. With no tokens it defaults to the single
 * newest run. Unresolvable tokens are dropped. Feed merged `results` through
 * mergeResultRows so input ORDER never affects the result.
 */
export function loadRuns(resultsDir, tokens) {
   if (tokens?.length) {
      return tokens.map((t) => loadRunFromToken(resultsDir, t)).filter(Boolean);
   }
   const latest = latestRun(resultsDir);
   return latest ? [readRun(resultsDir, latest)] : [];
}

/** All runs under results/runs/, oldest → newest. */
export function loadAllRuns(resultsDir) {
   return listRuns(resultsDir)
      .map((id) => readRun(resultsDir, id))
      .filter(Boolean);
}

/** complete = every planned (model|think|bench) has a successful result; else partial. */
function deriveStatus(run) {
   if (!run.planned?.length) {
      return run.results.length ? 'complete' : 'partial';
   }
   const ok = new Set(run.results.filter((r) => r.status === 'ok').map((r) => `${r.model}|${r.think}|${r.bench}`));
   return run.planned.every((p) => ok.has(`${p.model}|${p.think}|${p.bench}`)) ? 'complete' : 'partial';
}

/**
 * Create a run directory and return a small recorder. The run.json is rewritten on
 * every append and on finalize, so a crash leaves a readable `running` run.
 *
 * @param resultsDir  results/ root
 * @param meta { host, gpu, backend, date, kind, planned?, environment?, seed?, run_id?, started?, extra? }
 */
export function createRun(resultsDir, meta) {
   const runId = meta.run_id ?? runIdFrom(meta);
   const dir = runDir(resultsDir, runId);
   mkdirSync(dir, { recursive: true });
   const jsonPath = join(dir, 'run.json');

   const run = {
      run_id: runId,
      kind: meta.kind ?? 'suite',
      host: meta.host ?? null,
      gpu: meta.gpu ?? null,
      backend: meta.backend ?? null,
      // Readable server fingerprint (shared/run-fingerprint.mjs). Replaces the old
      // opaque config_hash; null on pre-fingerprint runs.
      environment: meta.environment ?? null,
      started: meta.started ?? new Date().toISOString(),
      finished: null,
      status: 'running',
      seed: meta.seed ?? null,
      planned: meta.planned ?? [],
      results: [],
      ...(meta.extra ?? {}), // run-specific fields (e.g. filters) merged into the run
   };
   const write = () => writeFileSync(jsonPath, `${JSON.stringify(run, null, 2)}\n`, 'utf8');
   write();

   return {
      runId,
      dir,
      jsonPath,
      run,
      /** Append a result row (auto-stamped with `ts`) and persist. */
      append(row) {
         run.results.push({ ...row, ts: row.ts ?? new Date().toISOString() });
         write();
      },
      /** Set finished + terminal status ('complete'|'partial'|'aborted'); defaults to derived. */
      finalize(status) {
         run.finished = new Date().toISOString();
         run.status = status ?? deriveStatus(run);
         write();
         return run.status;
      },
   };
}

/**
 * Open a write run for a single-purpose secondary runner (kv-probe, struct-output,
 * ttft, …) and return the merged result rows it should pull prior data from. The
 * secondary run inherits the seed run's `environment` so its rows carry the same
 * server fingerprint (override via the `environment` arg).
 *
 * @returns {{ run, seedRows }}
 */
export function openSecondaryRun(resultsDir, { target, gpu, backend = 'vulkan', kind, inputFlag, environment }) {
   const seedRuns = loadRuns(resultsDir, inputFlag ? [inputFlag] : undefined);
   const seedRows = mergeResultRows(seedRuns.flatMap((r) => r.results));
   const run = createRun(resultsDir, {
      host: target,
      gpu,
      backend,
      date: new Date(),
      kind,
      environment: environment ?? seedRuns[0]?.environment ?? null,
      seed: seedRuns[0]?.run_id ?? null,
   });
   return { run, seedRows };
}

// ── Capabilities (config-derived, node-side) ─────────────────────────────────────

/**
 * Load declared model capabilities from config/models.yaml, keyed by base id
 * (hf_file minus .gguf). Returns Map<baseId, { tools: boolean, note: string|null }>.
 */
export function loadCapabilities(modelsYamlPath) {
   const caps = new Map();
   try {
      const cfg = yaml.load(readFileSync(modelsYamlPath, 'utf8'));
      for (const m of cfg.models ?? []) {
         const base = String(m.hf_file ?? '').replace(/\.gguf$/i, '');
         if (base) {
            caps.set(base, { tools: m.tools === true, note: m.capability_note ?? null });
         }
      }
   } catch {
      /* no capabilities available */
   }
   return caps;
}
