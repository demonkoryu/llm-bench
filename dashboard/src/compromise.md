# Compromise finder

Each config is a point: **x = weighted capability** (tune the weights below), **y = agent capacity**. Points on the **frontier** (up-and-right, emphasised, labelled, connected) are the best capability/capacity compromises — nothing beats them on both axes. **Hover** any point for its breakdown, **click** to pin it, or read the table below.

```js
import * as Plot from "npm:@observablehq/plot";
import * as Inputs from "npm:@observablehq/inputs";
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
// Pinned selection, keyed by config label so it survives re-renders (weight/filter changes).
const selected = Mutable(null);
const setSelected = (v) => (selected.value = v);
```

```js
// short frontier label: drop "-it" and spell the think mode compactly
const shortLbl = (d) => d.label.replace(/-it\b/g, "").replace(" [no_think]", " ·nt").replace(" [think]", " ·t").replace(" [n/a]", "");
// Derived selection (read `selected` HERE; the chart cell reads this + writes `selected`, so no
// single cell both reads and writes the mutable — mirrors pareto.md's zoomView/dom split).
const selPt = pts.find((p) => p.label === selected) ?? null;
```

```js
if (!pts.length) {
  display(html`<div class="muted">No configs have both a weighted-capability value and ${yKey} in this selection. Give at least one weight a value, or widen the filters.</div>`);
} else {
  const W = Math.max(360, Math.min(width, 1000));
  const H = 540;
  const catOf = (d) => (colorBy === "kv_quant" ? d.kv_quant : d.arch);
  const pal = colorBy === "kv_quant" ? palette.KV_COLORS : palette.ARCH_COLORS;
  const xs = pts.map((p) => p.x);
  const xdom = [Math.max(0, Math.min(...xs) - 4), Math.min(100, Math.max(...xs) + 4)];
  const fmtParts = (d) =>
    d.parts.length ? d.parts.map((p) => `  ${p.key} ${p.score.toFixed(0)} ×${p.weight}`).join("\n") : "  (no weighted dims)";
  const tipText = (d) => `${d.label}\n${yKey}: ${(+d.y).toFixed(1)} · combined: ${(+d.x).toFixed(1)}\nbreakdown:\n${fmtParts(d)}`;

  const chart = Plot.plot({
    width: W,
    height: H,
    marginLeft: 56,
    marginRight: 150,
    marginBottom: 46,
    grid: true,
    x: { label: "weighted capability →", domain: xdom },
    y: { label: `↑ ${yKey}`, nice: true, zero: true },
    color: { ...palette.colorScale(pts.map(catOf), pal), legend: true },
    marks: [
      Plot.line(frontLine, { x: "x", y: "y", stroke: "#c8ccd0", strokeOpacity: 0.6, strokeWidth: 1.5 }),
      Plot.dot(backPts, { x: "x", y: "y", r: 4, fill: catOf, fillOpacity: 0.45, stroke: "none" }),
      Plot.dot(frontPts, { x: "x", y: "y", r: 7, fill: catOf, stroke: "white", strokeWidth: 1.2 }),
      // always-on labels for the frontier (the compromise picks)
      Plot.text(frontPts, { x: "x", y: "y", text: shortLbl, dx: 10, textAnchor: "start", fontSize: 11, fill: "currentColor", stroke: "var(--theme-background, #1b1e23)", strokeWidth: 3, paintOrder: "stroke" }),
      // pinned-selection highlight ring
      selPt ? Plot.dot([selPt], { x: "x", y: "y", r: 11, fill: "none", stroke: "#fbbf24", strokeWidth: 2.5 }) : null,
      Plot.tip(pts, Plot.pointer({ x: "x", y: "y", maxRadius: 30, title: tipText })),
    ].filter(Boolean),
  });

  // click-to-pin: pick the nearest point (in pixel space) via the plot's own scales
  const svgs = chart.tagName?.toLowerCase() === "svg" ? [chart] : [...chart.querySelectorAll("svg")];
  const svgEl = svgs.find((s) => s.querySelector('g[aria-label*="dot"]')) ?? svgs[svgs.length - 1];
  const sx = chart.scale("x"), sy = chart.scale("y");
  svgEl.style.cursor = "pointer";
  svgEl.addEventListener("click", (ev) => {
    const rect = svgEl.getBoundingClientRect();
    const px = (ev.clientX - rect.left) * (W / rect.width);
    const py = (ev.clientY - rect.top) * (H / rect.height);
    let best = null, bd = Infinity;
    for (const p of pts) { const dx = sx.apply(p.x) - px, dy = sy.apply(p.y) - py, d = dx * dx + dy * dy; if (d < bd) { bd = d; best = p; } }
    setSelected(bd <= 26 * 26 ? best.label : null); // click empty space to clear
  });
  display(html`<div class="scroll-x">${chart}</div>`);
}
```

```js
// pinned detail card (click a dot to fill it)
{
  const p = selPt;
  if (!p) {
    display(html`<div class="muted" style="min-height:1.5em">Click a dot to pin its details here.</div>`);
  } else {
    display(html`<div style="border-left:3px solid #fbbf24;padding:.4rem .7rem;margin:.3rem 0;background:var(--theme-background-alt,#1f2329);border-radius:3px">
      <button style="float:right;border:0;background:none;color:var(--theme-foreground-muted);cursor:pointer;font-size:14px" onclick=${() => setSelected(null)}>✕</button>
      <strong>${p.label}</strong> — combined <strong>${(+p.x).toFixed(1)}</strong> · ${yKey} <strong>${(+p.y).toFixed(1)}</strong>
      <div style="margin-top:.3rem;display:flex;flex-wrap:wrap;gap:.35rem .8rem;font-size:12px;color:var(--theme-foreground-muted)">
        ${p.parts.length ? p.parts.map((pt) => html`<span><span style="font-family:var(--monospace,monospace);color:var(--theme-foreground)">${pt.key}</span> ${pt.score.toFixed(0)}<small style="opacity:.7">×${pt.weight}</small></span>`) : html`<span>no weighted dimensions</span>`}
      </div>
    </div>`);
  }
}
```

<div class="muted">${pts.length} configs · ● frontier = best compromise (nothing beats it on both axes) · quality dims are absolute, perf/capacity dims normalise within this selection, so the combined score is comparative within the current filters</div>

```js
// companion table: every config sorted by combined score (★ = on the frontier)
display(
  Inputs.table(
    pts
      .map((p, i) => ({ config: p.label, "": fIdx.has(i) ? "★" : "", combined: +(+p.x).toFixed(1), [yKey]: +(+p.y).toFixed(1) }))
      .sort((a, b) => b.combined - a.combined),
    { rows: 14, sort: "combined", reverse: true, layout: "auto" },
  ),
);
```
