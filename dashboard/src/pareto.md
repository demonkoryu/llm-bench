# Pareto frontier

Every served config is a small **✕** at its exact (speed, quality). **Up-and-left is smarter + faster.** Colour by arch, KV-quant, or VRAM; hover any cross for details. **Scroll to zoom, drag to pan, double-click to reset.**

```js
import * as Plot from "npm:@observablehq/plot";
import * as Inputs from "npm:@observablehq/inputs";
import { scaleLinear } from "npm:d3-scale";
import { forceSimulation, forceX, forceY, forceCollide } from "npm:d3-force";
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
// `zoomView` = the visible {x,y} domain, or null for the full extent. Written by the wheel/drag
// handlers and the data-change reset below; read only via `dom` so no single cell both reads and
// writes it.
const zoomView = Mutable(null);
```

```js
const pr = pareto(rows, { xMetric, yMetric, think, facets: facetsSel });
const pts = pr.points.filter((p) => p.x != null && p.y != null);
```

```js
// Layout computed ONCE per data/axis change (NOT per zoom): full-extent scales, the collision
// nudge, and each cross's nudged (px,py) in data space. Zooming then only re-renders the domain.
const layout = ((width) => {
  if (!pts.length) return null;
  const W = Math.max(360, Math.min(width, 1100));
  const H = 540;
  const mg = { left: 54, right: 20, top: 20, bottom: 44 };
  const fullXDom = [0, Math.max(...pts.map((p) => p.x)) * 1.05];
  const fullYDom = [0, Math.max(...pts.map((p) => p.y)) * 1.05];
  const xs = scaleLinear(fullXDom, [mg.left, W - mg.right]);
  const ys = scaleLinear(fullYDom, [H - mg.bottom, mg.top]);
  const vram = pts.filter((p) => p.vram > 0).map((p) => p.vram);
  const vramDomain = vram.length ? [Math.min(...vram), Math.max(...vram)] : [0, 1];
  const fmtVram = (v) => (v != null && v > 0 ? `${(v / 1024).toFixed(1)} GiB` : "n/a");
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
  return { W, H, mg, fullXDom, fullYDom, vramDomain, nodes };
})(width);
zoomView.value = null; // reset the zoom whenever the data / axes change
```

```js
// The visible domain: the zoom override, else the full extent. (Reads zoomView; the render cell
// only WRITES zoomView, so no cell both reads and writes it.)
const dom = layout ? (zoomView.value ?? { x: layout.fullXDom, y: layout.fullYDom }) : null;
```

```js
if (!layout) {
  display(html`<div class="muted">No configs have both axes measured in this selection (need overlapping benches).</div>`);
} else {
  const { W, H, mg, fullXDom, fullYDom, vramDomain, nodes } = layout;
  const xd = dom.x;
  const yd = dom.y;
  const pal = colorBy === "kv_quant" ? palette.KV_COLORS : palette.ARCH_COLORS;
  const catOf = (d) => (colorBy === "kv_quant" ? (d.cfg?.kv_quant ?? "—") : d.arch);
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
    x: { label: `${xMetric} →`, domain: xd },
    y: { label: `↑ ${yMetric}`, domain: yd },
    color:
      colorBy === "vram"
        ? { type: "linear", scheme: "YlOrRd", domain: vramDomain, legend: true, label: "VRAM MiB" }
        : { ...palette.colorScale(nodes.map(catOf), pal), legend: true },
    marks: [
      // Small uniform stroke-only ✕ at the exact (x,y). Colour = arch / KV / VRAM; grey ✕ = no VRAM.
      // clip so crosses outside the zoomed domain don't spill over the axes.
      Plot.dot(measured, { x: "px", y: "py", r: 7, symbol: "times", stroke: colorBy === "vram" ? "vram" : catOf, fill: "none", strokeWidth: 2.4, clip: true }),
      Plot.dot(kX, { x: "px", y: "py", r: 7, symbol: "times", stroke: "#8a949b", fill: "none", strokeWidth: 2, clip: true }),
      // Styled tooltip: the pointer transform picks the nearest cross by distance (works even for
      // stroke-only crosses) and shows its exact metrics.
      Plot.tip(nodes, Plot.pointer({ x: "px", y: "py", maxRadius: 30, title: tipText })),
    ],
  });

  // Zoom = re-render at a smaller domain (so the axes re-tick and the styled tooltip keeps working).
  // Wheel zooms toward the cursor, drag pans, double-click resets — all by updating `zoomView`.
  const svgs = chart.tagName?.toLowerCase() === "svg" ? [chart] : [...chart.querySelectorAll("svg")];
  const svgEl = svgs.find((s) => s.querySelector('g[aria-label*="dot"]')) ?? svgs[0];
  svgEl.style.cursor = "grab";
  const plotW = W - mg.left - mg.right;
  const plotH = H - mg.top - mg.bottom;
  const uPt = (ev) => {
    const rect = svgEl.getBoundingClientRect();
    return [(ev.clientX - rect.left) * (W / rect.width), (ev.clientY - rect.top) * (H / rect.height)];
  };
  const clampZoom = (d, full) => {
    let [a, b] = d[0] <= d[1] ? d : [d[1], d[0]];
    const fs = full[1] - full[0];
    const minS = fs / 30;
    if (b - a < minS) {
      const c = (a + b) / 2;
      a = c - minS / 2;
      b = c + minS / 2;
    }
    if (b - a >= fs) return [...full];
    if (a < full[0]) {
      b += full[0] - a;
      a = full[0];
    }
    if (b > full[1]) {
      a -= b - full[1];
      b = full[1];
    }
    return [Math.max(a, full[0]), Math.min(b, full[1])];
  };
  const clampPan = (d, full) => {
    let [a, b] = d;
    const span = b - a;
    if (a < full[0]) {
      a = full[0];
      b = a + span;
    }
    if (b > full[1]) {
      b = full[1];
      a = b - span;
    }
    return [a, b];
  };
  svgEl.addEventListener(
    "wheel",
    (e) => {
      e.preventDefault();
      const [ux, uy] = uPt(e);
      const dataX = scaleLinear(xd, [mg.left, W - mg.right]).invert(ux);
      const dataY = scaleLinear(yd, [H - mg.bottom, mg.top]).invert(uy);
      const f = e.deltaY < 0 ? 1 / 1.2 : 1.2;
      zoomView.value = {
        x: clampZoom([dataX + (xd[0] - dataX) * f, dataX + (xd[1] - dataX) * f], fullXDom),
        y: clampZoom([dataY + (yd[0] - dataY) * f, dataY + (yd[1] - dataY) * f], fullYDom),
      };
    },
    { passive: false },
  );
  svgEl.addEventListener("pointerdown", (e) => {
    if (e.button !== 0) return;
    const rect = svgEl.getBoundingClientRect();
    const sx = e.clientX;
    const sy = e.clientY;
    const x0 = [...xd];
    const y0 = [...yd];
    svgEl.style.cursor = "grabbing";
    const move = (me) => {
      const dxData = ((me.clientX - sx) * (W / rect.width) * (x0[1] - x0[0])) / plotW;
      const dyData = ((me.clientY - sy) * (H / rect.height) * (y0[1] - y0[0])) / plotH;
      zoomView.value = {
        x: clampPan([x0[0] - dxData, x0[1] - dxData], fullXDom),
        y: clampPan([y0[0] + dyData, y0[1] + dyData], fullYDom),
      };
    };
    const up = () => {
      window.removeEventListener("pointermove", move);
      window.removeEventListener("pointerup", up);
      svgEl.style.cursor = "grab";
    };
    window.addEventListener("pointermove", move);
    window.addEventListener("pointerup", up);
  });
  svgEl.addEventListener("dblclick", () => {
    zoomView.value = null;
  });
  display(html`<div class="scroll-x">${chart}</div>`);
}
```

<div class="muted">${pts.length} configs plotted · each ✕ = one config at its exact position · colour = ${colorBy === "vram" ? "VRAM" : colorBy} · grey ✕ = VRAM not measured · near-identical configs sit close together (hover for think + exact values)</div>
