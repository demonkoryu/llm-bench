#!/usr/bin/env node
// Fresh orchestrator — the model × think × bench matrix loop, writing rows to Postgres.
//
// Reuses ONLY the execution/conflict layer (llamacpp-server.mjs server lifecycle,
// client, sampling, host config) + the validated bench cases/graders (benches/*).
// Everything else — the store, the dims, the manifest — is the new clean-slate path.
//
// Usage:
//   SSH_HOST=192.168.1.120 node runners/bench-run.mjs --models Qwen3.6-35B \
//       --benches toolcalling,reasoning --think both --samples 1 --ctx 16384 \
//       [--chat-template /path/to/tmpl.jinja] [--no-router-restart]
//
// Resume is ON BY DEFAULT: a (config × bench) combo already measured successfully is skipped, so
// re-invoking after a crash fills only the genuine gaps. Pass --no-resume (or --force) to
// re-measure everything regardless. NOTE the one case where the default bites: the resume key
// deliberately excludes llamacpp_build, so after a llama.cpp upgrade a plain re-run will NOT
// re-measure the perf probes — use --no-resume for that.
import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseArgs } from 'node:util';
import { readCap, upsertCap } from '../analysis/caps-cache.mjs';
import { ensureSchema, insertRows, markBenchesComplete, query } from '../analysis/pg-store.mjs';
import { BENCHES } from '../benches/index.mjs';
import { LOCAL_HOST, runHostCmd } from '../shared/host-exec.mjs';
import { probeHostBuild } from '../shared/host-probe.mjs';
import { loadHostConfig } from '../shared/hosts-config.mjs';
import { resolveSampling, samplingHash, validateSamplingMatrix } from '../shared/llm/index.mjs';
import { deriveSubjectDims, loadModelsConfig } from '../shared/models-config.mjs';
import { metricRowsFromResult } from '../shared/tidy-schema.mjs';
import { extraFlagsToString, llamacppServer } from './llamacpp-server.mjs';
import { ninferServer } from './ninfer-server.mjs';
import { optiqServer } from './optiq-server.mjs';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const RESULTS = join(ROOT, 'results');
const { values: flags } = parseArgs({
   options: {
      models: { type: 'string', default: '' },
      benches: { type: 'string', default: 'toolcalling,reasoning' },
      think: { type: 'string', default: 'both' }, // both | no_think | think
      samples: { type: 'string', default: '1' },
      ctx: { type: 'string', default: '16384' },
      target: { type: 'string', default: 'rose' },
      'chat-template': { type: 'string' }, // path on host → chat_template='froggeric-…' unless --template-name
      'template-name': { type: 'string' },
      'no-router-restart': { type: 'boolean', default: false },
      // Resume defaults ON. Node's parseArgs has no negatable-boolean support — a
      // { type:'boolean', default:true } option cannot be switched off — so the opt-out is its own
      // explicit flag. --force is an alias for operators who think in terms of "redo it".
      resume: { type: 'boolean', default: true }, // skip (config × bench) combos already measured OK
      'no-resume': { type: 'boolean', default: false }, // re-measure everything, ignoring the store
      force: { type: 'boolean', default: false }, // alias for --no-resume
      'keep-router': { type: 'boolean', default: false }, // don't stop the systemd router (assume host already free)
      local: { type: 'boolean', default: false }, // run host scripts locally (Node is ON the test host); default SSH
   },
});

const SSH = process.env.SSH_HOST || null;
const host = loadHostConfig(join(ROOT, 'config/hosts.yaml'), flags.target);
const ENGINE = host.engine ?? 'llamacpp'; // 'llamacpp' (rose/llama-server) | 'ninfer' (rose/one V100 per instance) | 'optiq' (M1 Mac/MLX)
const SSH_HOST = SSH || host.sshHost;
const LOCAL = flags.local || LOCAL_HOST; // run host scripts locally vs over SSH
const SUDO = LOCAL ? 'sudo -n' : 'sudo'; // non-interactive sudo when on-host
const CTX = Number(flags.ctx);
const SAMPLES = Math.max(1, Number(flags.samples));
const RESUME = flags.resume && !flags['no-resume'] && !flags.force;
const modelFilter = flags.models ? flags.models.split(',').map((s) => s.trim()) : [];
const benchNames = flags.benches
   .split(',')
   .map((s) => s.trim())
   .filter((b) => BENCHES[b]);
const chatTemplatePath = flags['chat-template'] ?? null;
const chatTemplate = flags['template-name'] ?? (chatTemplatePath ? 'froggeric' : 'builtin');

const mean = (xs) => (xs.length ? xs.reduce((a, b) => a + b, 0) / xs.length : null);
const std = (xs) => {
   if (xs.length < 2) {
      return null;
   }
   const m = mean(xs);
   return Math.sqrt(mean(xs.map((x) => (x - m) ** 2)));
};

async function ssh(cmd) {
   const r = await runHostCmd(cmd, { local: LOCAL, sshHost: SSH_HOST });
   return r.stdout;
}

function thinkStatesFor(model) {
   let s = model.think === 'optional' ? [false, true] : model.think === 'required' || model.think === 'reasoning' ? [true] : [null];
   if (flags.think === 'no_think') {
      s = s.filter((x) => x !== true);
   }
   if (flags.think === 'think') {
      s = s.filter((x) => x === true);
   }
   return s.length ? s : [null];
}
const thinkModeOf = (s) => (s === true ? 'think' : 'no_think');

// Aggregate N sample rawRows → one rawRow with means, n, and per-primary spread.
function aggregate(rawRows) {
   if (rawRows.length === 1) {
      return { ...rawRows[0], n: 1 };
   }
   const out = { bench: rawRows[0].bench, status: 'ok', n: rawRows.length, __spread: {} };
   const keys = new Set();
   for (const r of rawRows) {
      for (const k of Object.keys(r)) {
         keys.add(k);
      }
   }
   for (const k of keys) {
      if (k === 'bench' || k === 'status') {
         continue;
      }
      const nums = rawRows.map((r) => r[k]).filter((v) => typeof v === 'number');
      if (nums.length) {
         out[k] = mean(nums);
         const s = std(nums);
         if (s != null) {
            out.__spread[k] = s;
         }
      }
   }
   return out;
}

async function main() {
   // includeDisabled so an explicit --models filter can still target a parked model by name;
   // but an UNfiltered run is active-only (parked models never reach the runner by default,
   // matching the "runners never see disabled" contract in shared/models-config.mjs).
   const cfg = loadModelsConfig(join(ROOT, 'config/models.yaml'), { includeDisabled: true });
   // Engine filter (always applied): a model only runs on a host of its own engine. This keeps
   // the MLX entry (engine: optiq) OUT of every rose/llama.cpp run — and llama.cpp models out
   // of an m1 run — even when --models names it, since it couldn't serve on the wrong engine anyway.
   const models = cfg.models.filter(
      (m) =>
         (m.engine ?? 'llamacpp') === ENGINE &&
         (modelFilter.length ? modelFilter.some((f) => (m.label ?? '').includes(f) || m.hf_file.includes(f)) : m.disabled !== true),
   );
   if (!models.length) {
      console.error('no models matched');
      process.exit(1);
   }
   const matrix = cfg.sampling_matrix ?? {};
   // Sampling overrides key on a bench's declared samplingProfile. Validate the matrix against the
   // profiles the registry actually declares, so a stale or misspelled key fails the run instead of
   // resolving to nothing (which is how the `coding` override stayed dead for months).
   const declaredProfiles = new Set(
      Object.values(BENCHES)
         .map((b) => b.samplingProfile)
         .filter(Boolean),
   );
   validateSamplingMatrix(matrix, declaredProfiles);
   const profileOf = (benchName) => BENCHES[benchName]?.samplingProfile ?? null;

   const stamp = new Date()
      .toISOString()
      .replace(/[-:T]/g, '')
      .slice(0, 14)
      .replace(/(\d{8})(\d{6})/, '$1-$2');
   const run_id = `${slug(host.gpu)}-${host.backend}-${stamp}-benchrun`;
   // The llama.cpp build/driver probe SSHes to the host and runs `llama-server --version`. OptiQ
   // has no such binary — leave llamacpp_build null (nullable in the schema) on non-llamacpp engines.
   const { llamacpp_build, driver } =
      ENGINE === 'llamacpp'
         ? await probeHostBuild({
              sshHost: SSH_HOST,
              binPath:
                 host.backends?.[host.backend]?.bin ??
                 (host.backends?.[host.backend]?.image ? `docker:${host.backends[host.backend].image}` : null),
              local: LOCAL,
           })
         : { llamacpp_build: null, driver: null };
   console.error(
      `[bench-run] ${models.length} models · benches=[${benchNames}] · think=${flags.think} · samples=${SAMPLES} · build=${llamacpp_build} · template=${chatTemplate} · exec=${LOCAL ? 'local' : 'ssh'}`,
   );

   // Stop the production llama-server container to free GPU VRAM for the bench run. NInfer shares
   // the same box and the same two cards, so it needs that container gone too — a resident
   // llama-server would both steal VRAM and skew every per-device reading. OptiQ is on a different
   // machine and runs its own persistent daemon — nothing for us to stop there.
   if ((ENGINE === 'llamacpp' || ENGINE === 'ninfer') && !flags['keep-router']) {
      const r = await ssh(`docker stop llama-server 2>/dev/null; docker rm -f llama-server 2>/dev/null; echo stopped`);
      console.error(`[bench-run] production server: ${r || 'n/a'}`);
   }
   const restore = async () => {
      if (ENGINE === 'llamacpp' && !flags['no-router-restart'] && !flags['keep-router']) {
         console.error('[bench-run] production server not auto-restarted (container lifecycle — start manually if needed)');
      }
   };
   process.on('SIGINT', async () => {
      await restore();
      process.exit(130);
   });

   const srv =
      ENGINE === 'optiq'
         ? optiqServer({ inferenceUrl: host.llamaUrl, debug: !!process.env.BENCH_DEBUG })
         : ENGINE === 'ninfer'
           ? ninferServer({
                sshHost: SSH_HOST,
                inferenceUrl: host.llamaUrl,
                // One instance owns one card. Everything host-side is scoped by this index, so a
                // missing `device:` in hosts.yaml must not silently become "gpu0" for both targets.
                device: host.device ?? 0,
                artifactDir: host.artifactDir,
                image: host.image,
                debug: !!process.env.BENCH_DEBUG,
                local: LOCAL,
             })
           : llamacppServer({
              sshHost: SSH_HOST,
              llamaUrl: host.llamaUrl,
              backend: host.backend,
              debug: !!process.env.BENCH_DEBUG,
              local: LOCAL,
           });
   const client = srv.client;
   // Incremental persistence: each bench/probe result is inserted into Postgres immediately, so
   // a crash or kill never loses completed work (--resume re-reads what's already in the store).
   await ensureSchema();
   let writtenTotal = 0;
   // Rows land as 'partial' and are promoted to 'ok' by markBenchesComplete() once their bench
   // finishes. That keeps the incremental persistence above (nothing measured is ever lost) while
   // making an interrupted bench distinguishable from a finished one — which is what lets resume
   // retry it. Statuses a bench sets deliberately (e.g. agent_ctx's 'skip') are left alone.
   const flush = async (rows) => {
      if (!rows.length) {
         return;
      }
      for (const r of rows) {
         if (r.status === 'ok') {
            r.status = 'partial';
         }
      }
      const r = await insertRows(rows);
      writtenTotal += r.rows;
   };
   const platformBase = {
      host: host.raw?.label ? flags.target : flags.target,
      gpu: host.gpu,
      vram_total: host.vramTotalMib,
      backend: host.backend,
      llamacpp_build,
      // Mutated once below, after the first server is up: on llama.cpp the build probe already
      // answered this, but OptiQ only reveals its version in a response's system_fingerprint.
      // common() reads platformBase at row-build time, so the later fill-in reaches every row.
      engine_version: llamacpp_build,
      // probeHostBuild returns this (nvidia-smi / rocm-smi); it used to be destructured away and
      // hardcoded null, so `driver` was null on every row of every run on every host.
      driver: driver ?? null,
   };
   // OptiQ is a persistent daemon that is already serving, so its version can be read now — one
   // 1-token completion, best-effort. Doing it here (rather than per model) keeps it off the
   // measured path entirely. Null stays null if the daemon is unreachable; the run then fails on
   // its own in startServer with a much better message than a version probe would give.
   if (ENGINE === 'optiq' || ENGINE === 'ninfer') {
      // OptiQ reads it from a response's system_fingerprint (its daemon is already serving);
      // NInfer reads the source-commit label off the pinned image, which needs no server at all.
      platformBase.engine_version = await srv.engineVersion();
      console.error(`[bench-run] engine_version: ${platformBase.engine_version ?? 'unknown'}`);
   }

   // ── Resume (default ON) ────────────────────────────────────────────────────────────────────
   // Skip (config × bench) combos already measured successfully, including from prior runs and
   // crashed partials, so a re-invocation fills only genuine gaps.
   //
   // Every dim the dashboard compares along must be in the key, or a run differing ONLY in that dim
   // is silently skipped and the store quietly answers the wrong question. In particular `ctx`: the
   // Qwen3.6-27B-4bit control ran at 16384, and without ctx here a 65536 re-run would be dropped as
   // already-done.
   //
   // Two deliberate EXCLUSIONS:
   //  · llamacpp_build — scoring merges across build (build is not an entity dim), so a combo
   //    measured under any build counts as done. Trade-off, now sharper because resume is the
   //    default: a llama.cpp upgrade will NOT re-measure the perf probes, where build genuinely
   //    moves the numbers. Use --no-resume after a build bump.
   //  · n (sample count) — not an equality dim but a threshold one; handled below via max(n), so
   //    `--samples 5` after a samples=1 run re-measures while `--samples 1` after samples=5 skips.
   const SEP = '␟';
   const RESUME_KEY = [
      'gguf_file',
      'kv_quant',
      'chat_template',
      'sampling_hash', // real sampling identity; sampling_profile is only family/think_mode
      'ctx',
      'n_parallel',
      'batch',
      'ubatch',
      'spec_decode',
      'host', // two hosts with the same GPU are otherwise indistinguishable
      'backend',
      'gpu',
      'bench',
      'think_mode',
   ];
   // ONE key builder for both the store side and the candidate side, so the two cannot drift.
   const keyOf = (d) => RESUME_KEY.map((c) => (d[c] == null ? '' : String(d[c]))).join(SEP);

   // key → highest sample count recorded for it.
   const doneSet = new Map();
   if (RESUME) {
      // status='ok' is essential: rows are written 'partial' and only promoted once the bench
      // completes, so without this filter a combo whose every row is a crashed partial (or a 'skip')
      // would count as done and never be retried.
      const cols = RESUME_KEY.map((c) => `"${c}"`).join(', ');
      try {
         for (const r of await query(`SELECT ${cols}, max(n) AS samples FROM $TIDY WHERE status = 'ok' GROUP BY ${cols}`)) {
            doneSet.set(keyOf(r), r.samples ?? 1);
         }
      } catch {
         /* empty store */
      }
      console.error(
         `[bench-run] resume ON: ${doneSet.size} (config×bench) combos already complete — skipping them (--no-resume/--force to re-measure)`,
      );
   } else {
      console.error(`[bench-run] resume OFF (${flags.force ? '--force' : '--no-resume'}): every requested combo will be re-measured`);
   }
   const needed = (dims) => {
      if (!RESUME) {
         return true;
      }
      const have = doneSet.get(keyOf(dims));
      return have == null || have < SAMPLES;
   };

   try {
      for (const m of models) {
         const subject = deriveSubjectDims(m);
         const ef = typeof m.extra_flags === 'object' ? m.extra_flags : {};
         // KV-quant tag: kv-variant tag, else a llama.cpp cache-type flag, else a model-declared
         // override. The override is how a non-llama.cpp engine records its KV precision — the MLX
         // entry sets `kv_quant: int4` (OptiQ `--kv-bits 4`, a serve-time flag) so its
         // rows are a distinct config dim, not a null-KV placeholder.
         const kv_quant = m.variant?.replace(/^kv/, '') ?? m.kv_quant ?? ef['cache-type-k'] ?? null;
         // Per-model chat template: a model may pin one; falls back to the run-wide flag.
         const modelTemplate = m.chat_template ?? chatTemplate;
         const serving = {
            chat_template: modelTemplate,
            kv_quant,
            flash_attn: true,
            ctx: CTX,
            n_parallel: ef.parallel ?? 1,
            batch: ef['batch-size'] ?? null,
            ubatch: ef['ubatch-size'] ?? null,
            // spec_decode: llama.cpp draft flag, else a model-declared override. The MLX entry can
            // set `spec_decode: mtp` (RapidMLX `--enable-mtp`) so its rows record MTP-accelerated decode.
            spec_decode: ef['spec-type'] ?? m.spec_decode ?? null,
         };
         const capKeyFields = {
            gguf_file: subject.gguf_file,
            quant: subject.quant,
            kv_quant,
            backend: host.backend,
            gpu: host.gpu,
            llamacpp_build,
         };
         const wantBenches = benchNames.filter((b) => BENCHES[b]);
         // The resume key's non-bench half, fixed for this model on this host.
         const resumeDims = { ...subject, ...serving, ...platformBase };
         const need = (benchName, think_mode, sampling_hash) => needed({ ...resumeDims, sampling_hash, bench: benchName, think_mode });
         // Sampling is resolved per (think state, sampling profile) — the profile override means
         // toolcalling and coding can carry different params for the same model — so the hash is too.
         const hashFor = (think, benchName) => samplingHash(resolveSampling(m, think, profileOf(benchName), matrix));
         // Nothing pending for this model? Skip it entirely (no server load). Probes resolve their
         // own sampling, so they key on a null hash — matching what they persist.
         const anyNeeded = wantBenches.some((b) =>
            BENCHES[b].kind === 'probe'
               ? need(BENCHES[b].resumeBench ?? b, 'n/a', null)
               : (BENCHES[b].thinkDependent ? thinkStatesFor(m) : [m.think === 'optional' ? false : null]).some((t) =>
                    need(b, BENCHES[b].thinkDependent ? thinkModeOf(t) : 'n/a', hashFor(t, b)),
                 ),
         );
         if (!anyNeeded) {
            console.error(`\n══ ${m.label ?? m.hf_file} — all requested benches already measured (resume), skipping`);
            continue;
         }

         console.error(`\n══ ${m.label ?? m.hf_file}`);
         // Only pre-start a full model server when something needs it. Regular benches
         // run against this server; but self-managing probes (agent_ctx, fit_ctx) reload or
         // kill it themselves. For a probe-only run of those, skip the pre-start — it is
         // slow and can hang past waitHealthy on cold non-QAT models (fit_ctx doesn't even
         // need a running server; it computes the fit analytically via llama-fit-params).
         const needsPrestartServer = (b) => BENCHES[b].kind !== 'probe' || !BENCHES[b].selfManagesServer;
         const doPrestart = wantBenches.some(needsPrestartServer);
         if (doPrestart) {
            await srv.killAll();
            await srv.waitVramClear(30000).catch(() => {});
            const extraFlags = [extraFlagsToString(m.extra_flags), chatTemplatePath ? `--chat-template-file ${chatTemplatePath}` : '']
               .filter(Boolean)
               .join(' ');
            try {
               await srv.startServer({ hf_repo: m.hf_repo, hf_file: m.hf_file, mlxModel: m.mlx_model, ctx: CTX, extraFlags });
               await srv.waitHealthy(360000);
            } catch (e) {
               console.error(`  load failed: ${(e.message ?? '').slice(0, 80)} — skipping`);
               continue;
            }
         }

         // Regular (client-prompt) benches first — they use the server loaded above.
         for (const benchName of wantBenches.filter((b) => BENCHES[b].kind !== 'probe')) {
            const bench = BENCHES[benchName];
            const states = bench.thinkDependent ? thinkStatesFor(m) : [m.think === 'optional' ? false : null];
            for (const think of states) {
               const think_mode = bench.thinkDependent ? thinkModeOf(think) : 'n/a';
               const sampling = resolveSampling(m, think, profileOf(benchName), matrix);
               const sampling_hash = samplingHash(sampling);
               if (!need(benchName, think_mode, sampling_hash)) {
                  console.error(`  ${benchName.padEnd(14)} ${think_mode.padEnd(8)} — done (resume)`);
                  continue;
               }
               const thinkControl = m.think_control ?? 'enable_thinking';
               const runs = [];
               for (let i = 0; i < SAMPLES; i++) {
                  try {
                     runs.push(await bench.run(client, { model: m, think, sampling, thinkControl }));
                  } catch (e) {
                     console.error(`  ${benchName}/${think_mode} sample ${i}: ${(e.message ?? '').slice(0, 60)}`);
                  }
               }
               if (!runs.length) {
                  continue;
               }
               const raw = aggregate(runs);
               const dims = {
                  ...common(run_id, subject, serving, platformBase),
                  think_mode,
                  ts: nowTs(),
                  sampling_profile: subject.family ? `${subject.family}/${think_mode}` : null,
                  sampling_hash,
               };
               await flush(metricRowsFromResult(raw, dims));
               // Every sample that survived is a valid measurement, so promote even when some
               // samples threw — the recorded n is what it is, and the max(n) >= SAMPLES check
               // brings this combo back on a later run if the shortfall matters.
               await markBenchesComplete(run_id, [raw.bench ?? benchName]);
               const summary =
                  raw.toolcall_pass != null
                     ? `${raw.toolcall_pass}/${raw.toolcall_total}`
                     : raw.reasoning_correct != null
                       ? `${raw.reasoning_correct}/${raw.reasoning_total}`
                       : 'ok';
               console.error(`  ${benchName.padEnd(14)} ${think_mode.padEnd(8)} → ${summary}${SAMPLES > 1 ? ` (n=${raw.n})` : ''}`);
            }
         }
         // Probe benches last — they self-manage the server (reload at ceiling / --parallel).
         // Re-read caps PER PROBE so a capacity probe (if run first) populates the ceiling
         // that the depth probes (throughput/quality_decay) then load at.
         for (const benchName of wantBenches.filter((b) => BENCHES[b].kind === 'probe')) {
            if (!need(BENCHES[benchName].resumeBench ?? benchName, 'n/a', null)) {
               console.error(`  ${benchName.padEnd(14)} probe    — done (resume)`);
               continue;
            }
            const caps = readCap(RESULTS, capKeyFields);
            const probeCtx = {
               srv,
               client,
               model: m,
               ctx: CTX,
               // depth at which server-reloading probes (throughput/speed/quality_decay/…)
               // load. Sourced from the caps cache if a capacity probe populated it, else the
               // model's empirical ctx_cap, else the requested CTX. (The old maxctx probe used
               // to seed coherence_ceiling; agent_ctx measures a shared pool, not a single-slot
               // ceiling, so these depth probes fall back to ctx_cap.)
               maxctx: caps?.coherence_ceiling ?? m.ctx_cap ?? CTX,
               caps,
               // Usable VRAM on THIS host (config/hosts.yaml vram_total_mib). agent_ctx gates its
               // shared-KV-pool search on it; passing it instead of a literal keeps the probe
               // honest when the same code runs on a different GPU.
               vramTotalMib: host.vramTotalMib ?? null,
               upsertCap: (v) => upsertCap(RESULTS, capKeyFields, { ...v, source_run_id: run_id }),
            };
            // A probe emits MANY sub-bench rows (speed → speed_short, speed_prefill-4k,
            // speed_long-32k, …). If it throws partway we keep the rows it did produce — they cost
            // real GPU time — but leave them 'partial' so resume retries the probe instead of
            // treating a third of a probe as a finished one.
            let rawRows = [];
            let completed = true;
            try {
               rawRows = (await BENCHES[benchName].run(probeCtx)) || [];
            } catch (e) {
               completed = false;
               console.error(`  ${benchName}: ${(e.message ?? '').slice(0, 70)}`);
            }
            const dims = {
               ...common(run_id, subject, serving, platformBase),
               think_mode: 'n/a',
               ts: nowTs(),
               // Probes resolve their own sampling internally, so there is no run-level profile or
               // hash to record. Null here matches what the resume key looks up for them.
               sampling_profile: null,
               sampling_hash: null,
            };
            await flush(rawRows.flatMap((raw) => metricRowsFromResult(raw, dims)));
            if (completed) {
               await markBenchesComplete(run_id, [...new Set(rawRows.map((r) => r.bench).filter(Boolean))]);
            }
            console.error(`  ${benchName.padEnd(14)} probe    → ${rawRows.length} rows${completed ? '' : ' (PARTIAL — will retry)'}`);
         }
         await srv.stopServer().catch(() => {});
      }
   } finally {
      await srv.killAll().catch(() => {});
      await restore();
   }

   // manifest (lifecycle/provenance only; the measurement rows live in Postgres)
   const manDir = join(RESULTS, 'runs', run_id);
   mkdirSync(manDir, { recursive: true });
   writeFileSync(
      join(manDir, 'run.json'),
      JSON.stringify(
         {
            run_id,
            kind: 'benchrun',
            host: flags.target,
            gpu: host.gpu,
            backend: host.backend,
            llamacpp_build,
            engine_version: platformBase.engine_version,
            chat_template: chatTemplate,
            resume: RESUME,
            benches: benchNames,
            samples: SAMPLES,
            ctx: CTX,
            tidy_rows: writtenTotal,
            started: nowTs(),
            status: 'complete',
         },
         null,
         2,
      ),
   );
   console.error(`\n[bench-run] wrote ${writtenTotal} measurement rows → Postgres · run ${run_id}`);
}

function slug(s) {
   return String(s ?? '')
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, '');
}
function nowTs() {
   return new Date().toISOString();
}
function common(run_id, subject, serving, platform) {
   return { run_id, run_kind: 'benchrun', seed_run_id: null, ...subject, ...serving, ...platform };
}
function push(rows, raw, dims) {
   for (const r of metricRowsFromResult(raw, dims)) {
      rows.push(r);
   }
}

main().catch((e) => {
   console.error(e);
   process.exit(1);
});
