/**
 * Central loader for config/hosts.yaml — the host-side sibling of models-config.mjs.
 *
 * The single reason this exists instead of a bare `yaml.load()` at each call site:
 * every runner needs the same thing — resolve one target, expand `${VAR:-default}`
 * env references, and hand back LLAMA_URL / SSH_HOST / BACKEND. That env-interpolation
 * regex was previously copy-pasted (verbatim, sometimes as `resolve`) into six
 * runners; a fix to it had to be made in six places. It lives here once now.
 *
 * Env overrides (per config/hosts.yaml): LLAMA_URL, SSH_HOST, BACKEND.
 */

import { readFileSync } from 'node:fs';
import yaml from 'js-yaml';

/** Expand `${VAR}` / `${VAR:-default}` references against process.env. */
export function resolveEnv(s) {
   return String(s ?? '').replace(/\$\{([^}]+)\}/g, (_, e) => {
      const [v, d] = e.split(':-');
      return process.env[v] ?? d ?? '';
   });
}

/**
 * Load config/hosts.yaml and resolve one target into a flat, env-interpolated
 * descriptor. Throws on an unknown target (the inline call sites would otherwise
 * crash on the first `host.llamacpp` access anyway).
 *
 * @param {string} path   path to hosts.yaml
 * @param {string} target host key (e.g. 'rose')
 * @param {{ backend?: string }} [opts] inference backend (default 'vulkan')
 * @returns {{ llamaUrl, sshHost, backend, gpu, vramTotalMib, port, vramCmd, backends, raw }}
 */
export function loadHostConfig(path, target, { backend = 'vulkan' } = {}) {
   const hosts = yaml.load(readFileSync(path, 'utf8')) ?? {};
   const host = hosts[target];
   if (!host) {
      throw new Error(`Unknown target: ${target}`);
   }
   return {
      llamaUrl: resolveEnv(host.llamacpp),
      sshHost: resolveEnv(host.ssh_host),
      backend,
      gpu: host.gpu ?? target,
      vramTotalMib: host.vram_total_mib ?? null,
      port: host.port ?? null,
      vramCmd: host.vram_cmd ?? null,
      backends: host.backends ?? {},
      raw: host,
   };
}
