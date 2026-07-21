// Weight panel for the Compromise page: one 0–5 slider per capability dimension, as a single
// Inputs.form inside a <details> (reuses the .facet-rail styling). Its value is { dimKey: weight };
// a weight of 0 excludes the dimension from the combined x-axis. Mirrors facets.js's form-proxy
// wiring so `view(weightForm(...))` yields the weight object.
import * as Inputs from 'npm:@observablehq/inputs';

export function weightForm(dims, initial) {
   const inputs = {};
   for (const d of dims) {
      inputs[d.key] = Inputs.range([0, 5], { step: 0.5, value: initial?.[d.key] ?? 0, label: d.label });
   }
   const form = Inputs.form(inputs);
   const details = document.createElement('details');
   details.className = 'facet-rail';
   details.open = true; // weights are the page's primary control — show them by default
   const summary = document.createElement('summary');
   summary.textContent = 'Weights (x = capability blend)';
   details.append(summary, form);
   Object.defineProperty(details, 'value', { get: () => form.value });
   form.addEventListener('input', () => details.dispatchEvent(new CustomEvent('input')));
   return details;
}
