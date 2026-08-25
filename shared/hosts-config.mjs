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
 * The host may declare an `engine` (`llamacpp` | `ninfer` | `optiq` | `rapidmlx`). llama.cpp hosts leave it
 * unset and behave exactly as before. An MLX host (`optiq`, or the archived `rapidmlx`) serves an
 * MLX model over an OpenAI-compatible HTTP endpoint (`host.mlx`) — no SSH scripts, no VRAM tooling —
 * so the inference URL is taken from `host.mlx` when present and `backend` defaults to the engine
 * name (hosts.yaml sets it explicitly regardless). The returned key names are
 * unchanged (`llamaUrl` still carries the inference URL) so existing llama.cpp call sites are
 * untouched.
 *
 * A `ninfer` host serves ONE pre-converted .ninfer artifact on ONE CUDA device (the engine is
 * single-GPU by design), so a two-card box declares two independent targets that differ only in
 * `device`, `port` and `ninfer` URL. `device` and `artifact_dir` are surfaced as first-class fields
 * because every host-side operation on that engine — container name, lockfile, VRAM readout — has
 * to be scoped to the one card the instance owns, or it reports the peer instance's memory.
 *
 * @param {string} path   path to hosts.yaml
 * @param {string} target host key (e.g. 'rose')
 * @param {{ backend?: string }} [opts] override the recorded inference backend
 * @returns {{ engine, llamaUrl, sshHost, backend, gpu, vramTotalMib, port, vramCmd, device, artifactDir, image, backends, raw }}
 */
export function loadHostConfig(path, target, { backend } = {}) {
   const hosts = yaml.load(readFileSync(path, 'utf8')) ?? {};
   const host = hosts[target];
   if (!host) {
      throw new Error(`Unknown target: ${target}`);
   }
   const engine = host.engine ?? 'llamacpp';
   return {
      engine,
      // MLX hosts (optiq/rapidmlx) carry the inference URL in `mlx`, ninfer hosts in `ninfer`;
      // llama.cpp hosts in `llamacpp`.
      llamaUrl: resolveEnv(host.mlx ?? host.ninfer ?? host.llamacpp),
      sshHost: resolveEnv(host.ssh_host),
      backend: backend ?? host.backend ?? (engine === 'llamacpp' ? 'cuda' : engine),
      gpu: host.gpu ?? target,
      vramTotalMib: host.vram_total_mib ?? null,
      port: host.port ?? null,
      vramCmd: host.vram_cmd ?? null,
      // ninfer only: the CUDA device this instance owns, and where its artifacts live on the host.
      device: host.device ?? null,
      artifactDir: host.artifact_dir ?? null,
      image: host.image ?? null,
      backends: host.backends ?? {},
      raw: host,
   };
}
