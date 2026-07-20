# Pareto frontier

Every served config as a bubble: pick the two axes, size is VRAM. **Up-and-left is smarter + faster.** Filled = `no_think`, hollow ring = `think`.

```js
import * as Plot from "npm:@observablehq/plot";
import * as Inputs from "npm:@observablehq/inputs";
import { pareto, meta, facets as facetValues } from "./lib/query-engine.js";
import { facetForm } from "./components/facets.js";
import * as palette from "./components/palette.js";
import { sizeLegend } from "./components/size-legend.js";

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
  .map((p) => ({ ...p, cat: colorBy === "kv_quant" ? (p.cfg?.kv_quant ?? "—") : p.arch }));
```

```js
if (pts.length === 0) {
  display(html`<div class="muted">No configs have both axes measured in this selection (need overlapping benches).</div>`);
} else {
  // Split by whether VRAM was actually measured for this exact config (kv_quant included).
  // Configs with no VRAM are drawn as a grey ✕ so missing data can't masquerade as size 0.
  const known = pts.filter((p) => p.vram != null && p.vram > 0);
  const unknown = pts.filter((p) => !(p.vram != null && p.vram > 0));
  const kNo = known.filter((p) => p.think !== "think");
  const kYes = known.filter((p) => p.think === "think");
  const vr = known.map((p) => p.vram);
  // Size across the MEASURED VRAM range (not from 0) so the tightly-clustered real values
  // still show contrast; the caption + legend flag that it's a relative scale.
  const rDomain = vr.length ? [Math.min(...vr), Math.max(...vr)] : [0, 1];
  const chart = Plot.plot({
    width: Math.max(360, Math.min(width, 1100)),
    height: 540,
    grid: true,
    x: { label: `${xMetric} →`, domain: [0, Math.max(...pts.map((p) => p.x)) * 1.05], nice: true },
    y: { label: `↑ ${yMetric}`, domain: [0, Math.max(...pts.map((p) => p.y)) * 1.05], nice: true },
    r: { domain: rDomain, range: [4, 16] },
    color: { ...palette.colorScale(pts.map((p) => p.cat), pal), legend: true },
    marks: [
      Plot.dot(kNo, { x: "x", y: "y", r: "vram", fill: "cat", stroke: "cat", fillOpacity: 0.7, channels: { config: "label", VRAM: "vram", arch: "arch" }, tip: true }),
      Plot.dot(kYes, { x: "x", y: "y", r: "vram", stroke: "cat", fill: "none", strokeWidth: 2, channels: { config: "label", VRAM: "vram", arch: "arch" }, tip: true }),
      Plot.dot(unknown, { x: "x", y: "y", symbol: "times", r: 4, stroke: "#8a949b", strokeWidth: 1.4, channels: { config: "label", VRAM: () => "n/a", arch: "arch" }, tip: true }),
    ],
  });
  display(html`<div class="scroll-x">${chart}</div>`);
  // Size legend: reference bubbles across the measured VRAM range, sized by the chart's own
  // r-scale so a given radius reads the same as the plotted bubbles.
  if (vr.length) {
    const [lo, hi] = rDomain;
    // Exact range endpoints (+ geometric mid) so the 3 refs stay distinct and in-domain even
    // when the measured VRAM spread is narrow.
    const legendVals = [...new Set([lo, Math.sqrt(lo * hi), hi].map((v) => Math.round(v)))];
    display(sizeLegend(chart.scale("r"), legendVals));
  }
}
```

<div class="muted">${pts.length} configs plotted · ● filled = no_think · ○ ring = think · bubble size = VRAM (scaled across the measured range) · grey ✕ = VRAM not measured</div>
