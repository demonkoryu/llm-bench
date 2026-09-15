// Free the GPU a bench run is about to measure on — by asking the DRIVER who is holding the card,
// not by guessing a container name.
//
// WHY THIS EXISTS. bench-run used to free the card with a literal `docker stop llama-server`. That
// name was correct for exactly one deployment: the single production container rose ran until
// 2026-08-29, when infra/llm/docker-compose.yml split serving into `qwen38` (device 0) plus `muse`
// and `ling` (device 1). From that day the stop was a silent no-op — it printed "stopped", exited 0,
// and left ~31 GiB of the target card occupied. A run started that way does not fail cleanly: the
// model either OOMs at load, or loads into whatever is left and quietly reports throughput,
// vram_per_ctx_tok and every capacity ceiling measured against a card it was sharing. Those rows are
// indistinguishable from good ones once they are in the store.
//
// The fix is to stop keying on a name at all. `nvidia-smi --query-compute-apps` reports the PIDs
// actually resident on a given device; /proc/<pid>/cgroup maps each back to its container. So the
// question asked here is "what is on device N", which stays true across container renames, the next
// compose split, and a stale harness container left behind by a crashed run.
//
// SCOPE IS PER-DEVICE, and that is load-bearing now that rose declares two llama.cpp targets
// (`rose` = device 0, `rose-gpu1` = device 1) so two models can be measured at once. A global
// "stop the llama servers" would have each run tear down its peer's server mid-bench.
//
// BARE PROCESSES ARE REPORTED, NEVER KILLED. A PID on the card with no container behind it is
// something this module cannot identify — a hand-started llama-server, ollama, someone's training
// script. Killing host processes by inference is not a thing a benchmark harness should do, so the
// caller is told and decides.
import { LOCAL_HOST, runHostCmd } from './host-exec.mjs';

/**
 * Who is holding `device`, as reported by the driver.
 *
 * One shell round-trip: nvidia-smi lists the compute PIDs on that device, and for each we read
 * /proc/<pid>/cgroup (64-hex = the docker container id) and /proc/<pid>/comm. Emits TSV lines
 * `pid<TAB>usedMib<TAB>containerId<TAB>comm`, with an empty container id for a bare process.
 *
 * A PID that exits between the nvidia-smi call and the /proc read simply yields empty fields and is
 * dropped — the card is being freed either way.
 */
export async function gpuOccupants({ device = 0, sshHost, local = LOCAL_HOST, timeout = 30_000 } = {}) {
   // `read` rather than shell parameter expansion on purpose: the ${...} forms that would do this
   // more tersely are indistinguishable from JS template interpolation to biome's
   // noTemplateCurlyInString, and silencing that rule file-wide would also silence it where it is
   // right. This shape has no braces and reads more plainly anyway.
   const script = [
      `nvidia-smi -i ${device} --query-compute-apps=pid,used_memory --format=csv,noheader,nounits |`,
      "tr -d ' ' | while IFS=, read -r pid mib; do",
      '  [ -n "$pid" ] || continue;',
      '  cid=$(grep -oE "[0-9a-f]{64}" /proc/$pid/cgroup 2>/dev/null | head -1);',
      '  comm=$(cat /proc/$pid/comm 2>/dev/null);',
      '  printf "%s\\t%s\\t%s\\t%s\\n" "$pid" "$mib" "$cid" "$comm";',
      'done',
   ].join('\n');
   const r = await runHostCmd(script, { local, sshHost, timeout });
   if (!r.ok) {
      return [];
   }
   const occ = [];
   for (const line of r.stdout.split('\n')) {
      const [pid, mib, containerId, comm] = line.split('\t');
      if (!pid) {
         continue;
      }
      occ.push({
         pid: Number(pid),
         usedMib: Number(mib) || 0,
         containerId: containerId || null,
         comm: comm || null,
         name: null,
      });
   }
   // Resolve container ids to names in one more round-trip, so the log names `qwen38` rather than a
   // 64-char hash. Purely cosmetic — a name that fails to resolve still stops fine by id.
   const ids = [...new Set(occ.map((o) => o.containerId).filter(Boolean))];
   if (ids.length) {
      const n = await runHostCmd(`docker inspect --format '{{.Id}} {{.Name}}' ${ids.join(' ')} 2>/dev/null || true`, {
         local,
         sshHost,
         timeout,
      });
      const byId = new Map();
      for (const line of n.stdout.split('\n')) {
         const [id, name] = line.trim().split(' ');
         if (id) {
            byId.set(id, (name ?? '').replace(/^\//, ''));
         }
      }
      for (const o of occ) {
         o.name = o.containerId ? (byId.get(o.containerId) ?? null) : null;
      }
   }
   return occ;
}

/**
 * Stop every container resident on `device`, so the caller gets the whole card.
 *
 * Returns `{ stopped, bare, freedMib, stillMib }`:
 *   stopped   container names (or ids) this call stopped, in the order stopped. Hand this back to
 *             restartContainers() to put the host back the way it was found.
 *   bare      occupants with no container behind them — reported, never killed. Non-empty means the
 *             card was NOT fully freed and the caller must decide whether to proceed.
 *   freedMib  VRAM held by the containers that were stopped.
 *   stillMib  VRAM still held after the stop, re-read from the driver rather than assumed.
 *
 * `docker stop` (not `rm -f`) is deliberate: a compose-managed container keeps its definition, so
 * restartContainers() is a plain `docker start` of the same container rather than a compose re-up
 * that this harness has no business running.
 */
export async function freeDevice({ device = 0, sshHost, local = LOCAL_HOST, timeout = 120_000 } = {}) {
   const occ = await gpuOccupants({ device, sshHost, local });
   const containers = [...new Set(occ.filter((o) => o.containerId).map((o) => o.name || o.containerId))];
   const bare = occ.filter((o) => !o.containerId);
   const freedMib = occ.filter((o) => o.containerId).reduce((a, o) => a + o.usedMib, 0);
   if (containers.length) {
      await runHostCmd(`docker stop ${containers.join(' ')} 2>/dev/null || true`, { local, sshHost, timeout });
   }
   // Re-read rather than trust the stop: `docker stop` returns when the container is gone, but the
   // driver can take a moment to reclaim, and a container we failed to stop must not look freed.
   const after = await gpuOccupants({ device, sshHost, local });
   return {
      stopped: containers,
      bare,
      freedMib,
      stillMib: after.reduce((a, o) => a + o.usedMib, 0),
   };
}

/** Restart containers stopped by freeDevice(), by name, in the order given. */
export async function restartContainers(names, { sshHost, local = LOCAL_HOST, timeout = 120_000 } = {}) {
   if (!names?.length) {
      return { ok: true, started: [] };
   }
   const r = await runHostCmd(`docker start ${names.join(' ')} 2>&1 || true`, { local, sshHost, timeout });
   return { ok: r.ok, started: names, output: r.stdout };
}

/** One-line human summary of a freeDevice() result, for the run log. */
export function describeFree(device, res) {
   const parts = [];
   parts.push(res.stopped.length ? `stopped [${res.stopped.join(', ')}] (~${res.freedMib} MiB)` : 'nothing to stop');
   if (res.bare.length) {
      const who = res.bare.map((o) => `${o.comm ?? '?'}:${o.pid} (~${o.usedMib} MiB)`).join(', ');
      parts.push(`NOT FREED — non-container process(es) still on the card: ${who}`);
   }
   if (res.stillMib > 0 && !res.bare.length) {
      parts.push(`${res.stillMib} MiB still resident`);
   }
   return `device ${device}: ${parts.join('; ')}`;
}
