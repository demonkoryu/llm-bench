# Leaderboard

Composite **capability**, **speed** and **fleet** scores, normalized within the current selection. Sort any column by clicking its header, and chart any of them with the **metric** picker.

```js
import * as Plot from "npm:@observablehq/plot";
import * as Inputs from "npm:@observablehq/inputs";
import { leaderboard, meta, facets as facetValues, METRIC_HELP } from "./lib/query-engine.js";
import { linkedRadio, linkedSelect, linkedFacets } from "./components/url-state.js";
import { metricHelp } from "./components/metric-help.js";
import { BOARD_COLUMNS, boardRows, boardFormat, boardLabel } from "./components/board.js";

const rows = await FileAttachment("data/measurements.json").json();
const modelLabels = await FileAttachment("data/model-labels.json").json();
const fv = facetValues(rows);
const m = meta();
```

```js
const think = view(linkedRadio("think", ["no_think", "think", "both"], { value: "both", label: "think" }));
const metricSel = view(linkedSelect("metric", BOARD_COLUMNS.map((c) => c.key), { value: "capability", label: "chart metric" }));
const facetsSel = view(linkedFacets(fv, m.dims));
```

```js
display(metricHelp(METRIC_HELP, BOARD_COLUMNS.map((c) => c.key), { title: "score & column meanings" }));
```

```js
const lb = leaderboard(rows, { think, facets: facetsSel });
const data = boardRows(lb.entities, modelLabels).map((d) => ({ ...d, label: boardLabel(d) }));

// The charted column drives sort direction, axis domain and label — every board column is chartable,
// not just capability. A lower-is-better metric (ttft, vram, vram/ctx-tok) sorts ASCENDING so the
// best configs stay at the top of the chart, the same place they are for a higher-is-better one.
const col = BOARD_COLUMNS.find((c) => c.key === metricSel) ?? BOARD_COLUMNS[0];
const scored = data.filter((d) => d[col.key] != null && !Number.isNaN(d[col.key]));
const top = [...scored].sort((a, b) => (col.lower ? a[col.key] - b[col.key] : b[col.key] - a[col.key])).slice(0, 20);
```

<div class="muted">${lb.count.toLocaleString()} measurements · ${data.length} configs · normalized within this selection · charting <b>${metricSel}</b>${scored.length < data.length ? ` · ${data.length - scored.length} config${data.length - scored.length === 1 ? "" : "s"} have no value for it` : ""}</div>

```js
// Fill on desktop; on a phone keep a readable min width and scroll inside the card.
// Size the left margin to the longest label so model names aren't clipped at the SVG edge
// (y tick labels are right-anchored at the axis and extend leftward). ~6.6px/char at the 10px
// axis font, plus padding; capped so a stray long label can't eat the whole chart.
const labelChars = top.length ? Math.max(...top.map((d) => d.label.length)) : 0;
const marginLeft = Math.min(460, Math.max(250, Math.round(labelChars * 6.6) + 14));
display(
  top.length === 0
    ? html`<div class="muted">No config in this selection has a value for <b>${metricSel}</b>.</div>`
    : html`<div class="scroll-x">${Plot.plot({
        marginLeft,
        width: Math.max(marginLeft + 340, width),
        height: Math.max(160, top.length * 24 + 40),
        // A 0-100 score is pinned so a weak field cannot be rescaled into looking strong; a raw
        // measurement (tok/s, MiB, ms) scales to its own data, which is the only sensible domain.
        x: {
          label: col.lower ? `\u2190 ${col.key} (lower is better)` : `${col.key} \u2192`,
          grid: true,
          ...(col.norm100 ? { domain: [0, 100] } : {}),
        },
        y: { label: null },
        color: { legend: true, scheme: "observable10" },
        marks: [
          Plot.barX(top, { x: col.key, y: "label", fill: "family", sort: { y: col.lower ? "x" : "-x" } }),
          Plot.ruleX([0]),
          Plot.text(top, {
            x: col.key,
            y: "label",
            text: (d) => (d[col.key] == null ? "" : d[col.key].toFixed(col.dec)),
            dx: 14,
            fill: "currentColor",
          }),
        ],
      })}</div>`
);
```

```js
display(Inputs.table(data, {
  columns: ["model", "template", "kv", "spec", "think", ...BOARD_COLUMNS.map((c) => c.key)],
  sort: "capability",
  reverse: true,
  format: boardFormat,
  align: Object.fromEntries(BOARD_COLUMNS.map((c) => [c.key, "right"])),
  width,
}));
```
