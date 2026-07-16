// Host command execution — the single switch between "drive the test host over SSH"
// (default: Node runs on the dev PC) and "run right here" (local mode: Node runs ON
// the test host, e.g. the rose-native pipeline). Every machine-level operation (the
// llm2 shell scripts, router systemctl, the build/version probe) goes through here so
// the local/remote choice lives in exactly one place.
//
// Local mode is selected explicitly (opts.local) or via env BENCH_LOCAL=1.
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

const execP = promisify(execFile);

/** True when this process should run host commands locally instead of over SSH. */
export const LOCAL_HOST = process.env.BENCH_LOCAL === '1';

/**
 * Run a shell command on the test host. Locally (`local`) it's `bash -c <cmd>`;
 * otherwise `ssh <sshHost> <cmd>`. Returns { stdout, stderr, ok, exitCode }.
 * Tilde paths in `cmd` expand the same way under both (login-ish bash / ssh shell).
 */
export async function runHostCmd(cmd, { local = LOCAL_HOST, sshHost, timeout = 30_000 } = {}) {
   const file = local ? 'bash' : 'ssh';
   const args = local ? ['-c', cmd] : ['-o', 'BatchMode=yes', '-o', 'ConnectTimeout=30', sshHost, cmd];
   try {
      const { stdout, stderr } = await execP(file, args, { timeout, maxBuffer: 16 * 1024 * 1024 });
      return { stdout: stdout.trim(), stderr: stderr.trim(), ok: true };
   } catch (e) {
      return { stdout: (e.stdout ?? '').trim?.() ?? '', stderr: e.stderr ?? e.message, ok: false, exitCode: e.code };
   }
}
