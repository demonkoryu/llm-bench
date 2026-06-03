/**
 * llama-bench runner — measures pp (prefill) and tg (decode) throughput.
 *
 * Replaces the homegrown runSpeed() HTTP shot with llama-bench's rigorous
 * multi-rep measurement:
 *   - Loads GGUF directly (no HTTP server, no harness-layer interference)
 *   - Separates prefill (pp) from decode (tg) t/s
 *   - Warmup built-in, 5 reps with stddev
 *   - Same params across all models → fairness
 *
 * llama-bench params chosen to match our server configuration:
 *   -fa 1          flash attention (same as --flash-attn on)
 *   -ngl 99        all layers on GPU
 *   -p 512         prompt tokens (prefill workload)
 *   -n 128         generated tokens (decode workload)
 *   -r 5           5 repetitions → stddev meaningful
 *
 * KV configs: one invocation per pair (f16/f16, q8_0/q8_0, q4_0/q4_0, q8_0/q4_0)
 * to match the 4 KV sweep from the server harness.
 *
 * GGUF resolution: find the file in the HF hub cache by filename. Models are
 * downloaded by the server harness on first use; llama-bench reuses those files.
 */

import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

const exec = promisify(execFile);

const DEFAULT_BIN   = '~/llama.cpp/build-rocm/bin/llama-bench';
const DEFAULT_REPS  = 5;
const PP_TOKENS     = 512;
const TG_TOKENS     = 128;

const KV_PAIRS = [
   { kv: 'f16',  ctk: 'f16',   ctv: 'f16'   },
   { kv: 'q8_0', ctk: 'q8_0',  ctv: 'q8_0'  },
   { kv: 'q4_0', ctk: 'q4_0',  ctv: 'q4_0'  },
   { kv: 'k8v4', ctk: 'q8_0',  ctv: 'q4_0'  },
];

async function ssh(host, cmd, opts = {}) {
   const { stdout, stderr } = await exec(
      'ssh', ['-o', 'BatchMode=yes', '-o', 'ConnectTimeout=10', host, cmd],
      { timeout: opts.timeout ?? 30_000 }
   );
   return { stdout: stdout.trim(), stderr: stderr.trim() };
}

/** Locate a GGUF file in the HF hub cache on the remote host. */
async function findGguf(sshHost, hf_file) {
   const { stdout } = await ssh(
      sshHost,
      `find ~/.cache/huggingface/hub -name '${hf_file}' 2>/dev/null | head -1`,
      { timeout: 15_000 }
   );
   if (!stdout) throw new Error(`GGUF not found in HF cache: ${hf_file} — run the server pass first to download it`);
   return stdout;
}

/**
 * Run llama-bench for one model across all 4 KV configs.
 *
 * Returns an array of rows ready for TSV:
 * [{ kv, bench: 'speed_pp'|'speed_tg', avg_ts, stddev_ts }, ...]
 */
export async function runLlamaBench({ sshHost, hf_file, llamaBin = DEFAULT_BIN, reps = DEFAULT_REPS }) {
   const ggufPath = await findGguf(sshHost, hf_file);
   const results  = [];

   for (const { kv, ctk, ctv } of KV_PAIRS) {
      console.log(`  [llama-bench] ${hf_file}  KV=${kv}  pp=${PP_TOKENS} tg=${TG_TOKENS} reps=${reps}`);

      const cmd = [
         llamaBin,
         `-m '${ggufPath}'`,
         `-fa 1`,
         `-ngl 99`,
         `-ctk ${ctk}`,
         `-ctv ${ctv}`,
         `-p ${PP_TOKENS}`,
         `-n ${TG_TOKENS}`,
         `-r ${reps}`,
         `-o json`,
      ].join(' ');

      let rows;
      try {
         const { stdout } = await ssh(sshHost, `${cmd} 2>/dev/null`, { timeout: 300_000 });
         rows = JSON.parse(stdout);
      } catch (e) {
         console.error(`  [llama-bench] failed KV=${kv}: ${e.message.slice(0, 80)}`);
         continue;
      }

      for (const row of rows) {
         const isPp = row.n_prompt > 0 && row.n_gen === 0;
         const isTg = row.n_gen > 0   && row.n_prompt === 0;
         if (!isPp && !isTg) continue;
         results.push({
            kv,
            bench:    isPp ? 'speed_pp' : 'speed_tg',
            avg_ts:   row.avg_ts,
            stddev_ts: row.stddev_ts,
            samples:  row.samples_ts ?? [],
         });
         const label = isPp ? `pp` : `tg`;
         console.log(`    ${label}=${row.avg_ts.toFixed(1)} ± ${row.stddev_ts.toFixed(1)} t/s`);
      }
   }

   return results;
}
