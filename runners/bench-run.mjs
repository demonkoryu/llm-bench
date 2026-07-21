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
import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseArgs } from 'node:util';
import { readCap, upsertCap } from '../analysis/caps-cache.mjs';
import { ensureSchema, insertRows, query } from '../analysis/pg-store.mjs';
import { BENCHES } from '../benches/index.mjs';
import { LOCAL_HOST, runHostCmd } from '../shared/host-exec.mjs';
import { probeHostBuild } from '../shared/host-probe.mjs';
import { loadHostConfig } from '../shared/hosts-config.mjs';
import { resolveSampling } from '../shared/llm/index.mjs';
import { deriveSubjectDims, loadModelsConfig } from '../shared/models-config.mjs';
import { metricRowsFromResult } from '../shared/tidy-schema.mjs';
import { extraFlagsToString, llamacppServer } from './llamacpp-server.mjs';

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
      resume: { type: 'boolean', default: false }, // skip (config × bench × think) combos already in the store
      'keep-router': { type: 'boolean', default: false }, // don't stop the systemd router (assume host already free)
      local: { type: 'boolean', default: false }, // run host scripts locally (Node is ON the test host); default SSH
   },
});

const SSH = process.env.SSH_HOST || null;
const host = loadHostConfig(join(ROOT, 'config/hosts.yaml'), flags.target);
const SSH_HOST = SSH || host.sshHost;
const LOCAL = flags.local || LOCAL_HOST; // run host scripts locally vs over SSH
const SUDO = LOCAL ? 'sudo -n' : 'sudo'; // non-interactive sudo when on-host
const CTX = Number(flags.ctx);
const SAMPLES = Math.max(1, Number(flags.samples));
const modelFilter = flags.models ? flags.models.split(',').map((s) => s.trim()) : [];
const benchNames = flags.benches
   .split(',')
   .map((s) => s.trim())
   .filter((b) => BENCHES[b]);
const chatTemplatePath = flags['chat-template'] ?? null;
const chatTemplate = flags['template-name'] ?? (chatTemplatePath ? 'froggeric' : 'builtin');

const mean = (xs) => (xs.length ? xs.reduce((a, b) => a + b, 0) / xs.length : null);
const std = (xs) => {
   if (xs.length < 2) { return null; }
   const m = mean(xs);
   return Math.sqrt(mean(xs.map((x) => (x - m) ** 2)));
};

async function ssh(cmd) {
   const r = await runHostCmd(cmd, { local: LOCAL, sshHost: SSH_HOST });
   return r.stdout;
}

function thinkStatesFor(model) {
   let s = model.think === 'optional' ? [false, true] : model.think === 'required' || model.think === 'reasoning' ? [true] : [null];
   if (flags.think === 'no_think') { s = s.filter((x) => x !== true); }
   if (flags.think === 'think') { s = s.filter((x) => x === true); }
   return s.length ? s : [null];
}
const thinkModeOf = (s) => (s === true ? 'think' : 'no_think');

// Aggregate N sample rawRows → one rawRow with means, n, and per-primary spread.
function aggregate(rawRows) {
   if (rawRows.length === 1) { return { ...rawRows[0], n: 1 }; }
   const out = { bench: rawRows[0].bench, status: 'ok', n: rawRows.length, __spread: {} };
   const keys = new Set();
   for (const r of rawRows) { for (const k of Object.keys(r)) { keys.add(k); } }
   for (const k of keys) {
      if (k === 'bench' || k === 'status') { continue; }
      const nums = rawRows.map((r) => r[k]).filter((v) => typeof v === 'number');
      if (nums.length) {
         out[k] = mean(nums);
         const s = std(nums);
         if (s != null) { out.__spread[k] = s; }
      }
   }
   return out;
}

async function main() {
   // includeDisabled so an explicit --models filter can still target a parked model by name;
   // but an UNfiltered run is active-only (parked models never reach the runner by default,
   // matching the "runners never see disabled" contract in shared/models-config.mjs).
   const cfg = loadModelsConfig(join(ROOT, 'config/models.yaml'), { includeDisabled: true });
   const models = cfg.models.filter((m) =>
      modelFilter.length ? modelFilter.some((f) => (m.label ?? '').includes(f) || m.hf_file.includes(f)) : m.disabled !== true,
   );
   if (!models.length) {
      console.error('no models matched');
      process.exit(1);
   }
   const matrix = cfg.sampling_matrix ?? {};

   const stamp = new Date()
      .toISOString()
      .replace(/[-:T]/g, '')
      .slice(0, 14)
      .replace(/(\d{8})(\d{6})/, '$1-$2');
   const run_id = `${slug(host.gpu)}-${host.backend}-${stamp}-benchrun`;
   const { llamacpp_build } = await probeHostBuild({ sshHost: SSH_HOST, binPath: host.backends?.[host.backend]?.bin, local: LOCAL });
   console.error(
      `[bench-run] ${models.length} models · benches=[${benchNames}] · think=${flags.think} · samples=${SAMPLES} · build=${llamacpp_build} · template=${chatTemplate} · exec=${LOCAL ? 'local' : 'ssh'}`,
   );

   if (!flags['keep-router']) {
      const r = await ssh(`${SUDO} systemctl stop llama-server 2>&1 && echo stopped`);
      console.error(`[bench-run] router: ${r || 'n/a'}`);
   }
   const restore = async () => {
      if (!flags['no-router-restart'] && !flags['keep-router']) {
         await ssh(`${SUDO} systemctl start llama-server`);
         console.error('[bench-run] router restarted');
      }
   };
   process.on('SIGINT', async () => {
      await restore();
      process.exit(130);
   });

   const srv = llamacppServer({
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
   const flush = async (rows) => {
      if (!rows.length) { return; }
      const r = await insertRows(rows);
      writtenTotal += r.rows;
   };
   const platformBase = {
      host: host.raw?.label ? flags.target : flags.target,
      gpu: host.gpu,
      vram_total: host.vramTotalMib,
      backend: host.backend,
      llamacpp_build,
      driver: null,
   };

   // Resume: skip (config × bench × think) combos already in the store (incl. from prior
   // runs / a crashed partial). Keyed on the full identity so a different build re-measures.
   const SEP = '␟';
   const doneSet = new Set();
   if (flags.resume) {
      try {
         for (const r of await query(
            `SELECT DISTINCT gguf_file, kv_quant, chat_template, backend, gpu, llamacpp_build, bench, think_mode FROM $TIDY`,
         )) {
            doneSet.add(
               [r.gguf_file, r.kv_quant ?? '', r.chat_template, r.backend, r.gpu, r.llamacpp_build ?? '', r.bench, r.think_mode].join(SEP),
            );
         }
      } catch {
         /* empty store */
      }
      console.error(`[bench-run] --resume: ${doneSet.size} (config×bench×think) combos already measured — will skip them`);
   }
   const needed = (subject, kv_quant, bench, think_mode) =>
      !flags.resume ||
      !doneSet.has(
         [subject.gguf_file, kv_quant ?? '', chatTemplate, host.backend, host.gpu, llamacpp_build ?? '', bench, think_mode].join(SEP),
      );

   try {
      for (const m of models) {
         const subject = deriveSubjectDims(m);
         const ef = typeof m.extra_flags === 'object' ? m.extra_flags : {};
         const kv_quant = m.variant?.replace(/^kv/, '') ?? ef['cache-type-k'] ?? null;
         const serving = {
            chat_template: chatTemplate,
            kv_quant,
            flash_attn: true,
            ctx: CTX,
            n_parallel: ef.parallel ?? 1,
            batch: ef['batch-size'] ?? null,
            ubatch: ef['ubatch-size'] ?? null,
            spec_decode: ef['spec-type'] ?? null,
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
         const need = (benchName, think_mode) => needed(subject, kv_quant, benchName, think_mode);
         // Nothing pending for this model? Skip it entirely (no server load).
         const anyNeeded = wantBenches.some((b) =>
            BENCHES[b].kind === 'probe'
               ? need(BENCHES[b].resumeBench ?? b, 'n/a')
               : (BENCHES[b].thinkDependent ? thinkStatesFor(m) : [null]).some((t) =>
                    need(b, BENCHES[b].thinkDependent ? thinkModeOf(t) : 'n/a'),
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
               await srv.startServer({ hf_repo: m.hf_repo, hf_file: m.hf_file, ctx: CTX, extraFlags });
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
               if (!need(benchName, think_mode)) {
                  console.error(`  ${benchName.padEnd(14)} ${think_mode.padEnd(8)} — done (resume)`);
                  continue;
               }
               const sampling = resolveSampling(m, think, benchName, matrix);
               const thinkControl = m.think_control ?? 'enable_thinking';
               const runs = [];
               for (let i = 0; i < SAMPLES; i++) {
                  try {
                     runs.push(await bench.run(client, { model: m, think, sampling, thinkControl }));
                  } catch (e) {
                     console.error(`  ${benchName}/${think_mode} sample ${i}: ${(e.message ?? '').slice(0, 60)}`);
                  }
               }
               if (!runs.length) { continue; }
               const raw = aggregate(runs);
               const dims = {
                  ...common(run_id, subject, serving, platformBase),
                  think_mode,
                  ts: nowTs(),
                  sampling_profile: subject.family ? `${subject.family}/${think_mode}` : null,
               };
               await flush(metricRowsFromResult(raw, dims));
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
            if (!need(BENCHES[benchName].resumeBench ?? benchName, 'n/a')) {
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
               upsertCap: (v) => upsertCap(RESULTS, capKeyFields, { ...v, source_run_id: run_id }),
            };
            let rawRows = [];
            try {
               rawRows = (await BENCHES[benchName].run(probeCtx)) || [];
            } catch (e) {
               console.error(`  ${benchName}: ${(e.message ?? '').slice(0, 70)}`);
            }
            const dims = { ...common(run_id, subject, serving, platformBase), think_mode: 'n/a', ts: nowTs(), sampling_profile: null };
            await flush(rawRows.flatMap((raw) => metricRowsFromResult(raw, dims)));
            console.error(`  ${benchName.padEnd(14)} probe    → ${rawRows.length} rows`);
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
            chat_template: chatTemplate,
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
   for (const r of metricRowsFromResult(raw, dims)) { rows.push(r); }
}

main().catch((e) => {
   console.error(e);
   process.exit(1);
});
