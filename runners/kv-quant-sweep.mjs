/**
 * kv-quant-sweep.mjs — KV-cache-quant decode/prefill sweep on the Vulkan backend.
 *
 * Answers two questions the literature leaves open for AMD RDNA3 / RADV (every
 * published quantized-KV number is CUDA/HIP, never Vulkan):
 *   1. How much does decode t/s actually move as KV goes f16 → q8_0 → q4_0, and
 *      does the penalty compound with context depth (the "fine at 4k, slow at 64k"
 *      effect)? Prefill is expected flat.
 *   2. Does an ASYMMETRIC K/V type (q8_0/q4_0) silently de-fuse the flash-attention
 *      kernel on RADV (a documented gfx1100 HIP behaviour) — i.e. does tg collapse
 *      vs the symmetric states? That's the load-bearing reason the production server
 *      runs symmetric q8_0/q8_0.
 *
 * Vulkan only, int-dot OFF (production config). Same warmup-discard protocol as
 * backend-ab.mjs — each llama-bench is a fresh process from idle clocks, so we fire
 * one throwaway -r REPS run to ramp clocks + warm the shader cache before measuring.
 *
 * llama-bench `-d`/--n-depth gives decode-AFTER-a-prefix, so `-d 0,16384` yields
 * tg128 at depth 0 and at depth 16384 in one process — that's the compounding signal.
 *
 * IMPORTANT: run with NO llama-server running (VRAM conflict). Stop any server first.
 *
 * Usage:
 *   node runners/kv-quant-sweep.mjs                          # default models, depths 0,16384
 *   node runners/kv-quant-sweep.mjs --models qwen3-30b-2507,gemma4-12b
 *   node runners/kv-quant-sweep.mjs --depth 0,16384,32768 --reps 2
 *   node runners/kv-quant-sweep.mjs --host llm2 --out results/kv-quant-sweep.json
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
const REPS = Number(arg('reps', '2'));
const PP = arg('p', '512'); // prefill row (confirms KV-invariance of prompt processing)
const TG = arg('n', '128'); // decode row
const DEPTH = arg('depth', '0,16384'); // n_depth list → decode-at-depth, the compounding axis
const OUT = arg('out', join(ROOT, 'results', 'kv-quant-sweep.json'));
// Default set: one big MoE (long-ctx decode + VRAM-relevant), the worst decoder /
// rocm-flip IQ4 model, and a dense mid-size baseline. Override with --models.
const DEFAULT_MODELS = ['qwen3-30b-a3b-instruct-2507-ud-q4_k_xl', 'qwen3.6-35b', 'gemma-4-12b-it-q5_k_m'];
const MODEL_FILTER = (arg('models', DEFAULT_MODELS.join(',')) || '')
   .split(',')
   .map((s) => s.trim().toLowerCase())
   .filter(Boolean);
// Backend select. Default vulkan (production). `--backend rocm` points at the rocm
// build and drops the Vulkan-only int-dot env var — used to test whether the
// "q8_0 KV is slowest at depth" RADV quirk is HIP-specific or disappears on ROCm.
const BACKEND = (arg('backend', 'vulkan') || 'vulkan').toLowerCase();
const DEFAULT_BIN = BACKEND === 'rocm' ? '~/llama.cpp/build-rocm/bin/llama-bench' : '~/llama.cpp/build-vulkan/bin/llama-bench';
const VULKAN_BIN = arg('vulkan-bin', arg('bin', DEFAULT_BIN));

// Production Vulkan config: int-dot disabled (net-negative on this host; see
// results/int-dot-impact.md). Override with LLAMA_VK_INT_DOT=1 to A/B. The env var
// is Vulkan-only, so it's omitted entirely on non-vulkan backends.
const VK_ENV = BACKEND !== 'vulkan' || process.env.LLAMA_VK_INT_DOT === '1' ? '' : 'env GGML_VK_DISABLE_INTEGER_DOT_PRODUCT=1 ';

// KV states. Symmetric f16/q8_0/q4_0 span the precision range; the two asymmetric
// configs probe whether mismatched K/V types de-fuse the FA kernel on RADV (a
// documented CUDA/HIP behaviour). Both directions are tested:
//   q8_0/q4_0 — the QUALITY-recommended asym (K is the sensitive cache, keep it high)
//   q4_0/q8_0 — the inverted config some blogs push; research says it's wrong, and it
//               also lets us check the de-fuse penalty is direction-independent.
const KV_STATES = [
   { label: 'f16', ctk: 'f16', ctv: 'f16' },
   { label: 'q8_0', ctk: 'q8_0', ctv: 'q8_0' }, // production baseline
   { label: 'q4_0', ctk: 'q4_0', ctv: 'q4_0' },
   { label: 'q8_0/q4_0', ctk: 'q8_0', ctv: 'q4_0' }, // asym — K high / V low (quality pick)
   { label: 'q4_0/q8_0', ctk: 'q4_0', ctv: 'q8_0' }, // asym — K low / V high (inverted)
];
const BASELINE = 'q8_0'; // deltas are reported relative to the production config

// ── ssh helpers (mirrors backend-ab.mjs) ──────────────────────────────────────
async function ssh(cmd, timeout = 30_000) {
   const { stdout } = await exec('ssh', ['-o', 'BatchMode=yes', '-o', 'ConnectTimeout=10', HOST, cmd], { timeout });
   return stdout.trim();
}

async function findGguf(hf_file) {
   const out = await ssh(`find ~/.cache/huggingface/hub -name '${hf_file}' 2>/dev/null | head -1`, 15_000);
   if (!out) {
      throw new Error(`GGUF not in HF cache: ${hf_file} — run the server pass once to download it`);
   }
   return out;
}

/**
 * One MEASURED llama-bench invocation for a given KV state →
 *   { 'pp512@d0': {avg,sd}, 'tg128@d0': {...}, 'tg128@d16384': {...}, ... }
 *
 * Warmup discard is mandatory: a fresh llama-bench starts from idle GPU clocks and
 * the ramp outlasts its internal warmup. We fire one throwaway -r REPS run (same
 * shapes) to reach steady state, then the real -r REPS run. See backend-ab.mjs and
 * the warmup-confound writeup in results/int-dot-impact.md.
 */
async function bench(ggufPath, state) {
   const base = [
      VULKAN_BIN,
      `-m '${ggufPath}'`,
      `-fa 1`,
      `-ngl 99`,
      `-ctk ${state.ctk}`,
      `-ctv ${state.ctv}`,
      `-p ${PP}`,
      `-n ${TG}`,
      `-d ${DEPTH}`,
      `-r ${REPS}`,
      `-o json`,
   ];
   const cmd = `${VK_ENV}${base.join(' ')}`;
   await ssh(`${cmd} 2>/dev/null`, 900_000); // discard — ramps clocks + shader cache
   const stdout = await ssh(`${cmd} 2>/dev/null`, 900_000);
   const rows = JSON.parse(stdout);
   const out = {};
   for (const r of rows) {
      const d = r.n_depth ?? 0;
      if (r.n_gen === 0 && r.n_prompt > 0) out[`pp${r.n_prompt}@d${d}`] = { avg: r.avg_ts, sd: r.stddev_ts };
      else if (r.n_prompt === 0 && r.n_gen > 0) out[`tg${r.n_gen}@d${d}`] = { avg: r.avg_ts, sd: r.stddev_ts };
   }
   return out;
}

/** signed % change of `a` vs baseline `b` */
function pct(a, b) {
   if (!a || !b) return 'n/a';
   const d = ((a - b) / b) * 100;
   return `${d >= 0 ? '+' : ''}${d.toFixed(1)}%`;
}

// ── main ──────────────────────────────────────────────────────────────────────
async function main() {
   const cfg = loadModelsConfig(join(ROOT, 'config', 'models.yaml'));
   let models = cfg.models.filter((m) => (m.benches ?? []).includes('speed'));
   models = models.filter((m) => MODEL_FILTER.some((f) => m.label.toLowerCase().includes(f) || m.hf_file.toLowerCase().includes(f)));
   if (!models.length) {
      console.error('No matching models with a `speed` bench.');
      process.exit(1);
   }

   const depths = DEPTH.split(',').map(Number);
   const ppKey = `pp${PP.split(',')[0]}@d0`;
   const tgKeys = depths.map((d) => `tg${TG}@d${d}`);
   const metrics = [ppKey, ...tgKeys];

   const intDotLabel = BACKEND === 'vulkan' ? `, int-dot ${VK_ENV ? 'off' : 'on'}` : '';
   console.log(
      `KV-quant sweep (${BACKEND}${intDotLabel})  | ${models.length} models | states: ${KV_STATES.map((s) => s.label).join(', ')}`,
   );
   console.log(`reps=${REPS} p=${PP} n=${TG} depth=${DEPTH}  Host=${HOST} (ensure NO llama-server running)\n`);

   const report = {
      host: HOST,
      backend: BACKEND,
      vulkan_int_dot: BACKEND === 'vulkan' ? (VK_ENV ? 'off' : 'on') : 'n/a',
      reps: REPS,
      p: PP,
      n: TG,
      depth: DEPTH,
      baseline: BASELINE,
      states: KV_STATES.map((s) => s.label),
      models: [],
   };

   for (const m of models) {
      process.stdout.write(`• ${m.label} … `);
      let ggufPath;
      try {
         ggufPath = await findGguf(m.hf_file);
      } catch (e) {
         console.log(`SKIP (${e.message})`);
         continue;
      }
      const entry = { label: m.label, hf_file: m.hf_file, byState: {} };
      for (const s of KV_STATES) {
         try {
            entry.byState[s.label] = await bench(ggufPath, s);
            process.stdout.write(`${s.label}✓ `);
         } catch (e) {
            entry.byState[s.label] = { error: e.message.slice(0, 140) };
            process.stdout.write(`${s.label}✗ `);
         }
      }
      report.models.push(entry);
      // headline: deepest decode, each state vs the q8_0 production baseline
      const deepTg = tgKeys[tgKeys.length - 1];
      const b = entry.byState[BASELINE]?.[deepTg]?.avg;
      const parts = KV_STATES.map((s) => {
         const v = entry.byState[s.label]?.[deepTg]?.avg;
         return v ? `${s.label} ${v.toFixed(0)}` : `${s.label} —`;
      });
      console.log(`\n    ${deepTg}: ${parts.join(' | ')}${b ? ` (base=${BASELINE})` : ''}`);
   }

   writeFileSync(OUT, JSON.stringify(report, null, 2));
   const md = renderMarkdown(report, metrics);
   const mdPath = OUT.replace(/\.json$/, '.md');
   writeFileSync(mdPath, md);
   console.log(`\nWrote ${OUT}\nWrote ${mdPath}\n`);
   console.log(md);
}

function renderMarkdown(report, metrics) {
   const L = [];
   L.push(`# KV-cache-quant sweep — ${report.backend} / RDNA3`);
   L.push('');
   L.push(
      `Host \`${report.host}\` · backend \`${report.backend}\` · int-dot \`${report.vulkan_int_dot}\` · reps ${report.reps} · p=${report.p} · n=${report.n} · depth=${report.depth} · \`-fa 1 -ngl 99\`. t/s; Δ vs \`${report.baseline}\` (production).`,
   );
   L.push('');
   L.push(
      '> Symmetric f16 / q8_0 / q4_0 span the precision range. `q8_0/q4_0` is the **asymmetric** probe — if its decode collapses vs the symmetric states, the flash-attention kernel de-fused on RADV (the documented CUDA/HIP behaviour).',
   );
   L.push('');
   // One table per model: rows = KV states, cols = metrics + Δ vs baseline on the deepest tg.
   const deepTg = metrics[metrics.length - 1];
   for (const m of report.models) {
      L.push(`## ${m.label}`);
      L.push('');
      const head = ['KV state', ...metrics, `Δ ${deepTg} vs ${report.baseline}`];
      L.push(`| ${head.join(' | ')} |`);
      L.push(`| :--- | ${metrics.map(() => '---:').join(' | ')} | ---: |`);
      const base = m.byState[report.baseline]?.[deepTg]?.avg;
      for (const s of report.states) {
         const st = m.byState[s];
         if (st?.error) {
            L.push(`| ${s} | ${metrics.map(() => `<span title="${st.error}">err</span>`).join(' | ')} | — |`);
            continue;
         }
         const cells = metrics.map((k) => (st?.[k]?.avg ? st[k].avg.toFixed(st[k].avg < 10 ? 1 : 0) : '—'));
         const d = st?.[deepTg]?.avg && base ? pct(st[deepTg].avg, base) : '—';
         L.push(`| ${s === report.baseline ? `**${s}**` : s} | ${cells.join(' | ')} | ${d} |`);
      }
      L.push('');
   }
   return L.join('\n');
}

main().catch((e) => {
   console.error(e);
   process.exit(1);
});
