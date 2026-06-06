/**
 * Bench registry — the single source of truth mapping each dashboard metric to the
 * runner/command that produces it. Drives the dashboard's "which run produces this
 * metric" and "required runs / coverage" panels. Pure module (no node imports).
 *
 * IMPORTANT: when a new scorable bench is added, register it here too — the coverage
 * panel can only be honest about what's missing if every metric it scores appears in
 * this map. An unregistered bench is invisible to the "required runs" calculation.
 *
 * `role` ties each metric to its scoring home:
 *   comprehension | coding | coding-gate | speed | context | fleet-memory | fleet-capacity
 * `benches` lists the run.json bench name(s); a trailing '*' marks a depth/concurrency
 * family (e.g. 'e2e-*' covers e2e-4k, e2e-8k, …).
 */

export const BENCH_REGISTRY = {
   // ── comprehension (additive capability group) ──
   triage: {
      label: 'Triage / categorization',
      role: 'comprehension',
      runner: 'run-suite',
      command: 'npm run bench',
      kind: 'suite',
      benches: ['triage'],
   },
   summarization: {
      label: 'Summarization',
      role: 'comprehension',
      runner: 'run-suite',
      command: 'npm run bench',
      kind: 'suite',
      benches: ['summarization'],
   },
   docqa: { label: 'Document QA', role: 'comprehension', runner: 'run-suite', command: 'npm run bench', kind: 'suite', benches: ['docqa'] },
   reasoning: {
      label: 'Reasoning',
      role: 'comprehension',
      runner: 'run-suite',
      command: 'npm run bench',
      kind: 'suite',
      benches: ['reasoning'],
   },

   // ── coding (multiplicative composite) ──
   grade: {
      label: 'Coding grade (MultiPL-E)',
      role: 'coding',
      runner: 'run-suite',
      command: 'npm run bench',
      kind: 'suite',
      benches: ['coding_multipl'],
   },
   agentic_loop: {
      label: 'Agentic tool loop',
      role: 'coding',
      runner: 'agentic-loop',
      command: 'node runners/agentic-loop.mjs',
      kind: 'agentic-loop',
      benches: ['agentic_loop'],
   },
   instruction_following: {
      label: 'Instruction following',
      role: 'coding',
      runner: 'instruction-following',
      command: 'node runners/instruction-following.mjs',
      kind: 'instruction-following',
      benches: ['instruction_following'],
   },
   toolcalling: {
      label: 'Tool-calling (gate)',
      role: 'coding-gate',
      runner: 'run-suite',
      command: 'npm run bench',
      kind: 'suite',
      benches: ['toolcalling'],
   },
   struct_output: {
      label: 'Structured output (gate)',
      role: 'coding-gate',
      runner: 'struct-output',
      command: 'node runners/struct-output.mjs',
      kind: 'struct-output',
      benches: ['struct_output'],
   },

   // ── speed (display group + fleet latency) ──
   e2e_throughput: {
      label: 'E2E throughput',
      role: 'speed',
      runner: 'throughput-ttft',
      command: 'node runners/throughput-ttft.mjs',
      kind: 'throughput-ttft',
      benches: ['e2e-*'],
   },
   cold_ttft: {
      label: 'Cold TTFT',
      role: 'speed',
      runner: 'throughput-ttft',
      command: 'node runners/throughput-ttft.mjs',
      kind: 'throughput-ttft',
      benches: ['ttft-*'],
   },
   warm_ttft: {
      label: 'Warm TTFT (prefix cache)',
      role: 'speed',
      runner: 'prompt-cache',
      command: 'node runners/prompt-cache.mjs',
      kind: 'prompt-cache',
      benches: ['prefix_cache_warm_ms'],
   },
   decode_retention: {
      label: 'Decode retention @depth',
      role: 'speed',
      runner: 'speed-decay',
      command: 'node runners/speed-decay.mjs',
      kind: 'speed-decay',
      benches: ['speed_decay-*'],
   },

   // ── context + fleet inputs ──
   maxctx: {
      label: 'Max usable context',
      role: 'context',
      runner: 'run-suite',
      command: 'npm run bench',
      kind: 'suite',
      benches: ['maxctx'],
   },
   kv_per_tok: {
      label: 'KV bytes / token',
      role: 'fleet-memory',
      runner: 'kv-probe',
      command: 'node runners/kv-probe.mjs',
      kind: 'kvprobe',
      benches: ['kv_per_tok'],
   },
   speed_pargen: {
      label: 'Parallel-gen aggregate tok/s',
      role: 'fleet-capacity',
      runner: 'parallel-gen',
      command: 'node runners/parallel-gen.mjs',
      kind: 'parallel-gen',
      benches: ['speed_pargen-*'],
   },
};

/** Metrics that the fleet score requires per model (besides capability). */
export const FLEET_REQUIRED = ['maxctx', 'kv_per_tok', 'speed_pargen'];

/** Display-only metrics: measured + surfaced in the breakdown/CSV but not scored. */
export const DISPLAY_ONLY = ['quality_decay', 'power_eff', 'speed_prefill', 'total_tok_s', 'judge', 'prefix_cache_speedup'];

/** True if a measured bench name matches a registry `benches` entry (handles '*' families). */
export function benchMatches(pattern, bench) {
   return pattern.endsWith('*') ? String(bench).startsWith(pattern.slice(0, -1)) : pattern === bench;
}

/** Unique runners (with command/kind) needed to produce the given metric ids. */
export function requiredRunnersFor(metricIds) {
   const seen = new Map();
   for (const id of metricIds) {
      const e = BENCH_REGISTRY[id];
      if (e && !seen.has(e.runner)) {
         seen.set(e.runner, { runner: e.runner, command: e.command, kind: e.kind });
      }
   }
   return [...seen.values()];
}
