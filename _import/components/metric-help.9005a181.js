// Always-visible metric glossary: a compact "<name> — <description>" list for the given metric
// keys (from the shared METRIC_HELP map in analysis/query-engine.mjs). Placed right under a view's
// controls so the meaning of what's on screen is visible without scrolling or clicking.
import { html } from "../../_npm/htl@1.0.0/11521f02.js";

export function metricHelp(help, keys, { title = 'metrics' } = {}) {
   const seen = new Set();
   const rows = keys.filter((k) => help[k] && !seen.has(k) && seen.add(k));
   if (!rows.length) { return html``; }
   return html`<div class="metric-help">
    <span class="metric-help-title">${title}</span>
    <dl>${rows.map((k) => html`<dt>${k}</dt><dd>${help[k]}</dd>`)}</dl>
  </div>`;
}
