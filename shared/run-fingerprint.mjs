/**
 * Readable server fingerprint — the "config marker" stamped on every run.
 *
 * Instead of an opaque hash, each run records a plain, human-readable `environment`
 * object describing the SERVER-DEPENDENT configuration that makes two runs
 * comparable (or not): the runner, GPU, backend, the KV-cache quant, flash-attention,
 * ngl/np, the merged batch/ubatch defaults, and the verbatim launch line parsed from
 * start-server.sh. Per-model WEIGHT quant is deliberately NOT here — a run spans many
 * models/quants, so quant belongs to each model's identity (the GGUF filename), not to
 * the run-comparison marker.
 *
 * This is config-FILE derived (no live server probe): it intentionally does NOT
 * capture the llama.cpp build commit or GPU driver version, so a silent llama.cpp
 * upgrade on the host won't change it. The marker labels a run for comparability; it
 * is not a reproducibility guarantee (GPU kernels aren't bit-exact, sampling uses
 * temp>0). Consumers say so rather than implying otherwise.
 *
 * Pure module — no node:fs. The caller reads start-server.sh and passes its text in.
 */

/**
 * Resolve a token that may be a shell variable reference ("$ngl") to its literal
 * default by looking up a `name=value` assignment in the script text. Returns the
 * token unchanged if it's already literal or no assignment is found.
 */
function resolveShellVar(token, scriptText) {
   if (!token?.startsWith('$')) {
      return token;
   }
   const name = token.replace(/^\$\{?/, '').replace(/\}$/, '');
   const m = new RegExp(`^\\s*${name}=(\\S+)`, 'm').exec(scriptText ?? '');
   return m ? m[1] : token;
}

/**
 * Parse the human-relevant llama-server launch flags out of start-server.sh text.
 * Greps the known flags (-fa, --cache-type-k/v, -ngl, -np); resolves shell-variable
 * values (e.g. `-ngl $ngl` → 99) from the script's own assignments. Missing flags
 * come back null so a future edit that removes one is visible as a change.
 */
export function parseServerFlags(startServerShText) {
   const full = String(startServerShText ?? '');
   // Parse flags from the launch command itself (not the whole file) so usage-comment
   // lines like `[--ngl <N>]` can't be mistaken for the real flag. Variable values
   // (e.g. `-ngl $ngl`) still resolve against the full script's assignments.
   const text = extractLaunchExcerpt(full) ?? full;
   const grab = (re) => {
      const m = re.exec(text);
      return m ? resolveShellVar(m[1], full) : null;
   };
   return {
      flash_attn: grab(/-fa\s+(\S+)/),
      cache_type_k: grab(/--cache-type-k\s+(\S+)/),
      cache_type_v: grab(/--cache-type-v\s+(\S+)/),
      ngl: numericOrRaw(grab(/-ngl\s+(\S+)/)),
      np: numericOrRaw(grab(/-np\s+(\S+)/)),
   };
}

function numericOrRaw(v) {
   if (v == null) {
      return null;
   }
   const n = Number(v);
   return Number.isFinite(n) ? n : v;
}

/**
 * Extract the verbatim llama-server launch line(s) from start-server.sh (the
 * `cmd="nohup ... "` block), whitespace-normalized, so the marker carries the exact
 * command shape without depending on our flag parser staying exhaustive.
 */
export function extractLaunchExcerpt(startServerShText) {
   const text = String(startServerShText ?? '');
   const m = /cmd="([\s\S]*?)"\s*$/m.exec(text);
   const raw = m ? m[1] : '';
   return (
      raw
         .replace(/\\\s*\n/g, ' ')
         .replace(/\s+/g, ' ')
         .trim() || null
   );
}

/**
 * Build the readable server `environment` object for a run.
 *
 * @param {object} opts
 *   gpu                {string}  GPU label from hosts.yaml
 *   backend            {string}  'vulkan' | 'rocm'
 *   startServerShText  {string}  contents of scripts/llm2/start-server.sh
 *   defaultsExtraFlags {object?} models.yaml defaults.extra_flags (batch/ubatch)
 *   runner             {string?} runtime identity (default 'llama.cpp')
 */
export function buildEnvironment({ gpu, backend, startServerShText, defaultsExtraFlags, runner = 'llama.cpp' }) {
   return {
      runner,
      backend: backend ?? null,
      gpu: gpu ?? null,
      server_flags: parseServerFlags(startServerShText),
      defaults_extra_flags: defaultsExtraFlags ?? null,
      start_server_excerpt: extractLaunchExcerpt(startServerShText),
   };
}

/** Stable key-sorted JSON for structural comparison of two environments. */
function canonical(value) {
   if (value === null || typeof value !== 'object') {
      return JSON.stringify(value ?? null);
   }
   if (Array.isArray(value)) {
      return `[${value.map(canonical).join(',')}]`;
   }
   return `{${Object.keys(value)
      .sort()
      .map((k) => `${JSON.stringify(k)}:${canonical(value[k])}`)
      .join(',')}}`;
}

/**
 * Human-readable diff between two environments. Returns [] when they match. Compares
 * the comparison-relevant fields (runner, gpu, backend, server_flags, defaults); the
 * launch excerpt is informational and not diffed line-by-line (the parsed flags carry
 * the meaningful deltas).
 */
export function environmentDiff(a, b) {
   const out = [];
   if (!a || !b) {
      return a || b ? ['one run has no environment (pre-fingerprint run)'] : [];
   }
   for (const k of ['runner', 'gpu', 'backend']) {
      if ((a[k] ?? null) !== (b[k] ?? null)) {
         out.push(`${k}: ${a[k] ?? '?'} → ${b[k] ?? '?'}`);
      }
   }
   const fa = a.server_flags ?? {};
   const fb = b.server_flags ?? {};
   for (const k of new Set([...Object.keys(fa), ...Object.keys(fb)])) {
      if ((fa[k] ?? null) !== (fb[k] ?? null)) {
         out.push(`server_flags.${k}: ${fa[k] ?? '?'} → ${fb[k] ?? '?'}`);
      }
   }
   if (canonical(a.defaults_extra_flags ?? null) !== canonical(b.defaults_extra_flags ?? null)) {
      out.push('defaults_extra_flags changed');
   }
   return out;
}

/** True when every environment in the list is mutually consistent (or list ≤ 1). */
export function environmentsConsistent(envs) {
   const present = envs.filter(Boolean);
   for (let i = 1; i < present.length; i++) {
      if (environmentDiff(present[0], present[i]).length) {
         return false;
      }
   }
   return true;
}
