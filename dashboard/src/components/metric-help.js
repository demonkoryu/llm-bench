// Collapsible metric glossary. Renders "<name> — <description>" rows for the given metric keys
// using the shared METRIC_HELP map (analysis/query-engine.mjs). Collapsed by default so it stays
// out of the way; used on every view that displays metrics (pareto, pivot, leaderboard).
import { html } from 'npm:htl';

export function metricHelp(help, keys, { title = 'What do these metrics mean?', open = false } = {}) {
   const seen = new Set();
   const rows = keys.filter((k) => help[k] && !seen.has(k) && seen.add(k));
   return html`<details class="metric-help" open=${open}>
    <summary>ℹ ${title}</summary>
    <dl>${rows.map((k) => html`<dt>${k}</dt><dd>${help[k]}</dd>`)}</dl>
  </details>`;
}
