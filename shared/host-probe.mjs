// Host build/platform probe — captures the facts that must key the capabilities
// cache and tag every measurement's `platform` dims: the llama.cpp build (so a
// silent upgrade invalidates cached ceilings) and, best-effort, the GPU driver.
//
// This is execution-layer infra (SSH to the test host), reused by the capabilities
// cache (analysis/caps-cache.mjs) and the orchestrator (runners/bench-run.mjs).
import { LOCAL_HOST, runHostCmd } from './host-exec.mjs';

async function hostCmd(cmd, opts) {
   const r = await runHostCmd(cmd, { timeout: 15_000, ...opts });
   return r.ok ? r.stdout : '';
}

/**
 * Parse the build id out of `llama-server --version` (printed on stderr).
 *
 * Two shapes are in the wild:
 *   upstream:  `version: 9780 (1191758c5)`                    → "9780 (1191758c5)"
 *   forks:     `version: 0.2.0-dev (build 1, commit f280b26)` → "0.2.0-dev (f280b26)"
 * The second shape is what the CUDA image on rose prints; the old numeric-only regex fell
 * through to the bare-token fallback and dropped the commit, so every V100 row recorded a
 * build with no way to tell two forks apart.
 */
export function parseLlamacppBuild(versionText) {
   const text = versionText || '';
   const m = /version:\s*(\d+)\s*\(([0-9a-f]+)\)/i.exec(text);
   if (m) {
      return `${m[1]} (${m[2]})`;
   }
   const paren = /version:\s*(\S+)\s*\(([^)]*)\)/i.exec(text);
   if (paren) {
      const commit = /(?:commit\s+)?\b([0-9a-f]{7,40})\b/i.exec(paren[2]);
      return commit ? `${paren[1]} (${commit[1]})` : `${paren[1]} (${paren[2].trim()})`;
   }
   const alt = /version:\s*(\S+)/i.exec(text);
   return alt ? alt[1] : null;
}

/**
 * Probe the test host for build/driver facts.
 * @param {object} o
 *   sshHost {string}  SSH host/alias (or IP)
 *   binPath {string}  llama-server binary path on the host (from hosts.yaml backends[backend].bin)
 * @returns {Promise<{ llamacpp_build: string|null, driver: string|null }>}
 */
export async function probeHostBuild({ sshHost, binPath, local = LOCAL_HOST }) {
   const o = { local, sshHost };
   // --version prints to stderr; redirect so we capture it.
   // For containerized builds, run via docker; for bare-metal binPath, run directly.
   let verOut = '';
   if (binPath && binPath.startsWith('docker:')) {
      const image = binPath.slice('docker:'.length);
      // --gpus all is REQUIRED: without it the container has no libcuda.so.1 and the binary
      // dies before printing its version, which is why llamacpp_build was null on every
      // containerized (CUDA) run.
      verOut = await hostCmd(`docker run --rm --gpus all ${image} --version 2>&1 | head -3`, o);
   } else if (binPath) {
      verOut = await hostCmd(`${binPath} --version 2>&1 | head -3`, o);
   }
   const llamacpp_build = parseLlamacppBuild(verOut);
   // Driver: try nvidia-smi first (NVIDIA), then rocm-smi (AMD), then Mesa/DRM.
   let drvOut = await hostCmd(`nvidia-smi --query-gpu=driver_version --format=csv,noheader 2>/dev/null | head -1`, o);
   if (drvOut) {
      drvOut = `NVIDIA ${drvOut.trim()}`;
   } else {
      drvOut = await hostCmd(`rocm-smi --version 2>/dev/null | grep -iE "driver" | head -1`, o);
   }
   const driver = drvOut ? drvOut.replace(/\s+/g, ' ').trim() : null;
   return { llamacpp_build, driver };
}
