/**
 * backend-ab.mjs — ROCm vs Vulkan A/B for the fleet.
 *
 * Runs llama-bench for each model on BOTH backend binaries with identical
 * params, then prints a per-model pp/tg comparison with % deltas and writes a
 * JSON + Markdown report. This is the experiment that answers "which backend
 * should the suite actually run on?" — we have both builds but have only ever
 * benched Vulkan.
 *
 * Why llama-bench (not the server suite): it loads the GGUF directly, separates
 * prefill (pp) from decode (tg), warms up, and does N reps with stddev — so a
 * backend delta is a clean signal, not server/harness noise. Same params across
 * both backends → the only variable is the binary.
 *
 * Defaults mirror production: -fa 1, -ngl 99, q8_0 KV, AND -b/-ub 2048 (matches
 * start-server.sh + config/models.yaml defaults.extra_flags), a pp sweep (512 + 4096)
 * so the attention/prefill scaling shows, and tg128. The batch sizing is NOT optional:
 * omitting it lets llama-bench fall back to -ub 512, which throttles long-context
 * prefill (rocm worst of all — it faked a ~60% "prefill collapse" at pp4096). Each
 * model's effective batch/ubatch is read from its merged extra_flags so any per-model
 * OOM override (ubatch-size: 1024) is honoured exactly as production would.
 *
 * IMPORTANT: run with NO llama-server running (it loads its own model → VRAM
 * conflict). Stop any server first.
 *
 * Usage:
 *   node runners/backend-ab.mjs                       # all speed-bench models, q8_0 KV
 *   node runners/backend-ab.mjs --models qwen3-30b,gemma4-e4b
 *   node runners/backend-ab.mjs --p 512,4096 --n 128 --reps 3 --kv q8_0
 *   node runners/backend-ab.mjs --host llm2 --out results/backend-ab.json
 *   node runners/backend-ab.mjs --vulkan-bin <path> --rocm-bin <path>
 */

import { execFile } from 'node:child_process';
import { writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import { loadModelsConfig } from '../shared/models-config.mjs';

const exec = promisify(execFile);
const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');

// ── CLI ─────────────────────────────────────────────────────────────────────
function arg(name, def) {
   const i = process.argv.indexOf(`--${name}`);
   return i >= 0 && process.argv[i + 1] ? process.argv[i + 1] : def;
}
const HOST = arg('host', process.env.SSH_HOST || 'llm2');
const REPS = Number(arg('reps', '3'));
const PP = arg('p', '512,4096'); // comma list → one llama-bench row each
const TG = arg('n', '128');
const KV = arg('kv', 'q8_0'); // ctk=ctv=KV; matches production server
// Production batch sizing (config/models.yaml defaults.extra_flags). Used as the
// fallback when a model declares no explicit batch-size/ubatch-size of its own.
const BATCH = Number(arg('batch', '2048'));
const UBATCH = Number(arg('ubatch', '2048'));
const OUT = arg('out', join(ROOT, 'results', 'backend-ab.json'));
const MODEL_FILTER = (arg('models', '') || '')
   .split(',')
   .map((s) => s.trim().toLowerCase())
   .filter(Boolean);
// Server bins from hosts.yaml → swap llama-server → llama-bench. Overridable.
const VULKAN_BIN = arg('vulkan-bin', '~/llama.cpp/build-vulkan/bin/llama-bench');
const ROCM_BIN = arg('rocm-bin', '~/llama.cpp/build-rocm/bin/llama-bench');

// vulkan runs with int-dot DISABLED — that's the production config (it measured
// net-negative for decode on this host; see results/int-dot-impact.md). Override by
// setting LLAMA_VK_INT_DOT=1 in this process's env to A/B with int-dot on instead.
const VK_ENV = process.env.LLAMA_VK_INT_DOT === '1' ? '' : 'env GGML_VK_DISABLE_INTEGER_DOT_PRODUCT=1 ';
const BACKENDS = [
   { name: 'vulkan', bin: VULKAN_BIN, env: VK_ENV },
   { name: 'rocm', bin: ROCM_BIN, env: '' },
];

// ── ssh helpers (mirrors llama-bench.mjs) ─────────────────────────────────────
async function ssh(cmd, timeout = 30_000) {
   const { stdout } = await exec('ssh', ['-o', 'BatchMode=yes', '-o', 'ConnectTimeout=10', HOST, cmd], { timeout });
   return stdout.trim();
}

async function remoteFileExists(path) {
   try {
      const out = await ssh(`test -f ${path} && echo yes || echo no`, 10_000);
      return out === 'yes';
   } catch {
      return false;
   }
}

async function findGguf(hf_file) {
   const out = await ssh(`find ~/.cache/huggingface/hub -name '${hf_file}' 2>/dev/null | head -1`, 15_000);
   if (!out) {
      throw new Error(`GGUF not in HF cache: ${hf_file} — run the server pass once to download it`);
   }
   return out;
}

/**
 * One MEASURED llama-bench invocation → [{ test, n_prompt, n_gen, avg_ts, stddev_ts }].
 *
 * CRITICAL: each llama-bench is a fresh process starting from idle GPU clocks, and the
 * clock ramp outlasts llama-bench's own internal warmup — the first invocation per model
 * reads ~15–19% low. Without a discarded warmup, running vulkan-then-rocm would measure
 * vulkan cold and rocm warm, faking a rocm win. So we fire one throwaway run (same shapes,
 * full -r REPS) to ramp clocks + populate the shader cache, then the real -r REPS run.
 * A single -r 1 warmup proved insufficient for slow-ramping big models (Nemotron, the 30B
 * Qwen MoEs read ~15–45% low); a full -r REPS warmup reaches steady state. See the
 * warmup-confound writeup in results/int-dot-impact.md.
 */
async function bench(bin, ggufPath, env = '', batch = BATCH, ubatch = UBATCH) {
   const base = [
      bin,
      `-m '${ggufPath}'`,
      `-fa 1`,
      `-ngl 99`,
      `-ctk ${KV}`,
      `-ctv ${KV}`,
      `-b ${batch}`,
      `-ub ${ubatch}`,
      `-p ${PP}`,
      `-n ${TG}`,
   ];
   const warmupCmd = `${env}${[...base, `-r ${REPS}`, `-o json`].join(' ')}`;
   const cmd = `${env}${[...base, `-r ${REPS}`, `-o json`].join(' ')}`;
   await ssh(`${warmupCmd} 2>/dev/null`, 600_000); // discard — ramps GPU clocks
   const stdout = await ssh(`${cmd} 2>/dev/null`, 600_000);
   const rows = JSON.parse(stdout);
   const out = {};
   for (const r of rows) {
      if (r.n_gen === 0 && r.n_prompt > 0) {
         out[`pp${r.n_prompt}`] = { avg: r.avg_ts, sd: r.stddev_ts };
      } else if (r.n_prompt === 0 && r.n_gen > 0) {
         out[`tg${r.n_gen}`] = { avg: r.avg_ts, sd: r.stddev_ts };
      }
   }
   return out;
}

// ── main ──────────────────────────────────────────────────────────────────────
async function main() {
   const cfg = loadModelsConfig(join(ROOT, 'config', 'models.yaml'));
   let models = cfg.models.filter((m) => (m.benches ?? []).includes('speed'));
   if (MODEL_FILTER.length) {
      models = models.filter((m) => MODEL_FILTER.some((f) => m.label.toLowerCase().includes(f) || m.hf_file.toLowerCase().includes(f)));
   }
   if (!models.length) {
      console.error('No matching models with a `speed` bench.');
      process.exit(1);
   }

   // Verify both backend binaries exist; drop any that don't.
   const live = [];
   for (const b of BACKENDS) {
      if (await remoteFileExists(b.bin)) {
         live.push(b);
      } else {
         console.error(`! skipping backend '${b.name}' — binary not found: ${b.bin}`);
      }
   }
   if (live.length < 2) {
      console.error('Need both backend binaries present for an A/B. Aborting.');
      process.exit(1);
   }

   const metrics = [
      `pp${PP.split(',')[0]}`,
      ...PP.split(',')
         .slice(1)
         .map((p) => `pp${p}`),
      `tg${TG}`,
   ];
   console.log(`A/B: ${live.map((b) => b.name).join(' vs ')}  | ${models.length} models | KV=${KV} reps=${REPS} p=${PP} n=${TG}`);
   console.log(`Host=${HOST}. Ensure NO llama-server is running (VRAM conflict).\n`);

   const vkIntDot = VK_ENV ? 'off' : 'on';
   const report = {
      host: HOST,
      kv: KV,
      reps: REPS,
      p: PP,
      n: TG,
      batch: BATCH,
      ubatch: UBATCH,
      vulkan_int_dot: vkIntDot,
      backends: live.map((b) => b.name),
      models: [],
   };
   console.log(`(vulkan int-dot: ${vkIntDot}; -b ${BATCH} -ub ${UBATCH} (production); warmup discarded per run)`);

   for (const m of models) {
      process.stdout.write(`• ${m.label} … `);
      let ggufPath;
      try {
         ggufPath = await findGguf(m.hf_file);
      } catch (e) {
         console.log(`SKIP (${e.message})`);
         continue;
      }
      // Mirror production batch sizing: honour any per-model override, else the default.
      const ef = m.extra_flags && typeof m.extra_flags === 'object' ? m.extra_flags : {};
      const batch = Number(ef['batch-size'] ?? BATCH);
      const ubatch = Number(ef['ubatch-size'] ?? UBATCH);
      const entry = { label: m.label, hf_file: m.hf_file, batch, ubatch, byBackend: {} };
      for (const b of live) {
         try {
            entry.byBackend[b.name] = await bench(b.bin, ggufPath, b.env ?? '', batch, ubatch);
         } catch (e) {
            entry.byBackend[b.name] = { error: e.message.slice(0, 120) };
         }
      }
      report.models.push(entry);
      // one-line verdict on tg (the headline decode number)
      const tgKey = `tg${TG}`;
      const v = entry.byBackend.vulkan?.[tgKey]?.avg;
      const r = entry.byBackend.rocm?.[tgKey]?.avg;
      if (v && r) {
         console.log(`tg ${tgKey}: vulkan ${v.toFixed(0)} vs rocm ${r.toFixed(0)} (${pct(r, v)})`);
      } else {
         console.log('done');
      }
   }

   writeFileSync(OUT, JSON.stringify(report, null, 2));
   const md = renderMarkdown(report, metrics);
   const mdPath = OUT.replace(/\.json$/, '.md');
   writeFileSync(mdPath, md);
   console.log(`\nWrote ${OUT}\nWrote ${mdPath}\n`);
   console.log(md);
}

/** signed % change of `a` relative to baseline `b` (e.g. rocm vs vulkan) */
function pct(a, b) {
   if (!a || !b) {
      return 'n/a';
   }
   const d = ((a - b) / b) * 100;
   return `${d >= 0 ? '+' : ''}${d.toFixed(1)}%`;
}

function renderMarkdown(report, metrics) {
   const lines = [];
   lines.push(`# Backend A/B — ${report.backends.join(' vs ')}`);
   lines.push('');
   lines.push(
      `Host \`${report.host}\` · KV \`${report.kv}\` · reps ${report.reps} · p=${report.p} · n=${report.n} · \`-b ${report.batch ?? '?'} -ub ${report.ubatch ?? '?'}\` (production) · vulkan int-dot \`${report.vulkan_int_dot ?? 'on'}\` · warmup discarded. t/s; Δ = rocm vs vulkan.`,
   );
   lines.push('');
   const head = ['Model', ...metrics.flatMap((k) => [`${k} vk`, `${k} rocm`, `${k} Δ`])];
   lines.push(`| ${head.join(' | ')} |`);
   lines.push(
      `| ${head
         .map(() => '---:')
         .join(' | ')
         .replace('---:', ':---')} |`,
   );
   for (const m of report.models) {
      const cells = [m.label];
      for (const k of metrics) {
         const v = m.byBackend.vulkan?.[k]?.avg;
         const r = m.byBackend.rocm?.[k]?.avg;
         cells.push(v ? v.toFixed(0) : '—', r ? r.toFixed(0) : '—', v && r ? pct(r, v) : '—');
      }
      lines.push(`| ${cells.join(' | ')} |`);
   }
   return lines.join('\n');
}

main().catch((e) => {
   console.error(e);
   process.exit(1);
});
