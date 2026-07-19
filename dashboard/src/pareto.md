# Pareto frontier

Every served config as a bubble: pick the two axes, size is VRAM. **Up-and-left is smarter + faster.** Filled = `no_think`, hollow ring = `think`.

```js
import * as Plot from "npm:@observablehq/plot";
import * as Inputs from "npm:@observablehq/inputs";
import { pareto, meta, facets as facetValues } from "./lib/query-engine.js";
import { facetForm } from "./components/facets.js";
import * as palette from "./components/palette.js";

const rows = await FileAttachment("data/measurements.json").json();
const fv = facetValues(rows);
const m = meta();
```

```js
const xMetric = view(Inputs.select(m.metrics, { value: "decode tok/s", label: "x axis" }));
const yMetric = view(Inputs.select(m.metrics, { value: "reasoning %", label: "y axis" }));
const think = view(Inputs.radio(["no_think", "think", "both"], { value: "both", label: "think" }));
const colorBy = view(Inputs.radio(["arch", "kv_quant"], { value: "arch", label: "color" }));
const facetsSel = view(facetForm(fv, m.dims));
```

```js
const pr = pareto(rows, { xMetric, yMetric, think, facets: facetsSel });
const pal = colorBy === "kv_quant" ? palette.KV_COLORS : palette.ARCH_COLORS;
const pts = pr.points
  .filter((p) => p.x != null && p.y != null)
  .map((p) => ({ ...p, cat: colorBy === "kv_quant" ? (p.cfg?.kv_quant ?? "—") : p.arch, vramR: p.vram ?? 0 }));
const noThink = pts.filter((p) => p.think !== "think");
const thinkPts = pts.filter((p) => p.think === "think");
```

```js
if (pts.length === 0) {
  display(html`<div class="muted">No configs have both axes measured in this selection (need overlapping benches).</div>`);
} else {
  display(html`<div class="scroll-x">${Plot.plot({
    width: Math.max(360, Math.min(width, 1100)),
    height: 540,
    grid: true,
    x: { label: `${xMetric} →`, domain: [0, Math.max(...pts.map((p) => p.x)) * 1.05], nice: true },
    y: { label: `↑ ${yMetric}`, domain: [0, Math.max(...pts.map((p) => p.y)) * 1.05], nice: true },
    r: { range: [3, 15] },
    color: { ...palette.colorScale(pts.map((p) => p.cat), pal), legend: true },
    marks: [
      Plot.dot(noThink, { x: "x", y: "y", r: "vramR", fill: "cat", stroke: "cat", fillOpacity: 0.7, channels: { config: "label", VRAM: "vram", arch: "arch" }, tip: true }),
      Plot.dot(thinkPts, { x: "x", y: "y", r: "vramR", stroke: "cat", fill: "none", strokeWidth: 2, channels: { config: "label", VRAM: "vram", arch: "arch" }, tip: true }),
    ],
  })}</div>`);
}
```

<div class="muted">${pts.length} configs plotted · ● filled = no_think · ○ ring = think · bubble size = VRAM</div>
