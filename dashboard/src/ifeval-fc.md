# IFEval-FC

Can a model obey a formatting instruction that is stated **only inside a JSON-schema parameter
description**? Each case gives the model one tool and one user query; the argument value it supplies
is graded by a deterministic checker — "exactly 6 consecutive spaces between every pair of words",
"must be a valid JSON object", "must contain the letter n exactly 7 times". Nothing is judged by
another model.

```js
import * as Plot from "npm:@observablehq/plot";
import { wilson } from "./lib/score.js";
import { modelName } from "./components/board.js";
import { metricHelp } from "./components/metric-help.js";

const rows = await FileAttachment("data/measurements.json").json();
const modelLabels = await FileAttachment("data/model-labels.json").json();
const pin = await FileAttachment("data/ifeval-fc-subset.json").json();
```

```js
// One entity per (artifact × think state) — think is the axis worth separating here, because a
// formatting constraint is exactly the kind of instruction reasoning might help or hurt, and the
// bench is thinkDependent for that reason.
const fc = rows.filter((r) => r.bench === "ifeval_fc");
const byEntity = new Map();
for (const r of fc) {
  const k = `${r.gguf_file}␟${r.think_mode ?? ""}`;
  if (!byEntity.has(k)) byEntity.set(k, { gguf_file: r.gguf_file, think: r.think_mode, m: {} });
  byEntity.get(k).m[r.metric] = r.metric_value;
}

const CHECKERS = pin.checkers.map((c) => c.replace(/Checker$/, ""));
const nCases = pin.case_count;

const board = [...byEntity.values()]
  .map((e) => {
    const k = e.m.ifeval_fc_pass ?? 0;
    const n = e.m.ifeval_fc_total ?? 0;
    const ci = wilson(k, n) ?? { p: 0, lo: 0, hi: 0 };
    const short = modelName(e.gguf_file, modelLabels).replace(/\.gguf$/, "").replace(/-MTP-UD|-UD/, "");
    return {
      model: `${short} · ${e.think ?? "n/a"}`,
      artifact: short,
      think: e.think ?? "n/a",
      pass: k,
      total: n,
      pct: n ? (100 * k) / n : 0,
      lo: 100 * ci.lo,
      hi: 100 * ci.hi,
      // The funnel, as counts. called → param → pass.
      called: e.m.ifeval_fc_called ?? 0,
      param: e.m.ifeval_fc_param ?? 0,
      reqFail: e.m.ifeval_fc_req_fail ?? 0,
      checkers: Object.fromEntries(CHECKERS.map((c) => [c, e.m[`ifeval_fc_chk_${c}`] ?? null])),
    };
  })
  .sort((a, b) => b.pct - a.pct || a.model.localeCompare(b.model));

const perCasePoints = nCases ? 100 / nCases : 0;
```

```js
const FC_HELP = {
  pass: "Cases where the model called the function, supplied the constrained parameter, AND its value satisfied the checker. All three are required; there is no partial credit.",
  rate: `pass ÷ total. At ${nCases} cases one case is worth ${perCasePoints.toFixed(1)} points, so this is a far finer scale than the SWE-bench-Live page — but the cases are not independent: each function contributes 5 phrasings of the same constraint.`,
  "95% lo": "Lower bound of the 95% Wilson interval. Wilson rather than the normal approximation because the latter misbehaves near 0 and 1.",
  "95% hi": "Upper bound of the same interval. Overlapping ranges mean the ordering between those two entries is not supported by this data.",
  called: "Cases where a tool call naming the expected function came back. A low number here is a tool-calling failure, not a formatting one — an entirely different thing from a wrong argument value.",
  param: "Of those calls, how many included the parameter carrying the constraint. The gap between called and param is a model that invoked the function but omitted the field being tested.",
  "req fail": "Requests that errored at the transport layer. Counted separately so a flaky endpoint cannot masquerade as a model that ignores instructions. Should be 0.",
  think: "Whether the reasoning path was enabled. Kept as a separate row rather than averaged, because a formatting constraint is precisely where reasoning might help or hurt, and collapsing the two would hide it.",
};
```

<div class="warning">

**Read the funnel, not just the rate.** A model scores here only by clearing three stages — call the
function, supply the parameter, satisfy the checker. A zero can mean "ignored the formatting
instruction" or "never called the tool at all", and those are not the same finding. These results
are reported **here only**: they do not feed the leaderboard, the Pareto view, or any composite
score.

</div>

## Pass rate

```js
const labelChars = board.length ? Math.max(...board.map((d) => d.model.length)) : 0;
const marginLeft = Math.min(340, Math.max(140, Math.round(labelChars * 6.4) + 12));
display(
  board.length === 0
    ? html`<div class="muted">No configuration has IFEval-FC results yet.</div>`
    : html`<div class="scroll-x">${Plot.plot({
        marginLeft,
        marginRight: 56,
        width: Math.max(marginLeft + 320, width),
        height: Math.max(160, board.length * 26 + 52),
        x: { label: "cases passed (%) →", domain: [0, 100], grid: true, ticks: 5 },
        y: { label: null, domain: board.map((d) => d.model) },
        color: { legend: true, domain: ["no_think", "think", "n/a"], scheme: "tableau10" },
        marks: [
          Plot.ruleX([0]),
          Plot.ruleY(board, { y: "model", x1: "lo", x2: "hi", stroke: "currentColor", strokeOpacity: 0.28, strokeWidth: 6 }),
          Plot.dot(board, {
            y: "model", x: "pct", r: 4.5, fill: "think",
            title: (d) => `${d.model}\n${d.pass}/${d.total} passed (${d.pct.toFixed(1)}%)\n95% CI ${d.lo.toFixed(0)}–${d.hi.toFixed(0)}%\ncalled ${d.called} · param ${d.param}`,
          }),
          Plot.text(board, {
            y: "model", x: "pct", text: (d) => `${d.pass}/${d.total}`,
            dx: 14, textAnchor: "start", fill: "currentColor", fillOpacity: 0.75, fontSize: 10,
          }),
        ],
      })}</div>`,
);
```

## The funnel

```js
// Stacked stages per entity: how many cases survive each gate. The drop between bars is the
// diagnosis — a short `called` bar is a tool-calling problem, a short `pass` bar under a full
// `param` bar is a formatting problem.
const funnel = board.flatMap((d) => [
  { model: d.model, stage: "1 called", n: d.called },
  { model: d.model, stage: "2 param supplied", n: d.param },
  { model: d.model, stage: "3 format ok", n: d.pass },
]);
const mgF = Math.min(340, Math.max(140, Math.round((board.length ? Math.max(...board.map((d) => d.model.length)) : 0) * 6.4) + 12));
display(
  funnel.length === 0
    ? html`<div class="muted">No funnel data yet.</div>`
    : html`<div class="scroll-x">${Plot.plot({
        marginLeft: mgF,
        marginRight: 20,
        width: Math.max(mgF + 340, width),
        height: Math.max(180, board.length * 30 + 70),
        x: { label: "cases →", domain: [0, nCases], grid: true },
        y: { label: null, domain: board.map((d) => d.model) },
        color: { legend: true, domain: ["1 called", "2 param supplied", "3 format ok"], scheme: "blues" },
        marks: [
          Plot.ruleX([0]),
          Plot.dot(funnel, {
            y: "model", x: "n", fill: "stage", r: 4,
            dy: (d) => (["1 called", "2 param supplied", "3 format ok"].indexOf(d.stage) - 1) * 6,
            title: (d) => `${d.stage}: ${d.n}/${nCases}`,
          }),
        ],
      })}</div>`,
);
```

## Per configuration

```js
display(
  Inputs.table(board, {
    columns: ["artifact", "think", "pass", "total", "pct", "lo", "hi", "called", "param", "reqFail"],
    header: { pct: "rate", lo: "95% lo", hi: "95% hi", reqFail: "req fail" },
    format: {
      pct: (v) => `${v.toFixed(1)}%`,
      lo: (v) => `${v.toFixed(0)}%`,
      hi: (v) => `${v.toFixed(0)}%`,
    },
    width: { artifact: 260 },
    sort: "pct",
    reverse: true,
  }),
);
display(metricHelp(FC_HELP, "IFEval-FC columns"));
```

## Per constraint

```js
// Which constraints the fleet fails, averaged across configurations. This is the view that says
// something about the BENCHMARK rather than about a model: a checker every configuration fails is a
// hard constraint, one everybody passes contributes no signal.
const perChk = CHECKERS.map((c) => {
  const vals = board.map((d) => d.checkers[c]).filter((v) => v != null);
  return { checker: c, mean: vals.length ? (100 * vals.reduce((a, b) => a + b, 0)) / vals.length : null, n: vals.length };
}).filter((d) => d.mean != null).sort((a, b) => a.mean - b.mean);
```

```js
display(
  perChk.length === 0
    ? html`<div class="muted">No per-constraint data yet.</div>`
    : html`<div class="scroll-x">${Plot.plot({
        marginLeft: 200,
        marginRight: 40,
        width: Math.max(520, width),
        height: Math.max(180, perChk.length * 22 + 50),
        x: { label: "mean pass rate across configurations (%) →", domain: [0, 100], grid: true },
        y: { label: null, domain: perChk.map((d) => d.checker) },
        marks: [
          Plot.ruleX([0]),
          Plot.barX(perChk, { y: "checker", x: "mean", fill: "currentColor", fillOpacity: 0.55 }),
          Plot.text(perChk, { y: "checker", x: "mean", text: (d) => `${d.mean.toFixed(0)}%`, dx: 12, textAnchor: "start", fontSize: 10 }),
        ],
      })}</div>`,
);
```

<div class="caution">

Each constraint is ${pin.functions_per_checker * pin.run_params.queries_per_function} cases per
configuration, and the five queries behind each function are rephrasings of the *same* constraint —
so treat a per-constraint rate as directional, not as ${pin.functions_per_checker * pin.run_params.queries_per_function}
independent trials.

</div>

## What is pinned

```js
display(
  Inputs.table(pin.cases, {
    columns: ["checker", "function", "chosen_param", "group"],
    header: { chosen_param: "parameter" },
    width: { function: 230, description: 300 },
  }),
);
```

```js
const rp = pin.run_params;
display(html`<div class="tip">
  <b>dataset</b> ${pin.dataset} at revision <code>${pin.dataset_revision}</code><br>
  <b>graders</b> upstream's own checkers, vendored at commit
  <code>${(pin.upstream_checkers_commit ?? "").slice(0, 12)}</code> and run against upstream's test suite<br>
  <b>selection</b> seed ${pin.seed}, ${pin.functions_per_checker} functions per checker ×
  ${pin.checkers.length} checkers × ${rp.queries_per_function} queries = ${pin.case_count} cases<br>
  <b>budget</b> ${rp.max_tokens.toLocaleString()} max tokens, ${rp.tool_protocol}
</div>`);
```

The set is fixed so a configuration measured later is comparable to one measured today. Changing the
cases, the checkers, or the run parameters means a new subset version — not a re-run of this one.

**On the token budget.** It is ${rp.max_tokens.toLocaleString()}, and that is load-bearing rather than
generous. At 1,024 the reasoning pass collapsed across the whole fleet — one configuration emitted
zero tool calls in think mode while scoring 6/6 without it — because reasoning consumed the budget
before the call was ever emitted. A number produced that way measures the harness, not the model.

**On contamination.** IFEval-FC was published in September 2025, which makes it far less likely to
be in training data than older instruction-following sets — but there is no way to verify that
locally, and nothing here is a continuously-refreshed benchmark the way SWE-bench-Live is. Read these
as a comparison across this fleet, not as absolute capability.
