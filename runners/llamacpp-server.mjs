/**
 * Manages a remote llama-server process via SSH.
 *
 * Models are identified by { hf_repo, hf_file } — passed directly to
 * llama-server via --hf-repo / --hf-file.  llama.cpp downloads on first use
 * and caches in ~/.cache/llama.cpp/ on the remote host.
 *
 * Features:
 *   - HF model download + caching (no Ollama required)
 *   - Auto context-size probe: tries ctxSizes descending, returns largest that loads
 *   - Asymmetric KV cache (-ctk / -ctv) for k8v4 config
 *   - Flash attention enabled by default
 *   - VRAM snapshot via rocm-smi after load
 */

import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { openaiCompatClient } from '../shared/openai-compat.mjs';

const exec = promisify(execFile);

async function ssh(host, cmd, opts = {}) {
   const { stdout, stderr } = await exec(
      'ssh', ['-o', 'BatchMode=yes', '-o', 'ConnectTimeout=10', host, cmd],
      { timeout: opts.timeout ?? 30_000 }
   );
   return { stdout: stdout.trim(), stderr: stderr.trim() };
}

// ROCm build: DeltaNet GPU-accelerated, -ctk/-ctv supported, June 2026
const DEFAULT_BIN = '~/llama.cpp/build-rocm/bin/llama-server';

export function llamacppServer({ sshHost, llamaUrl = 'http://192.168.1.120:8090', llamaBin = DEFAULT_BIN }) {
   let _pid = null;
   const port = new URL(llamaUrl).port || '8090';
   const client = openaiCompatClient(llamaUrl);

   /**
    * Start llama-server for a model identified by HuggingFace repo + file.
    * Probes context sizes in descending order until one loads successfully.
    *
    * @param {object} opts
    *   hf_repo    {string}   HuggingFace repo (e.g. "unsloth/Qwen3.5-4B-GGUF")
    *   hf_file    {string}   GGUF filename    (e.g. "Qwen3.5-4B-Q4_K_M.gguf")
    *   ctk        {string}   KV cache type for K (f16|q8_0|q4_0)
    *   ctv        {string}   KV cache type for V; defaults to ctk
    *   ngl        {number}   GPU layers (default 99 = all)
    *   ctxSizes   {Array}    descending list to probe (default [65536,32768,16384,8192])
    *
    * Returns { vramMib, ctxLoaded } where ctxLoaded is the largest ctx that fit.
    */
   async function start({ hf_repo, hf_file, ctk = 'f16', ctv = null, ngl = 99, ctxSizes = [65536, 32768, 16384, 8192] }) {
      const ctvArg = ctv ?? ctk;
      // Clear any orphaned server on this port before starting a new one.
      await stop();

      for (const ctx of ctxSizes) {
         const cmd = [
            `nohup ${llamaBin}`,
            `--hf-repo '${hf_repo}'`,
            `--hf-file '${hf_file}'`,
            `-c ${ctx}`,
            `-ngl ${ngl}`,
            `-ctk ${ctk}`,
            `-ctv ${ctvArg}`,
            `--flash-attn on`,
            `--parallel 1`,
            `--no-cache-prompt`,
            `--host 0.0.0.0`,
            `--port ${port}`,
            `> /tmp/llamasrv.log 2>&1 & echo $!`,
         ].join(' ');

         const { stdout } = await ssh(sshHost, cmd, { timeout: 15_000 });
         _pid = stdout.trim();
         console.log(`[llamacpp] starting PID=${_pid} ${hf_file} ctx=${ctx} ctk=${ctk} ctv=${ctvArg}`);

         // Wait up to 300s for health — model download from HF happens on first run
         const loaded = await client.waitHealthy(300_000).then(() => true).catch(() => false);

         if (loaded) {
            const vramMib = await snapshotVram();
            console.log(`[llamacpp] ready  ctx=${ctx}  vram=${vramMib ?? '?'}MiB`);
            return { vramMib, ctxLoaded: ctx };
         }

         console.log(`[llamacpp] ctx=${ctx} failed (OOM?), trying smaller`);
         await stop();
      }

      throw new Error(`${hf_file}: failed to load at any ctx size`);
   }

   async function stop() {
      // 1. Kill tracked PID.
      if (_pid) {
         await ssh(sshHost, `kill ${_pid} 2>/dev/null; sleep 1; kill -9 ${_pid} 2>/dev/null || true`).catch(() => {});
         _pid = null;
      }
      // 2. Kill anything still holding the port.
      await ssh(sshHost, `fuser -k ${port}/tcp 2>/dev/null || true`).catch(() => {});
      // 3. Kill all llama-server processes — catches orphans from previous runs or crashes.
      await ssh(sshHost, `pkill -9 -f llama-server 2>/dev/null || true`).catch(() => {});
      await new Promise((r) => setTimeout(r, 5000));
   }

   /** rocm-smi VRAM used in MiB. */
   async function snapshotVram() {
      try {
         const { stdout } = await ssh(sshHost, 'rocm-smi --showmeminfo vram --json', { timeout: 10_000 });
         const card = Object.values(JSON.parse(stdout))[0] ?? {};
         const bytes = parseInt(card['VRAM Total Used Memory (B)'] ?? '0', 10);
         return Math.round(bytes / (1024 * 1024));
      } catch { return null; }
   }

   return { start, stop, snapshotVram, client };
}
