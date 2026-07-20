# Pivot

A metric across two dimensions as a heatmap. Set a **Δ baseline** column to colour by delta vs that column.

```js
import * as Plot from "npm:@observablehq/plot";
import * as Inputs from "npm:@observablehq/inputs";
import { pivot, meta, facets as facetValues, METRIC_HELP } from "./lib/query-engine.js";
import { facetForm } from "./components/facets.js";
import { metricHelp } from "./components/metric-help.js";

const rows = await FileAttachment("data/measurements.json").json();
const fv = facetValues(rows);
const m = meta();
```

```js
const rowsDim = view(Inputs.select(m.pivotDims, { value: "gguf_file", label: "rows" }));
const colsDim = view(Inputs.select(m.pivotDims, { value: "chat_template", label: "columns" }));
const metric = view(Inputs.select(m.metrics, { value: "reasoning %", label: "metric" }));
const facetsSel = view(facetForm(fv, m.dims));
```

```js
const colVals = ["(none)", ...new Set(rows.map((r) => r[colsDim]).filter((v) => v != null))].sort();
const baseline = view(Inputs.select(colVals, { value: "(none)", label: "Δ baseline" }));
```

```js
display(metricHelp(METRIC_HELP, [metric], { title: "current metric" }));
```

```js
const pv = pivot(rows, { rowsDim, colsDim, metric, baseline: baseline === "(none)" ? null : baseline, facets: facetsSel });
const clean = (s) => String(s).replace(".gguf", "");
const long = pv.cells.flatMap((row) => row.vals.map((cell) => ({ r: clean(row.r), c: String(cell.c), v: cell.v, delta: cell.delta })));
const hasDelta = baseline !== "(none)";
```

```js
if (long.length === 0) {
  display(html`<div class="muted">No data in this selection.</div>`);
} else {
  // Cap cell size on desktop, but never shrink below a readable min — scroll on mobile.
  const ideal = 220 + pv.cols.length * 120;
  const minW = 220 + pv.cols.length * 60;
  display(html`<div class="scroll-x">${Plot.plot({
    marginLeft: 220,
    marginBottom: 90,
    width: Math.max(minW, Math.min(width, ideal)),
    x: { label: colsDim, domain: pv.cols.map(String), tickRotate: -40 },
    y: { label: rowsDim, domain: pv.rows.map(clean) },
    color: hasDelta
      ? { legend: true, scheme: pv.lower ? "PiYG" : "PiYG", pivot: 0, reverse: pv.lower, label: `Δ ${metric}` }
      : { legend: true, scheme: pv.lower ? "YlOrRd" : "YlGnBu", label: metric },
    marks: [
      Plot.cell(long, { x: "c", y: "r", fill: hasDelta ? "delta" : "v", inset: 0.5 }),
      // black text with a white halo stays legible over any cell colour, light or dark.
      Plot.text(long, { x: "c", y: "r", text: (d) => (d.v == null ? "" : d.v.toFixed(1)), fill: "black", stroke: "white", strokeWidth: 2, paintOrder: "stroke", fontSize: 10 }),
    ],
  })}</div>`);
}
```
