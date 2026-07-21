# Compromise finder

Each config is a point: **x = weighted capability** (tune the weights below), **y = agent capacity**. Points on the **frontier** (up-and-right, emphasised, connected) are the best capability/capacity compromises — nothing beats them on both axes. Hover any point for its capability breakdown.

```js
import * as Plot from "npm:@observablehq/plot";
import { leaderboard, meta, facets as facetValues } from "./lib/query-engine.js";
import { linkedSelect, linkedRadio, linkedFacets, linkedWeights } from "./components/url-state.js";
import { X_DIMS, capabilityScores, combine, frontier } from "./components/combine.js";
import { boardLabel } from "./components/board.js";
import * as palette from "./components/palette.js";

const rows = await FileAttachment("data/measurements.json").json();
const fv = facetValues(rows);
const m = meta();
const archByGguf = new Map(rows.map((r) => [r.gguf_file, r.arch]));

// x defaults to the standard capability composite; re-weigh toward specific skills below.
const DEFAULT_WEIGHTS = { capability: 1 };
// y = agent capacity (how many sub-agents / how much shared context a config serves).
const Y_METRICS = {
  "coder slots": (e) => e.fleet_slots,
  "agent pool k": (e) => (e.raw?.agent_ctx == null ? null : e.raw.agent_ctx / 1000),
  "planner ctx k": (e) => (e.raw?._agent_planner_ctx == null ? null : e.raw._agent_planner_ctx / 1000),
};
```

```js
const weights = view(linkedWeights(X_DIMS, DEFAULT_WEIGHTS));
const yKey = view(linkedSelect("y", Object.keys(Y_METRICS), { value: "coder slots", label: "y: agent capacity" }));
const colorBy = view(linkedRadio("color", ["arch", "kv_quant"], { value: "arch", label: "colour" }));
const think = view(linkedRadio("think", ["no_think", "think", "both"], { value: "both", label: "think" }));
const facetsSel = view(linkedFacets(fv, m.dims));
```

```js
const lb = leaderboard(rows, { think, facets: facetsSel });
const yGet = Y_METRICS[yKey];
const pts = lb.entities
  .map((e) => {
    const { combined, parts } = combine(capabilityScores(e), weights);
    return {
      x: combined,
      y: yGet(e),
      arch: archByGguf.get(e.dims.gguf_file) ?? "—",
      kv_quant: e.dims.kv_quant ?? "—",
      label: boardLabel({ model: e.dims.gguf_file.replace(".gguf", ""), kv: e.dims.kv_quant ?? "—", think: e.think ?? "—" }),
      parts,
    };
  })
  .filter((p) => p.x != null && p.y != null);
const fIdx = new Set(frontier(pts));
const frontPts = pts.filter((_, i) => fIdx.has(i));
const backPts = pts.filter((_, i) => !fIdx.has(i));
const frontLine = [...frontPts].sort((a, b) => a.x - b.x);
```

```js
if (!pts.length) {
  display(html`<div class="muted">No configs have both a weighted-capability value and ${yKey} in this selection. Give at least one weight a value, or widen the filters.</div>`);
} else {
  const W = Math.max(360, Math.min(width, 1000));
  const catOf = (d) => (colorBy === "kv_quant" ? d.kv_quant : d.arch);
  const pal = colorBy === "kv_quant" ? palette.KV_COLORS : palette.ARCH_COLORS;
  const xs = pts.map((p) => p.x);
  const xdom = [Math.max(0, Math.min(...xs) - 4), Math.min(100, Math.max(...xs) + 4)];
  const fmtParts = (d) =>
    d.parts.length ? d.parts.map((p) => `  ${p.key} ${p.score.toFixed(0)} ×${p.weight}`).join("\n") : "  (no weighted dims)";
  const tipText = (d) => `${d.label}\n${yKey}: ${(+d.y).toFixed(1)} · combined: ${(+d.x).toFixed(1)}\nbreakdown:\n${fmtParts(d)}`;

  const chart = Plot.plot({
    width: W,
    height: 540,
    marginLeft: 56,
    marginBottom: 46,
    grid: true,
    x: { label: "weighted capability →", domain: xdom },
    y: { label: `↑ ${yKey}`, nice: true, zero: true },
    color: { ...palette.colorScale(pts.map(catOf), pal), legend: true },
    marks: [
      // frontier connector: the non-dominated upper-right boundary
      Plot.line(frontLine, { x: "x", y: "y", stroke: "#c8ccd0", strokeOpacity: 0.6, strokeWidth: 1.5 }),
      // dominated configs: small + faded
      Plot.dot(backPts, { x: "x", y: "y", r: 4, fill: catOf, fillOpacity: 0.45, stroke: "none" }),
      // frontier configs: larger, outlined
      Plot.dot(frontPts, { x: "x", y: "y", r: 7, fill: catOf, stroke: "white", strokeWidth: 1.2 }),
      Plot.tip(pts, Plot.pointer({ x: "x", y: "y", maxRadius: 30, title: tipText })),
    ],
  });
  display(html`<div class="scroll-x">${chart}</div>`);
}
```

<div class="muted">${pts.length} configs · ● frontier = best compromise (nothing beats it on both axes) · quality dims are absolute, perf/capacity dims normalise within this selection, so the combined score is comparative within the current filters</div>
