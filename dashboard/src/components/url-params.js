// Pure URL query-string plumbing (no Observable/DOM deps → unit-testable in Node). url-state.js
// wraps these to bind Observable inputs to the URL. All functions read `location`/`history` at
// call time, so they no-op safely wherever those globals are absent (SSR/build).

export const hasUrl = () => typeof location !== 'undefined' && typeof history !== 'undefined';

/** Current value of query param `key`, or null. */
export const readParam = (key) => (hasUrl() ? new URLSearchParams(location.search).get(key) : null);

/**
 * Set (or, when val is null/'', delete) query param `key`, merging into the existing query and
 * preserving the hash. Uses replaceState so per-keystroke changes don't spam browser history.
 */
export function writeParam(key, val) {
   if (!hasUrl()) { return; }
   const p = new URLSearchParams(location.search);
   if (val == null || val === '') { p.delete(key); } else { p.set(key, val); }
   const qs = p.toString();
   history.replaceState(null, '', (qs ? `?${qs}` : location.pathname) + location.hash);
}

/**
 * Resolve the initial value for a param: the decoded+validated stored value, or `fallback` when
 * the param is absent, malformed, or rejected by `valid`.
 */
export function resolveInitial(key, { fallback, valid, decode = (s) => s } = {}) {
   const raw = readParam(key);
   if (raw == null) { return fallback; }
   try {
      const v = decode(raw);
      if (v != null && (!valid || valid(v))) { return v; }
   } catch {
      /* malformed param → fall back */
   }
   return fallback;
}

/** Facet selection { dim: [vals] } keeping only dims/values still present in the current data. */
export function sanitizeFacets(obj, fv, dims) {
   const out = {};
   for (const d of dims) {
      const allowed = fv[d];
      const keep = (obj?.[d] ?? []).filter((v) => allowed?.includes(v));
      if (keep.length) { out[d] = keep; }
   }
   return out;
}

/** A facet selection is "default" (→ no URL param) when every dimension is unselected. */
export const facetsEmpty = (v) => !v || Object.values(v).every((a) => !a?.length);
