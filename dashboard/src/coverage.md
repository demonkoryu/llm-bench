# Coverage

Which benches have run for each served config — the run-vs-missing matrix.

```js
import * as Plot from "npm:@observablehq/plot";
import * as Inputs from "npm:@observablehq/inputs";
import { coverage, meta, facets as facetValues } from "./lib/query-engine.js";
import { facetForm } from "./components/facets.js";

const rows = await FileAttachment("data/measurements.json").json();
const fv = facetValues(rows);
const m = meta();
```

```js
const facetsSel = view(facetForm(fv, m.dims));
```

```js
const cov = coverage(rows, { facets: facetsSel });
const cfg = (c) => c.replaceAll("|", " · ");
const long = cov.cells.flatMap((row) => row.has.map((h, i) => ({ cfg: cfg(row.cfg), bench: cov.benches[i], has: h })));
```

```js
if (cov.configs.length === 0) {
  display(html`<div class="muted">No data in this selection.</div>`);
} else {
  display(Plot.plot({
    marginLeft: 300,
    marginBottom: 100,
    width: Math.max(640, cov.benches.length * 44 + 320),
    height: Math.max(200, cov.configs.length * 22 + 120),
    x: { label: "bench", domain: cov.benches, tickRotate: -45 },
    y: { label: null, domain: cov.configs.map(cfg) },
    color: { domain: [false, true], range: ["#262f34", "#0f8f82"], legend: true, tickFormat: (d) => (d ? "run" : "missing") },
    marks: [Plot.cell(long, { x: "bench", y: "cfg", fill: "has", inset: 0.5 })],
  }));
}
```

<div class="muted">${cov.configs.length} configs · ${cov.benches.length} benches</div>
