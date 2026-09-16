# SWE-bench-Live

Real GitHub issues, resolved (or not) in the repository's own container. An instance counts as
**resolved** only when the model's patch makes every `FAIL_TO_PASS` test pass without breaking any
`PASS_TO_PASS` test — there is no partial credit.

```js
import * as Plot from "npm:@observablehq/plot";
import { wilson } from "./lib/score.js";
import { modelName } from "./components/board.js";

const rows = await FileAttachment("data/measurements.json").json();
const modelLabels = await FileAttachment("data/model-labels.json").json();
const subset = await FileAttachment("data/swe-subset.json").json();
```

```js
// One entity per (artifact × spec_decode): the same axes the leaderboard separates on, so a row
// here lines up with a row there. Metrics are pulled by name rather than positionally because a
// model that banked no swe_live rows must be absent, not zero.
const key = (r) => `${r.gguf_file}␟${r.spec_decode ?? ""}`;
const swe = rows.filter((r) => r.bench === "swe_live");
const byEntity = new Map();
for (const r of swe) {
  const k = key(r);
  if (!byEntity.has(k)) byEntity.set(k, { gguf_file: r.gguf_file, spec_decode: r.spec_decode, m: {} });
  byEntity.get(k).m[r.metric] = r.metric_value;
}
const board = [...byEntity.values()]
  .map((e) => {
    const k = e.m.swe_resolved, n = e.m.swe_total;
    const ci = wilson(k ?? 0, n ?? 0);
    return {
      model: modelName(e.gguf_file, modelLabels) + (e.spec_decode ? ` · ${e.spec_decode}` : ""),
      resolved: k, total: n,
      rate: n ? k / n : null,
      lo: ci?.lo ?? null, hi: ci?.hi ?? null,
      timeouts: e.m.swe_timeouts ?? 0,
      no_patch: e.m.swe_no_patch ?? 0,
      rollout_min: e.m.swe_rollout_s != null ? +(e.m.swe_rollout_s / 60).toFixed(0) : null,
      eval_min: e.m.swe_eval_s != null ? +(e.m.swe_eval_s / 60).toFixed(0) : null,
      langs: Object.fromEntries(
        Object.entries(e.m).filter(([k2]) => k2.startsWith("swe_lang_")).map(([k2, v]) => [k2.replace("swe_lang_", ""), v]),
      ),
    };
  })
  .sort((a, b) => (b.rate ?? -1) - (a.rate ?? -1));
```

<div class="warning">

**Read the interval, not the rank.** This runs **${subset.instance_count} pinned instances** (minus
any the gold pass invalidated), so one instance moves a rate by roughly
${(100 / Math.max(1, subset.instance_count)).toFixed(0)} points. The bars below are 95% Wilson
intervals; where two overlap, the ordering between those two models is not evidence of anything.

These results are **reported here only** — they do not feed the leaderboard, the Pareto view or any
composite score. That is deliberate while the bench is new and the subset is small: a 12-instance
proportion is not yet something to rank models by.

</div>

```js
Plot.plot({
  marginLeft: 260,
  height: Math.max(180, board.length * 34 + 60),
  x: { label: "resolve rate", domain: [0, 1], percent: true, grid: true },
  y: { label: null, domain: board.map((d) => d.model) },
  marks: [
    Plot.ruleX([0]),
    Plot.ruleY(board, { y: "model", x1: "lo", x2: "hi", stroke: "currentColor", strokeOpacity: 0.35, strokeWidth: 6 }),
    Plot.dot(board, { y: "model", x: "rate", r: 5, fill: "currentColor" }),
    Plot.text(board, {
      y: "model", x: "hi", dx: 8, textAnchor: "start",
      text: (d) => `${d.resolved}/${d.total}`, fill: "currentColor", fillOpacity: 0.7,
    }),
  ],
})
```

## Per model

```js
Inputs.table(board, {
  columns: ["model", "resolved", "total", "rate", "lo", "hi", "timeouts", "no_patch", "rollout_min", "eval_min"],
  header: {
    rate: "rate", lo: "95% lo", hi: "95% hi", no_patch: "no patch",
    rollout_min: "rollout (min)", eval_min: "eval (min)",
  },
  format: {
    rate: (v) => (v == null ? "—" : `${(v * 100).toFixed(0)}%`),
    lo: (v) => (v == null ? "—" : `${(v * 100).toFixed(0)}%`),
    hi: (v) => (v == null ? "—" : `${(v * 100).toFixed(0)}%`),
  },
})
```

`timeouts` counts rollouts killed at the pinned ${subset.run_params.rollout_timeout_s}s cap;
`no patch` counts rollouts that ended without producing a diff at all. Both are scored as
unresolved — under a fixed budget, running out of time *is* the result — but they separate "tried
and was wrong" from "never got as far as an edit", which the rate alone hides.

Only configurations that can serve the pinned ${(subset.run_params.ctx/1024).toFixed(0)}k context
appear here. Both K2-Horizon rows are absent for that reason: `llama-server` dies during the load at
that width on a single V100. They remain in every other bench.

## Per language

```js
const langRows = board.flatMap((d) =>
  Object.entries(d.langs).map(([lang, v]) => ({ model: d.model, lang, rate: v })),
);
```

```js
Plot.plot({
  marginLeft: 260,
  height: Math.max(180, board.length * 30 + 80),
  x: { label: "resolve rate", domain: [0, 1], percent: true, grid: true },
  y: { label: null, domain: board.map((d) => d.model) },
  color: { legend: true, label: "language" },
  marks: [Plot.ruleX([0]), Plot.dot(langRows, { y: "model", x: "rate", fill: "lang", r: 5 })],
})
```

<div class="caution">

Each language is only **${subset.per_language} instances**, so a per-language rate moves in steps of
${(100 / subset.per_language).toFixed(0)} points and is at best directional. It is shown to expose
gross asymmetries — a model that solves nothing in Rust but half of TypeScript — not to rank
languages against each other.

</div>

## What is pinned

```js
Inputs.table(subset.instances, {
  columns: ["language", "instance_id", "repo", "fail_to_pass", "pass_to_pass"],
  header: { fail_to_pass: "F2P tests", pass_to_pass: "P2P tests" },
})
```

The set is fixed so a model benchmarked later is comparable to one benchmarked today. Changing the
instances, the languages, or the run parameters means a new subset version — not a re-run of this
one.

<div class="tip">

**dataset** `${subset.dataset}` at revision `${subset.dataset_revision}` ·
**selection** seed ${subset.seed}, ${subset.per_language} per language, one instance per repository,
F2P ≤ ${subset.filters.fail_to_pass_max}, P2P ≤ ${subset.filters.pass_to_pass_max} ·
**budget** ${subset.run_params.rollout_timeout_s}s and ${subset.run_params.step_limit} steps per
instance at ctx ${subset.run_params.ctx}, agent `${subset.run_params.agent}`

</div>

The denominator is the **gold-validated** subset, not the pinned one: the benchmark's own reference
patch is run first, and any instance that fails with it is excluded. Tests rot and Docker does not
isolate perfectly, so an instance can become unresolvable by anyone — scoring models against one of
those would not be conservative, it would be wrong.
