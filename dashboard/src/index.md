# Leaderboard

Composite **capability**, **speed** and **fleet** scores, normalized within the current selection. Sort any column by clicking its header.

```js
import * as Plot from "npm:@observablehq/plot";
import * as Inputs from "npm:@observablehq/inputs";
import { leaderboard, meta, facets as facetValues, METRIC_HELP } from "./lib/query-engine.js";
import { facetForm } from "./components/facets.js";
import { metricHelp } from "./components/metric-help.js";
import { BOARD_COLUMNS, boardRows, boardFormat, boardLabel } from "./components/board.js";

const rows = await FileAttachment("data/measurements.json").json();
const fv = facetValues(rows);
const m = meta();
```

```js
const think = view(Inputs.radio(["no_think", "think", "both"], { value: "both", label: "think" }));
const facetsSel = view(facetForm(fv, m.dims));
```

```js
const lb = leaderboard(rows, { think, facets: facetsSel });
const data = boardRows(lb.entities).map((d) => ({ ...d, label: boardLabel(d) }));
const top = [...data].sort((a, b) => (b.capability ?? -1) - (a.capability ?? -1)).slice(0, 20);
```

<div class="muted">${lb.count.toLocaleString()} measurements · ${data.length} configs · normalized within this selection</div>

```js
// Fill on desktop; on a phone keep a readable min width and scroll inside the card.
display(html`<div class="scroll-x">${Plot.plot({
  marginLeft: 250,
  width: Math.max(560, width),
  height: Math.max(160, top.length * 24 + 40),
  x: { label: "capability →", grid: true, domain: [0, 100] },
  y: { label: null },
  color: { legend: true, scheme: "observable10" },
  marks: [
    Plot.barX(top, { x: "capability", y: "label", fill: "family", sort: { y: "-x" } }),
    Plot.ruleX([0]),
    Plot.text(top, { x: "capability", y: "label", text: (d) => (d.capability == null ? "" : d.capability.toFixed(0)), dx: 14, fill: "currentColor" }),
  ],
})}</div>`);
```

```js
display(Inputs.table(data, {
  columns: ["model", "template", "kv", "think", ...BOARD_COLUMNS.map((c) => c.key)],
  sort: "capability",
  reverse: true,
  format: boardFormat,
  align: Object.fromEntries(BOARD_COLUMNS.map((c) => [c.key, "right"])),
  width,
}));
display(metricHelp(METRIC_HELP, BOARD_COLUMNS.map((c) => c.key), { title: "What the columns mean" }));
```
