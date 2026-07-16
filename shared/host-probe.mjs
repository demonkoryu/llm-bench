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

/** Parse `version: 9780 (1191758c5)` (llama-server --version, printed on stderr). */
export function parseLlamacppBuild(versionText) {
   const m = /version:\s*(\d+)\s*\(([0-9a-f]+)\)/i.exec(versionText || '');
   if (m) return `${m[1]} (${m[2]})`;
   const alt = /version:\s*(\S+)/i.exec(versionText || '');
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
   const verOut = binPath ? await hostCmd(`${binPath} --version 2>&1 | head -3`, o) : '';
   const llamacpp_build = parseLlamacppBuild(verOut);
   // Driver is best-effort (nullable in the schema). Try ROCm first, then any Mesa/DRM hint.
   const drvOut = await hostCmd(`rocm-smi --version 2>/dev/null | grep -iE "driver" | head -1`, o);
   const driver = drvOut ? drvOut.replace(/\s+/g, ' ').trim() : null;
   return { llamacpp_build, driver };
}
