# Pareto frontier

Every served config is a **✕** at its exact (speed, quality); cross size = VRAM. **Up-and-left is smarter + faster.** Hover any cross for its config, think mode and exact values.

```js
import * as Plot from "npm:@observablehq/plot";
import * as Inputs from "npm:@observablehq/inputs";
import { scaleLinear, scaleSqrt } from "npm:d3-scale";
import { forceSimulation, forceX, forceY, forceCollide } from "npm:d3-force";
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
  const vr = pts.filter((p) => p.vram != null && p.vram > 0).map((p) => p.vram);
  // Size across the MEASURED VRAM range (not from 0) so the tightly-clustered real values still
  // show contrast; the legend + caption flag that it's a relative scale.
  const rDomain = vr.length ? [Math.min(...vr), Math.max(...vr)] : [0, 1];
  const fmtVram = (v) => (v != null && v > 0 ? `${(v / 1024).toFixed(1)} GiB` : "n/a");

  // Spread overlapping bubbles apart WITHOUT lying about the frontier: a collision layout where
  // forceX/Y anchor every bubble to its TRUE (x,y) and forceCollide only pushes apart the ones
  // that would overlap — isolated frontier points barely move, crowded clusters fan out. Run it
  // in pixel space (scales + margins kept exactly in sync with Plot), then invert back to data
  // space so Plot re-draws each bubble where the simulation placed it. The tooltip always shows
  // each bubble's TRUE metrics (x_true / y_true), not its nudged position.
  const W = Math.max(360, Math.min(width, 1100));
  const H = 540;
  const mg = { left: 54, right: 20, top: 20, bottom: 44 };
  const xDom = [0, Math.max(...pts.map((p) => p.x)) * 1.05];
  const yDom = [0, Math.max(...pts.map((p) => p.y)) * 1.05];
  const xs = scaleLinear(xDom, [mg.left, W - mg.right]);
  const ys = scaleLinear(yDom, [H - mg.bottom, mg.top]);
  const rs = scaleSqrt(rDomain, [6, 18]);
  const rOf = (p) => (p.vram != null && p.vram > 0 ? rs(p.vram) : 6);

  const nodes = pts.map((p) => ({ ...p, x_true: p.x, y_true: p.y, ax: xs(p.x), ay: ys(p.y), vramLabel: fmtVram(p.vram) }));
  for (const n of nodes) {
    n.x = n.ax;
    n.y = n.ay;
  }
  // Gentle: crosses overlap legibly, so only a slight nudge (half-radius collision) — near-identical
  // configs stay clustered, they just don't sit exactly on top of each other.
  forceSimulation(nodes)
    .force("x", forceX((d) => d.ax).strength(0.6))
    .force("y", forceY((d) => d.ay).strength(0.6))
    .force("collide", forceCollide((d) => rOf(d) * 0.5).strength(0.5))
    .stop()
    .tick(200);
  for (const n of nodes) {
    n.px = xs.invert(n.x);
    n.py = ys.invert(n.y);
  }
  const measured = nodes.filter((p) => p.vram > 0);
  const kX = nodes.filter((p) => !(p.vram > 0));

  const chart = Plot.plot({
    width: W,
    height: H,
    marginLeft: mg.left,
    marginRight: mg.right,
    marginTop: mg.top,
    marginBottom: mg.bottom,
    grid: true,
    x: { label: `${xMetric} →`, domain: xDom },
    y: { label: `↑ ${yMetric}`, domain: yDom },
    r: { domain: rDomain, range: [6, 18] },
    color: { ...palette.colorScale(pts.map((p) => p.cat), pal), legend: true },
    marks: [
      // Stroke-only ✕ crosses: the CENTRE marks the exact (x,y) and arms overlap legibly.
      // Sized by VRAM, coloured by arch/kv; grey ✕ = VRAM not measured. (think is in the tooltip.)
      Plot.dot(measured, { x: "px", y: "py", r: "vram", symbol: "times", stroke: "cat", fill: "none", strokeWidth: 2.4 }),
      Plot.dot(kX, { x: "px", y: "py", r: 6, symbol: "times", stroke: "#8a949b", fill: "none", strokeWidth: 2 }),
      // One shared tooltip: pointer picks the single nearest cross; title shows its TRUE metrics.
      Plot.tip(nodes, Plot.pointer({
        x: "px",
        y: "py",
        title: (d) => `${d.label}\n${xMetric}: ${d.x_true.toFixed(1)} · ${yMetric}: ${d.y_true.toFixed(1)}\nVRAM: ${d.vramLabel} · ${d.arch}`,
      })),
    ],
  });
  display(html`<div class="scroll-x">${chart}</div>`);
  // Size legend: reference bubbles across the measured VRAM range, sized by the chart's own
  // r-scale so a given radius reads the same as the plotted bubbles.
  if (vr.length) {
    const [lo, hi] = rDomain;
    const legendVals = [...new Set([lo, Math.sqrt(lo * hi), hi].map((v) => Math.round(v)))];
    display(sizeLegend(chart.scale("r"), legendVals));
  }
}
```

<div class="muted">${pts.length} configs plotted · each ✕ = one config · size = VRAM (scaled across the measured range) · grey ✕ = VRAM not measured · near-identical configs sit close together (hover for think + exact values)</div>
