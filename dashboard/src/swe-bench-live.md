# SWE-bench-Live

Real GitHub issues, resolved (or not) in the repository's own container. An instance counts as
**resolved** only when the model's patch makes every `FAIL_TO_PASS` test pass without breaking any
`PASS_TO_PASS` test. There is no partial credit.

```js
import * as Plot from "npm:@observablehq/plot";
import { wilson } from "./lib/score.js";
import { modelName } from "./components/board.js";
import { metricHelp } from "./components/metric-help.js";

const rows = await FileAttachment("data/measurements.json").json();
const modelLabels = await FileAttachment("data/model-labels.json").json();
const subset = await FileAttachment("data/swe-subset.json").json();
```

```js
// One entity per (artifact × spec_decode) — the axes the leaderboard separates on, so a row here
// lines up with a row there. Metrics are gathered by name: a config that banked no swe_live rows
// must be ABSENT, not silently zero.
const swe = rows.filter((r) => r.bench === "swe_live");
const byEntity = new Map();
for (const r of swe) {
  const k = `${r.gguf_file}␟${r.spec_decode ?? ""}`;
  if (!byEntity.has(k)) byEntity.set(k, { gguf_file: r.gguf_file, spec_decode: r.spec_decode, m: {} });
  byEntity.get(k).m[r.metric] = r.metric_value;
}

const LANGS = subset.languages;
const board = [...byEntity.values()]
  .map((e) => {
    const k = e.m.swe_resolved ?? 0;
    const n = e.m.swe_total ?? 0;
    const ci = wilson(k, n) ?? { p: 0, lo: 0, hi: 0 };
    return {
      // Short label: the y axis is the scarcest space on a phone.
      model: modelName(e.gguf_file, modelLabels).replace(/\.gguf$/, "").replace(/-MTP-UD|-UD/, ""),
      resolved: k,
      total: n,
      // Percentages as plain 0-100 numbers. Plot's `percent: true` expresses the same thing but
      // interacts with an explicit domain in ways that render an empty frame — and an empty frame
      // looks identical to "no data", which is how the first version of this page lost its points.
      pct: n ? (100 * k) / n : 0,
      lo: 100 * ci.lo,
      hi: 100 * ci.hi,
      noPatch: e.m.swe_no_patch ?? 0,
      timeouts: e.m.swe_timeouts ?? 0,
      rolloutMin: e.m.swe_rollout_s != null ? Math.round(e.m.swe_rollout_s / 60) : null,
      evalMin: e.m.swe_eval_s != null ? Math.round(e.m.swe_eval_s / 60) : null,
      ctxMedian: e.m.swe_ctx_median ?? null,
      ctxMax: e.m.swe_ctx_max ?? null,
      calls: e.m.swe_calls ?? null,
      sPerCall: e.m.swe_s_per_call ?? null,
      genTokS: e.m.swe_gen_tok_s ?? null,
      gpuHPerResolve: e.m.swe_gpu_h_per_resolve ?? null,
      ctxPerResolve: e.m.swe_ctx_per_resolve ?? null,
      langs: Object.fromEntries(LANGS.map((l) => [l, e.m[`swe_lang_${l}`] ?? null])),
    };
  })
  .sort((a, b) => b.pct - a.pct || a.model.localeCompare(b.model));

const nInst = subset.instance_count;
// TWO counts, and conflating them is a live bug rather than a nicety. `nInst` is how many instances
// the pin NAMES; `nScored` is how many a rate is actually over -- the gold-validated set, i.e. those
// that pass here with the benchmark's own reference patch. They are equal whenever every pinned
// instance validates, which is the normal case and why this went unnoticed. The moment one does not,
// `swe_total` (gold-validated) drops below `instance_count` (pinned) for EVERY configuration, and the
// stale-pin filter below would flag all of them as measured against an older pin, permanently.
const nScored = subset.gold_validated?.resolvable?.length ?? nInst;
const perInstancePoints = nScored ? 100 / nScored : 0;
```

```js
// Page-local glossary, rendered with the shared metric-help component so it looks like the rest of
// the dashboard. Local rather than added to analysis/query-engine.mjs's METRIC_HELP because these
// columns are not in the dashboard's metric catalog — no other view can show them, and the shared
// map is what the pivot and leaderboard select from.
const SWE_HELP = {
  // outcome
  resolved: "Instances whose patch made every FAIL_TO_PASS test pass without breaking any PASS_TO_PASS test. All-or-nothing per instance; there is no partial credit.",
  total: "Instances scored — the gold-validated set, i.e. those that pass here with the benchmark's own reference patch. Instances that fail with the reference patch are excluded, since no model could resolve them.",
  rate: `resolved ÷ total. At this sample size one instance is worth about ${perInstancePoints.toFixed(0)} points, so read it together with the interval.`,
  "95% lo": "Lower bound of the 95% Wilson confidence interval for the rate. Wilson rather than the normal approximation because the latter misbehaves near 0 and 1 — where a small-sample result most often lands.",
  "95% hi": "Upper bound of the same interval. If two configurations' [lo, hi] ranges overlap, the ordering between them is not supported by this data.",
  "no patch": "Rollouts that ended without producing any diff at all — the model never reached an edit it was willing to submit. Scored as unresolved, but a different failure from submitting a wrong patch.",
  timeouts: "Rollouts stopped at the pinned wall clock with work still in progress. Also scored as unresolved: under a fixed budget, running out of time is the result. Counts the agent's own clean stop at its wall clock as well as a rollout killed from outside — before 2026-09-17 only the latter was counted, which published a flat zero here for every configuration.",

  // cost and context
  "ctx median": "Median context the agent accumulated over a rollout, in tokens, across all scored instances. The agent's history is linear — every command and its output stays in the prompt — so this grows monotonically within a rollout and is what the server must actually hold.",
  "ctx peak": "Largest context any single rollout reached. This, not the median, is what decides whether a served window is adequate: exceed it and the longest trajectories are truncated, and those are the ones still making progress when they run long.",
  "agent steps": "Total model calls across all scored instances — one per think-act cycle. Divided by the instance count it gives the steps a model averaged before finishing or running out of budget.",
  "s / step": "Wall clock per agent step, including the time the container spends executing the command. It is NOT decode time: much of a step is the repository's own tooling running, which is why this varies far less between models than their token rates do.",
  "gen tok/s": "Generated tokens per second of rollout wall clock — throughput for the whole agent loop, not a decode-rate measurement. A model that thinks at length shows a high figure here without necessarily finishing sooner.",
  "rollout min": "Total wall clock spent generating patches for this configuration, GPU-bound.",
  "GPU-h / resolve": `GPU-hours of rollout per issue actually resolved — resolve rate and speed in one figure. Stated as a COST rather than a rate because the numerator would otherwise be a ${nInst}-instance proportion, whose noise would be hidden inside what looks like a precise number; as a cost the noisy term sits in the denominator, where with 4 resolves one instance moves the figure by 25%. Blank when nothing resolved: the cost of a resolution is then undefined, not infinite.`,
  "ctx tok / resolve": "Context tokens processed across all rollouts per issue resolved — resolve rate against context appetite. A model that succeeds often on short trajectories scores far better here than one that succeeds as often only after exhausting its window. Same caveat and same blank-when-zero rule as GPU-h / resolve.",
  "eval min": "Total wall clock spent running the repositories' own test suites to judge those patches. CPU-bound and independent of the model, so it is a property of the pinned instances rather than of the configuration.",
};
```

<div class="warning">

**Read the interval, not the rank.** ${nInst} pinned instances, so one instance moves a rate by
${perInstancePoints.toFixed(0)} points. The bars are 95% Wilson intervals — where two overlap, the
ordering between those two models is not evidence. These results are reported **here only**: they do
not feed the leaderboard, the Pareto view, or any composite score.

</div>

## Resolve rate

```js
// A configuration measured against FEWER instances than the pin currently holds is called out
// rather than quietly plotted beside the others. Its rate is over a different denominator, so the
// bar is honest about itself while the comparison between bars is not. This is what the state looks
// like between a pin bump and the sweep that fills it in, and an unlabelled chart in that window
// would put a 12-instance rate and a 16-instance rate on one axis with nothing to say so.
const understated = board.filter((d) => d.total > 0 && d.total < nScored);
display(
  understated.length === 0
    ? html``
    : html`<div class="warning"><b>Measured against an older, smaller pin.</b> ${understated
        .map((d) => `${d.model} (${d.total} of ${nScored})`)
        .join(", ")} — the rate is over a different denominator, so it is not comparable with the rest
        until those instances are rolled out.</div>`,
);
```

```js
// House pattern: fill the page on desktop, keep a readable minimum and scroll inside the card on a
// phone. marginLeft is sized to the longest label — y tick labels are right-anchored and extend
// leftward, so a fixed margin clips names at the SVG edge on a narrow screen.
const labelChars = board.length ? Math.max(...board.map((d) => d.model.length)) : 0;
const marginLeft = Math.min(300, Math.max(120, Math.round(labelChars * 6.4) + 12));
display(
  board.length === 0
    ? html`<div class="muted">No configuration has SWE-bench-Live results yet.</div>`
    : html`<div class="scroll-x">${Plot.plot({
        marginLeft,
        marginRight: 52,
        width: Math.max(marginLeft + 300, width),
        height: Math.max(150, board.length * 32 + 52),
        x: { label: "resolved (%) →", domain: [0, 100], grid: true, ticks: 5 },
        y: { label: null, domain: board.map((d) => d.model) },
        marks: [
          Plot.ruleX([0]),
          // Interval first, so the point draws on top of it.
          Plot.ruleY(board, { y: "model", x1: "lo", x2: "hi", stroke: "currentColor", strokeOpacity: 0.3, strokeWidth: 7 }),
          Plot.dot(board, {
            y: "model", x: "pct", r: 5, fill: "currentColor",
            title: (d) => `${d.resolved}/${d.total} resolved\n95% CI ${d.lo.toFixed(0)}–${d.hi.toFixed(0)}%`,
          }),
          Plot.text(board, {
            y: "model", x: "pct", text: (d) => `${d.resolved}/${d.total}`,
            dx: 14, textAnchor: "start", fill: "currentColor", fillOpacity: 0.75, fontSize: 11,
          }),
        ],
      })}</div>`,
);
```

## Per model

```js
display(
  Inputs.table(board, {
    columns: ["model", "resolved", "total", "pct", "lo", "hi", "noPatch", "timeouts", "rolloutMin", "evalMin"],
    header: {
      model: "config", pct: "rate", lo: "95% lo", hi: "95% hi",
      noPatch: "no patch", rolloutMin: "rollout min", evalMin: "eval min",
    },
    format: {
      pct: (v) => `${v.toFixed(0)}%`,
      lo: (v) => `${v.toFixed(0)}%`,
      hi: (v) => `${v.toFixed(0)}%`,
    },
    width: { model: 240 },
  }),
);
```

```js
display(metricHelp(SWE_HELP, ["resolved", "total", "rate", "95% lo", "95% hi", "no patch", "timeouts"], { title: "column meanings" }));
```

**`no patch`** counts rollouts that ended without producing a diff at all; **`timeouts`** counts
those stopped at the pinned wall clock. Both score as unresolved — under a fixed budget, running out
is the result — but they separate "tried and was wrong" from "never got as far as an edit", which
the rate alone hides.

## Context and speed

How much context an agentic rollout actually consumes, and what a step costs. These answer the two
questions the resolve rate cannot: whether the served window is adequate rather than merely
generous, and whether a low score means slow or means incapable.

```js
const ctxLimit = subset.run_params.ctx;
const haveCost = board.filter((d) => d.ctxMax != null);
```

```js
const mgC = Math.min(300, Math.max(120, Math.round((board.length ? Math.max(...board.map((d) => d.model.length)) : 0) * 6.4) + 12));
display(
  haveCost.length === 0
    ? html`<div class="muted">No context/speed data recorded yet.</div>`
    : html`<div class="scroll-x">${Plot.plot({
        marginLeft: mgC,
        marginRight: 30,
        width: Math.max(mgC + 320, width),
        height: Math.max(150, haveCost.length * 32 + 56),
        x: { label: "context used (tokens) \u2192", domain: [0, Math.max(ctxLimit, ...haveCost.map((d) => d.ctxMax)) * 1.02], grid: true },
        y: { label: null, domain: [...haveCost].sort((a, b) => b.ctxMax - a.ctxMax).map((d) => d.model) },
        marks: [
          Plot.ruleX([0]),
          // The served window, so "how close did we come" is readable without arithmetic.
          Plot.ruleX([ctxLimit], { stroke: "currentColor", strokeOpacity: 0.55, strokeDasharray: "4 3" }),
          Plot.text([{ x: ctxLimit }], { x: "x", frameAnchor: "top", dy: -6, dx: -4, textAnchor: "end", text: () => `served ${(ctxLimit / 1024).toFixed(0)}k`, fill: "currentColor", fillOpacity: 0.7, fontSize: 11 }),
          Plot.ruleY(haveCost, { y: "model", x1: "ctxMedian", x2: "ctxMax", stroke: "currentColor", strokeOpacity: 0.3, strokeWidth: 7 }),
          Plot.dot(haveCost, { y: "model", x: "ctxMedian", r: 4, fill: "currentColor", title: (d) => `median ${d.ctxMedian.toLocaleString()} tokens` }),
          Plot.dot(haveCost, { y: "model", x: "ctxMax", r: 4.5, fill: "currentColor", fillOpacity: 0.55, symbol: "diamond", title: (d) => `peak ${d.ctxMax.toLocaleString()} tokens` }),
        ],
      })}</div>`,
);
```

Filled circle is the median rollout, hollow diamond the peak; the dashed line is the served window.

```js
display(
  Inputs.table(
    [...board].sort((a, b) => (b.ctxMax ?? 0) - (a.ctxMax ?? 0)),
    {
      columns: ["model", "ctxMedian", "ctxMax", "calls", "sPerCall", "genTokS", "gpuHPerResolve", "ctxPerResolve", "rolloutMin", "evalMin"],
      header: {
        model: "config", ctxMedian: "ctx median", ctxMax: "ctx peak", calls: "agent steps",
        sPerCall: "s / step", genTokS: "gen tok/s", gpuHPerResolve: "GPU-h / resolve",
        ctxPerResolve: "ctx tok / resolve", rolloutMin: "rollout min", evalMin: "eval min",
      },
      format: {
        ctxMedian: (v) => (v == null ? "—" : v.toLocaleString()),
        ctxMax: (v) => (v == null ? "—" : v.toLocaleString()),
        sPerCall: (v) => (v == null ? "—" : v.toFixed(1)),
        genTokS: (v) => (v == null ? "—" : v.toFixed(1)),
        gpuHPerResolve: (v) => (v == null ? "—" : v.toFixed(2)),
        ctxPerResolve: (v) => (v == null ? "—" : v.toLocaleString()),
      },
      width: { model: 240 },
    },
  ),
);
```

```js
display(metricHelp(SWE_HELP, ["ctx median", "ctx peak", "agent steps", "s / step", "gen tok/s", "GPU-h / resolve", "ctx tok / resolve", "rollout min", "eval min"], { title: "column meanings" }));
```

<div class="note">

Peak context is the reason the served window is pinned where it is. The longest rollout here reached
a substantial fraction of it, so a smaller window would truncate the long trajectories — which are
the ones with a chance of finishing — rather than merely inconveniencing them.

</div>

### Cost per resolved issue

```js
const eff = board.filter((d) => d.gpuHPerResolve != null && d.ctxPerResolve != null);
```

```js
// Colour + legend rather than text labels next to each point. Two configurations sit at
// (0.18, 39,952) and (0.20, 41,453) — closer together than their own labels are wide — so NO text
// placement separates them; the first version overplotted them into an unreadable smear. Colour
// carries identity, the legend carries the names, and a short index on each dot keeps the mapping
// readable in a screenshot where hovering is not possible.
const effRanked = [...eff].sort((a, b) => a.gpuHPerResolve - b.gpuHPerResolve).map((d, i) => ({ ...d, idx: i + 1 }));
```

```js
display(
  effRanked.length === 0
    ? html`<div class="muted">No configuration resolved an instance, so cost per resolve is undefined.</div>`
    : html`<div class="scroll-x">${Plot.plot({
        marginLeft: 62,
        marginBottom: 44,
        marginRight: 18,
        marginTop: 10,
        width: Math.max(420, Math.min(width, 720)),
        height: 330,
        x: { label: "GPU-hours per resolved issue \u2192", domain: [0, Math.max(...effRanked.map((d) => d.gpuHPerResolve)) * 1.15], grid: true },
        y: { label: "\u2191 context tokens per resolved issue", domain: [0, Math.max(...effRanked.map((d) => d.ctxPerResolve)) * 1.15], grid: true, tickFormat: (v) => `${(v / 1000).toFixed(0)}k` },
        color: { legend: true, domain: effRanked.map((d) => `${d.idx}. ${d.model}`), scheme: "tableau10" },
        marks: [
          Plot.ruleX([0]),
          Plot.ruleY([0]),
          // Area carries the resolve rate, so a configuration that is cheap only because it rarely
          // succeeds cannot sit near the origin looking good.
          Plot.dot(effRanked, {
            x: "gpuHPerResolve", y: "ctxPerResolve",
            r: (d) => 6 + d.pct / 8,
            fill: (d) => `${d.idx}. ${d.model}`,
            fillOpacity: 0.85, stroke: "currentColor", strokeOpacity: 0.35,
            title: (d) => `${d.model}\n${d.resolved}/${d.total} resolved (${d.pct.toFixed(0)}%)\n${d.gpuHPerResolve.toFixed(2)} GPU-h per resolve\n${d.ctxPerResolve.toLocaleString()} ctx tokens per resolve`,
          }),
          // The index sits INSIDE the dot, so it cannot collide with a neighbour's label.
          Plot.text(effRanked, { x: "gpuHPerResolve", y: "ctxPerResolve", text: "idx", fill: "black", fillOpacity: 0.8, fontSize: 10, fontWeight: "bold" }),
        ],
      })}</div>`,
);
```

```js
display(
  Inputs.table(effRanked, {
    columns: ["idx", "model", "resolved", "pct", "gpuHPerResolve", "ctxPerResolve"],
    header: { idx: "#", model: "config", pct: "rate", gpuHPerResolve: "GPU-h / resolve", ctxPerResolve: "ctx tok / resolve" },
    format: {
      pct: (v) => `${v.toFixed(0)}%`,
      gpuHPerResolve: (v) => v.toFixed(2),
      ctxPerResolve: (v) => v.toLocaleString(),
    },
    width: { model: 240 },
    sort: "idx",
  }),
);
```

Toward the origin is cheaper on both axes, and dot area grows with resolve rate — so a
configuration that is cheap only because it rarely succeeds stays visibly small. Numbers match the
table above, ordered by GPU-hours per resolve. A configuration that resolved nothing is absent
rather than plotted at zero, because both costs are undefined for it.


## Per language

```js
const langRows = board.flatMap((d) =>
  LANGS.filter((l) => d.langs[l] != null).map((l) => ({ model: d.model, lang: l, pct: 100 * d.langs[l] })),
);
const mgL = Math.min(300, Math.max(120, Math.round((board.length ? Math.max(...board.map((d) => d.model.length)) : 0) * 6.4) + 12));
```

```js
display(
  langRows.length === 0
    ? html`<div class="muted">No per-language results yet.</div>`
    : html`<div class="scroll-x">${Plot.plot({
        marginLeft: mgL,
        marginRight: 20,
        width: Math.max(mgL + 320, width),
        height: Math.max(170, board.length * 38 + 70),
        x: { label: "resolved (%) →", domain: [0, 100], grid: true, ticks: 5 },
        y: { label: null, domain: board.map((d) => d.model) },
        color: { legend: true, domain: LANGS, scheme: "tableau10" },
        marks: [
          Plot.ruleX([0]),
          // Offset within the y band: with a handful of instances per language the rates collapse
          // onto a few values, so exact overlap is the common case and one visible dot would stand
          // for four. A slightly untidy row beats a hidden one.
          Plot.dot(langRows, {
            y: "model", x: "pct", fill: "lang", r: 4.5,
            dy: (d) => (LANGS.indexOf(d.lang) - (LANGS.length - 1) / 2) * 6,
            title: (d) => `${d.lang}: ${d.pct.toFixed(0)}%`,
          }),
        ],
      })}</div>`,
);
```

<div class="caution">

Each language is only ${subset.per_language} instances, so a per-language rate moves in steps of
${(100 / subset.per_language).toFixed(0)} points and is at best directional. It is shown to expose
gross asymmetries — a model that solves nothing in one language and most of another — not to rank
languages against each other.

</div>

## What is pinned

```js
display(
  Inputs.table(subset.instances, {
    columns: ["language", "instance_id", "repo", "fail_to_pass", "pass_to_pass"],
    header: { instance_id: "instance", fail_to_pass: "F2P", pass_to_pass: "P2P" },
    width: { instance_id: 250, repo: 200 },
  }),
);
```

The set is fixed so a model benchmarked later is comparable to one benchmarked today. Changing the
instances, the languages, or the run parameters means a new subset version — not a re-run of this
one.

```js
// Built with html`` rather than written as a markdown block: interpolation does NOT happen inside
// inline code spans, so the earlier version of this panel shipped literal ${...} to the page for
// every value it wrapped in backticks.
const rp = subset.run_params;
display(html`<div class="tip">
  <b>dataset</b> ${subset.dataset} at revision <code>${subset.dataset_revision}</code><br>
  <b>selection</b> seed ${subset.seed}, ${subset.per_language} per language, one instance per
  repository, F2P ≤ ${subset.filters.fail_to_pass_max}, P2P ≤ ${subset.filters.pass_to_pass_max}<br>
  <b>budget</b> ${rp.rollout_timeout_s}s and ${rp.step_limit} steps per instance at ctx
  ${rp.ctx.toLocaleString()}<br>
  <b>agent</b> ${rp.agent}${rp.agent_overlay ? `, ${rp.agent_overlay}` : ""}
</div>`);
```

```js
const excludedRepos = Object.entries(subset.excluded_repos ?? {});
display(
  excludedRepos.length === 0
    ? html``
    : html`<div class="muted"><b>Excluded repositories</b>${excludedRepos.map(
        ([r, why]) => html`<div><code>${r}</code> — ${why}</div>`,
      )}</div>`,
);
```

The denominator is the **gold-validated** subset: the benchmark's own reference patch is run first,
and any instance failing with it is excluded. Tests rot and Docker does not isolate perfectly, so an
instance can become unresolvable by anyone — scoring models against one of those would not be
conservative, it would be wrong. Configurations that cannot serve the pinned context are absent
entirely rather than recorded as failures; both K2-Horizon rows are missing for that reason.
