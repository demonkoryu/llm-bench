/**
 * Manage OLLAMA_KV_CACHE_TYPE on a remote host via SSH systemd drop-in.
 * Ported from wisp-vault-mcp-ts/scripts/overnight.sh.
 *
 * Requires: SSH key auth to the target host; sudo rights for systemctl.
 *
 * Usage (module):
 *   const kv = ollamaKvManager({ sshHost: 'llm2', service: 'ollama' });
 *   await kv.setKvType('q8_0');   // restarts service
 *   await kv.setKvType('f16');
 *   await kv.restore();            // remove drop-in, restart with defaults
 */

import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

const exec = promisify(execFile);

async function ssh(host, cmd) {
   const { stdout, stderr } = await exec('ssh', ['-o', 'BatchMode=yes', host, cmd], { timeout: 30_000 });
   return { stdout: stdout.trim(), stderr: stderr.trim() };
}

export function ollamaKvManager({ sshHost, service = 'ollama', ollamaHost }) {
   const DROP_IN_DIR = `/etc/systemd/system/${service}.service.d`;
   const DROP_IN_PATH = `${DROP_IN_DIR}/kv.conf`;

   async function setKvType(kvType) {
      const faOn = kvType !== 'f16';
      const conf = [
         '[Service]',
         `Environment="OLLAMA_KV_CACHE_TYPE=${kvType}"`,
         `Environment="OLLAMA_FLASH_ATTENTION=${faOn ? 1 : 0}"`,
      ].join('\\n');

      const cmd = [
         `sudo mkdir -p ${DROP_IN_DIR}`,
         `printf '${conf}' | sudo tee ${DROP_IN_PATH} > /dev/null`,
         'sudo systemctl daemon-reload',
         `sudo systemctl restart ${service}`,
         'sleep 3',
      ].join(' && ');

      await ssh(sshHost, cmd);
      await waitOllamaReady();
      console.log(`[ollama-kv] KV_CACHE_TYPE=${kvType} FA=${faOn ? 1 : 0} — service restarted`);
   }

   async function restore() {
      const cmd = [
         `sudo rm -f ${DROP_IN_PATH}`,
         'sudo systemctl daemon-reload',
         `sudo systemctl restart ${service}`,
         'sleep 3',
      ].join(' && ');
      await ssh(sshHost, cmd);
      await waitOllamaReady();
      console.log('[ollama-kv] KV drop-in removed, default config restored');
   }

   async function waitOllamaReady(timeoutMs = 30_000) {
      const host = ollamaHost ?? 'http://localhost:11434';
      const deadline = Date.now() + timeoutMs;
      while (Date.now() < deadline) {
         try {
            const res = await fetch(`${host}/api/tags`, { signal: AbortSignal.timeout(3000) });
            if (res.ok) return;
         } catch {}
         await new Promise((r) => setTimeout(r, 1500));
      }
      throw new Error(`Ollama not ready within ${timeoutMs}ms`);
   }

   return { setKvType, restore };
}
