# Pareto frontier

Every served config is a small **✕** at its exact (speed, quality). **Up-and-left is smarter + faster.** Colour by arch, KV-quant, or VRAM; hover any cross for details. **Scroll to zoom, drag to pan, double-click to reset.**

```js
import * as Plot from "npm:@observablehq/plot";
import * as Inputs from "npm:@observablehq/inputs";
import { scaleLinear } from "npm:d3-scale";
import { forceSimulation, forceX, forceY, forceCollide } from "npm:d3-force";
import { zoom as d3zoom, zoomIdentity } from "npm:d3-zoom";
import { select } from "npm:d3-selection";
import { pareto, meta, facets as facetValues, METRIC_HELP } from "./lib/query-engine.js";
import { facetForm } from "./components/facets.js";
import { metricHelp } from "./components/metric-help.js";
import * as palette from "./components/palette.js";

const rows = await FileAttachment("data/measurements.json").json();
const fv = facetValues(rows);
const m = meta();
```

```js
const xMetric = view(Inputs.select(m.metrics, { value: "decode tok/s", label: "x axis" }));
const yMetric = view(Inputs.select(m.metrics, { value: "reasoning %", label: "y axis" }));
const think = view(Inputs.radio(["no_think", "think", "both"], { value: "both", label: "think" }));
const colorBy = view(Inputs.radio(["arch", "kv_quant", "vram"], { value: "arch", label: "colour" }));
const facetsSel = view(facetForm(fv, m.dims));
```

```js
display(metricHelp(METRIC_HELP, [xMetric, yMetric, ...(colorBy === "vram" ? ["VRAM MiB"] : [])], { title: "current axes" }));
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
  const vram = pts.filter((p) => p.vram > 0).map((p) => p.vram);
  const vramDomain = vram.length ? [Math.min(...vram), Math.max(...vram)] : [0, 1];
  const fmtVram = (v) => (v != null && v > 0 ? `${(v / 1024).toFixed(1)} GiB` : "n/a");
  const R = 7; // every cross is the same small size — VRAM is shown by colour / tooltip, not size

  // Nudge only overlapping crosses apart (a slight offset so clustered configs still read as
  // clustered). forceX/Y anchor each to its TRUE (x,y); forceCollide separates by a few px. Run in
  // pixel space (scales + margins in sync with Plot), then invert back so Plot draws each in place.
  const W = Math.max(360, Math.min(width, 1100));
  const H = 540;
  const mg = { left: 54, right: 20, top: 20, bottom: 44 };
  const xDom = [0, Math.max(...pts.map((p) => p.x)) * 1.05];
  const yDom = [0, Math.max(...pts.map((p) => p.y)) * 1.05];
  const xs = scaleLinear(xDom, [mg.left, W - mg.right]);
  const ys = scaleLinear(yDom, [H - mg.bottom, mg.top]);

  const nodes = pts.map((p) => ({ ...p, x_true: p.x, y_true: p.y, ax: xs(p.x), ay: ys(p.y), vramLabel: fmtVram(p.vram) }));
  for (const n of nodes) {
    n.x = n.ax;
    n.y = n.ay;
  }
  forceSimulation(nodes)
    .force("x", forceX((d) => d.ax).strength(0.6))
    .force("y", forceY((d) => d.ay).strength(0.6))
    .force("collide", forceCollide(4).strength(0.5))
    .stop()
    .tick(200);
  for (const n of nodes) {
    n.px = xs.invert(n.x);
    n.py = ys.invert(n.y);
  }
  const measured = nodes.filter((p) => p.vram > 0);
  const kX = nodes.filter((p) => !(p.vram > 0));
  const tipText = (d) => `${d.label}\n${xMetric}: ${d.x_true.toFixed(1)} · ${yMetric}: ${d.y_true.toFixed(1)}\nVRAM: ${d.vramLabel}`;

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
    color:
      colorBy === "vram"
        ? { type: "linear", scheme: "YlOrRd", domain: vramDomain, legend: true, label: "VRAM MiB" }
        : { ...palette.colorScale(pts.map((p) => p.cat), pal), legend: true },
    marks: [
      // Small uniform stroke-only ✕: the CENTRE marks the exact (x,y). Colour = arch / KV / VRAM;
      // grey ✕ = VRAM not measured. Native hover tooltip (title) survives the zoom transform.
      Plot.dot(measured, { x: "px", y: "py", r: R, symbol: "times", stroke: colorBy === "vram" ? "vram" : "cat", fill: "none", strokeWidth: 2.4, title: tipText }),
      Plot.dot(kX, { x: "px", y: "py", r: R, symbol: "times", stroke: "#8a949b", fill: "none", strokeWidth: 2, title: tipText }),
    ],
  });

  // Scroll to zoom, drag to pan: wrap all svg content in a <g> and apply the d3-zoom transform to
  // it (the svg's own coordinate space stays fixed, so native hover tooltips stay accurate).
  // Double-click resets; an axis/facet change re-renders a fresh svg at identity.
  // The main plot svg — NOT the colour legend's swatch/ramp svg (Plot puts the legend svg(s) first
  // in the figure). Pick the svg that actually holds the dot marks; fall back to the widest.
  const svgs = chart.tagName?.toLowerCase() === "svg" ? [chart] : [...chart.querySelectorAll("svg")];
  const svgEl =
    svgs.find((s) => s.querySelector('g[aria-label*="dot"]')) ??
    svgs.sort((a, b) => (+b.getAttribute("width") || 0) - (+a.getAttribute("width") || 0))[0];
  const zoomLayer = document.createElementNS("http://www.w3.org/2000/svg", "g");
  while (svgEl.firstChild) zoomLayer.appendChild(svgEl.firstChild);
  svgEl.appendChild(zoomLayer);
  svgEl.style.cursor = "grab";
  const zb = d3zoom()
    .scaleExtent([1, 30])
    .on("zoom", (event) => zoomLayer.setAttribute("transform", event.transform));
  select(svgEl).call(zb).on("dblclick.zoom", null);
  select(svgEl).on("dblclick", () => select(svgEl).call(zb.transform, zoomIdentity));
  display(html`<div class="scroll-x">${chart}</div>`);
}
```

<div class="muted">${pts.length} configs plotted · each ✕ = one config at its exact position · colour = ${colorBy === "vram" ? "VRAM" : colorBy} · grey ✕ = VRAM not measured · near-identical configs sit close together (hover for think + exact values)</div>
