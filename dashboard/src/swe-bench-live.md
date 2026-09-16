# SWE-bench-Live

Real GitHub issues, resolved (or not) in the repository's own container. An instance counts as
**resolved** only when the model's patch makes every `FAIL_TO_PASS` test pass without breaking any
`PASS_TO_PASS` test. There is no partial credit.

```js
import * as Plot from "npm:@observablehq/plot";
import { wilson } from "./lib/score.js";
import { modelName } from "./components/board.js";

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
      langs: Object.fromEntries(LANGS.map((l) => [l, e.m[`swe_lang_${l}`] ?? null])),
    };
  })
  .sort((a, b) => b.pct - a.pct || a.model.localeCompare(b.model));

const nInst = subset.instance_count;
const perInstancePoints = nInst ? 100 / nInst : 0;
```

<div class="warning">

**Read the interval, not the rank.** ${nInst} pinned instances, so one instance moves a rate by
${perInstancePoints.toFixed(0)} points. The bars are 95% Wilson intervals — where two overlap, the
ordering between those two models is not evidence. These results are reported **here only**: they do
not feed the leaderboard, the Pareto view, or any composite score.

</div>

## Resolve rate

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

**`no patch`** counts rollouts that ended without producing a diff at all; **`timeouts`** counts
those stopped at the pinned wall clock. Both score as unresolved — under a fixed budget, running out
is the result — but they separate "tried and was wrong" from "never got as far as an edit", which
the rate alone hides.

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
          // Offset within the y band: with three instances per language the rates collapse onto a
          // handful of values, so exact overlap is the common case and one visible dot would stand
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
