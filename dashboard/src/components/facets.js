// Facet rail as one idiomatic Inputs.form: a multi-select per dimension that HAS values.
// The form's value is { dim: [selected...] } — exactly the `facets` shape query-engine expects
// (an empty array means "no filter on this dim"). Wrap in a <details> so it stays compact.
import * as Inputs from 'npm:@observablehq/inputs';

export function facetForm(facetValues, dims, initial) {
   const inputs = {};
   for (const d of dims) {
      const vals = facetValues[d];
      if (!vals?.length) { continue; }
      inputs[d] = Inputs.select(vals, { multiple: Math.min(vals.length, 5), label: d, value: initial?.[d] });
   }
   const form = Inputs.form(inputs);
   const details = document.createElement('details');
   details.className = 'facet-rail';
   // Auto-open when restoring a non-empty selection, so active filters aren't hidden.
   details.open = Boolean(initial && Object.values(initial).some((a) => a?.length));
   const summary = document.createElement('summary');
   summary.textContent = 'Filters';
   details.append(summary, form);
   // Proxy the form's value/events so `view(facetForm(...))` yields the selection object.
   Object.defineProperty(details, 'value', { get: () => form.value });
   form.addEventListener('input', () => details.dispatchEvent(new CustomEvent('input')));
   return details;
}
