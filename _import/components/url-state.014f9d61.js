// URL-backed input state: each control's selection lives in the page's query string, so it
// survives reload AND makes the current view a shareable/bookmarkable link. Each dashboard page
// is its own URL, so short param keys ('x', 'think', 'f', …) never collide across pages.
//
// Pattern: read the restored value BEFORE building the input (inject it as the Observable input's
// `value:`), then write to the URL on every `input` event. We never write on construction, so
// opening a shared link doesn't rewrite it; and a param is DELETED when its value equals the
// default, keeping shared URLs minimal.
import * as Inputs from "../../_observablehq/stdlib/inputs.8ddbf299.js";
import { facetForm } from "./facets.0481cd58.js";
import { facetsEmpty, resolveInitial, sanitizeFacets, sanitizeWeights, weightsEqual, writeParam } from "./url-params.66eb7c67.js";
import { weightForm } from "./weights.0411b2c4.js";

/**
 * Build an Observable input whose value is mirrored to the URL query param `key`.
 * @param {string} key            query-param name
 * @param {(initial:any)=>Element} make   constructs the input given the resolved initial value
 * @param {object} opts
 * @param {any}       opts.fallback   default value (also: param is dropped when value === it)
 * @param {(v:any)=>boolean} [opts.valid]  reject a restored value (→ fallback) if it fails
 * @param {(s:string)=>any}  [opts.decode] parse the raw param string (default: identity)
 * @param {(v:any)=>string}  [opts.encode] serialize the value for the URL (default: identity)
 * @param {(v:any)=>boolean} [opts.isDefault] treat as default → drop the param (default: === fallback)
 * @returns {Element} pass to Observable's view()
 */
export function linked(key, make, opts = {}) {
   const { fallback, encode = (v) => v, isDefault } = opts;
   const el = make(resolveInitial(key, opts));
   const dflt = isDefault ?? ((v) => v === fallback);
   el.addEventListener('input', () => writeParam(key, dflt(el.value) ? null : encode(el.value)));
   return el;
}

/** URL-backed Inputs.select over a fixed option list. */
export const linkedSelect = (key, options, { value, label }) =>
   linked(key, (v) => Inputs.select(options, { value: v, label }), { fallback: value, valid: (v) => options.includes(v) });

/** URL-backed Inputs.radio over a fixed option list. */
export const linkedRadio = (key, options, { value, label }) =>
   linked(key, (v) => Inputs.radio(options, { value: v, label }), { fallback: value, valid: (v) => options.includes(v) });

/**
 * URL-backed facet rail (key 'f'). Value is { dim: [selected…] }; encoded as JSON. On restore,
 * selections are sanitized against the current data (drop dims/values no longer present) so a
 * stale link can't produce an empty chart from a phantom filter.
 */
export function linkedFacets(fv, dims) {
   return linked('f', (init) => facetForm(fv, dims, init), {
      fallback: {},
      decode: (s) => sanitizeFacets(JSON.parse(s), fv, dims),
      encode: (v) => JSON.stringify(v),
      isDefault: facetsEmpty,
   });
}

/**
 * URL-backed weight panel (key 'w'). Value is { dimKey: weight }; encoded as JSON (only weights > 0).
 * `dims` is the X_DIMS list (each { key, label }); `defaults` is the initial weight map.
 */
export function linkedWeights(dims, defaults) {
   const keys = dims.map((d) => d.key);
   return linked('w', (init) => weightForm(dims, init), {
      fallback: defaults,
      decode: (s) => sanitizeWeights(JSON.parse(s), keys),
      encode: (v) => JSON.stringify(sanitizeWeights(v, keys)),
      isDefault: (v) => weightsEqual(v, defaults),
   });
}
