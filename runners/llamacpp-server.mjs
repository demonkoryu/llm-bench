/**
 * Manages a remote llama-server process via SSH for the long-context KV sweep.
 * Ported from wisp-vault-mcp-ts/scripts/longctx-kv-run.sh.
 *
 * Responsibilities:
 *   - Start llama-server with specific -c / -ctk / -ctv / -ngl flags
 *   - Wait for /health to be ready
 *   - Snapshot VRAM (rocm-smi) after load
 *   - Kill the server cleanly between runs
 *
 * Usage:
 *   const srv = llamacppServer({ sshHost: 'llm2', llamaUrl: 'http://192.168.1.120:8090' });
 *   const { vramMib } = await srv.start({ modelPath, ctxSize: 65536, ctk: 'q8_0', ctv: 'q4_0', ngl: 99 });
 *   // ... run benches ...
 *   await srv.stop();
 */

import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { openaiCompatClient } from '../shared/openai-compat.mjs';

const exec = promisify(execFile);

async function ssh(host, cmd, opts = {}) {
   const { stdout, stderr } = await exec('ssh', ['-o', 'BatchMode=yes', host, cmd], { timeout: opts.timeout ?? 30_000 });
   return { stdout: stdout.trim(), stderr: stderr.trim() };
}

export function llamacppServer({ sshHost, llamaUrl = 'http://127.0.0.1:8090', llamaBin = '~/llamacpp-vk/llama-server' }) {
   let _pid = null;

   /**
    * Start llama-server on the remote host.
    * @param {object} opts
    *   modelPath  — path to GGUF on remote
    *   ctxSize    — -c value
    *   ctk        — -ctk value (f16|q8_0|q4_0)
    *   ctv        — -ctv value (f16|q8_0|q4_0); if null, same as ctk
    *   ngl        — -ngl (GPU layers); default 99 (all)
    *   port       — server port; default from llamaUrl
    *   faOn       — flash attention (-fa); default true
    * Returns { vramMib } snapshot after model load.
    */
   async function start({ modelPath, ctxSize = 24000, ctk = 'f16', ctv = null, ngl = 99, faOn = true }) {
      const port = new URL(llamaUrl).port || '8090';
      const ctvArg = ctv ?? ctk;
      const faArg = faOn ? '-fa' : '';
      const cmd = `nohup ${llamaBin} -m ${modelPath} -c ${ctxSize} -ngl ${ngl} -ctk ${ctk} -ctv ${ctvArg} ${faArg} --port ${port} > /tmp/llamasrv.log 2>&1 & echo $!`;
      const { stdout } = await ssh(sshHost, cmd, { timeout: 15_000 });
      _pid = stdout.trim();
      console.log(`[llamacpp] started PID=${_pid} ctk=${ctk} ctv=${ctvArg} ctx=${ctxSize}`);

      // Wait for health
      const url = llamaUrl.replace('127.0.0.1', new URL(llamaUrl).hostname);
      const compat = openaiCompatClient(url);
      await compat.waitHealthy(90_000);

      // Snapshot VRAM
      const vramMib = await snapshotVram();
      return { vramMib };
   }

   async function stop() {
      if (_pid) {
         await ssh(sshHost, `kill ${_pid} 2>/dev/null || true`).catch(() => {});
         await new Promise((r) => setTimeout(r, 2000));
         _pid = null;
         console.log('[llamacpp] server stopped');
      }
   }

   /** Returns VRAM used in MiB via rocm-smi, or null on failure. */
   async function snapshotVram() {
      try {
         const { stdout } = await ssh(sshHost, 'rocm-smi --showmemuse --json', { timeout: 10_000 });
         const parsed = JSON.parse(stdout);
         // rocm-smi JSON: { "card0": { "VRAM Total Used Memory (B)": "..." }, ... }
         const card = Object.values(parsed)[0] ?? {};
         const bytes = parseInt(card['VRAM Total Used Memory (B)'] ?? '0', 10);
         return Math.round(bytes / (1024 * 1024));
      } catch {
         return null;
      }
   }

   return { start, stop, snapshotVram };
}
