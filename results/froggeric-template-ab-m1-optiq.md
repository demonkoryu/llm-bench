# Froggeric fixed chat-template A/B — Qwen3.6 / Qwen3.8 OptiQ on Apple M1

Companion to [`froggeric-template-ab.md`](froggeric-template-ab.md), which ran the same six benches
on **rose / llama.cpp / GGUF** at template **v21.3**. This one runs on **m1 / OptiQ / MLX** at
template **v22**, and adds a second model generation.

**Question.** Does [froggeric/Qwen-Fixed-Chat-Templates](https://huggingface.co/froggeric/Qwen-Fixed-Chat-Templates)
(`chat_template.jinja`, v22) beat the template **bundled with the mlx-community quant** on the M1
serving path — and does the answer change between Qwen3.6 and Qwen3.8?

**Verdict.** **No difference at all.** Not "no material difference" — every one of the 20 graded
metrics is *identical to the decimal* across all three template arms within each generation. The
template costs ~111 extra prompt tokens on a one-tool payload and buys nothing measurable here.

## Setup

- **Models.** `Qwen3.6-27B-OptiQ-4bit`, `Qwen3.8-27B-OptiQ-4bit` (both `engine: optiq`, kv int4).
- **Arms.** `builtin` (template bundled in the quant repo) vs `froggeric-v22`. The 3.6 row also
  retains an older `froggeric` (v21.3) arm from 2026-07-23, shown for reference.
- **Benches.** `triage`, `reasoning`, `toolcalling`, `struct_output`, `instruction_following`,
  `agentic_loop` — the same six the rose A/B used. `samples: 1`, `no_think`.
- **Env.** llm1 / Apple M1, mlx-optiq 0.4.2, `--kv-bits 4 --max-concurrent 1`, sampling hash
  `8f2303d0` on every arm.

### The template has to be set on the daemon, not the harness

`--chat-template` is a **silent no-op on the `optiq` engine**: `runners/optiq-server.mjs`'s
`startServer` ignores `extraFlags` (it only selects the served model id and health-checks, because
the daemon is launched externally by `scripts/llm1/serve.sh`), while `runners/bench-run.mjs` still
stamps `chat_template: froggeric` on every row. Using it would have produced a fully-labelled
froggeric arm actually served with the bundled template.

These arms therefore set the template **on the daemon** (`serve.sh --chat-template "$(cat …)"`) and
pass `--template-name froggeric-v22` to the harness for labelling only. Verified live rather than
assumed: offline renders give 270 prompt tokens (bundled) vs 381 (froggeric) on a one-tool payload,
and the running daemon returned exactly **381** while still parsing structured `tool_calls`.

## Results

| metric | 3.6 builtin | 3.6 v21.3 | 3.6 v22 | 3.8 builtin | 3.8 v22 |
|---|---|---|---|---|---|
| agentic_loop/score | 100.0 | 100.0 | 100.0 | 100.0 | 100.0 |
| instruction_following/score | 96.4 | 96.4 | 96.4 | 92.9 | 92.9 |
| reasoning/reasoning_correct | 11/12 | 11/12 | 11/12 | 12/12 | 12/12 |
| reasoning/json_fail | 0 | 0 | 0 | 0 | 0 |
| struct_output/score | 100.0 | 100.0 | 100.0 | 100.0 | 100.0 |
| struct_output/json_fail | 0 | 0 | 0 | 0 | 0 |
| toolcalling/toolcall_pass | 10/10 | 10/10 | 10/10 | 10/10 | 10/10 |
| triage/json_fail | 0 | 0 | 0 | **1** | **1** |
| triage/halls | 0 | 0 | 0 | 0 | 0 |
| triage/triage_C1, C2 | 0.9 | 0.9 | 0.9 | 0.9 | 0.9 |
| triage/triage_R1–R5, R7 | 1.0 | 1.0 | 1.0 | 0.9 | 0.9 |
| triage/triage_R6 | 0.9 | 0.9 | 0.9 | 0.9 | 0.9 |

Every template column within a generation is identical. The only movement in the table is
**between generations**.

## Interpretation

- **What froggeric actually changes here is the tools block, not the bug fixes.** The mlx-community
  quants already bundle a partly-fixed template: identical rendering to froggeric on simple prompts
  including the `xhigh` reasoning-effort injection, and `enable_thinking=false` works on both. So
  froggeric's headline fixes #1 and #2 are already upstream. What remains is a larger tools block
  (XML function format plus a long IMPORTANT reminder list) — **+111 prompt tokens**, no score change.
- **The documented `TypeError` does not bite on this path.** The bundled template does raise
  froggeric's `TypeError: Can only get item pairs from a mapping` on multi-turn tool history with
  string arguments, but optiq 0.4.1 normalizes tool arguments to a mapping before templating.
  Evidence: `agentic_loop → ok` on both builtin arms.
- **Ceiling problem, again.** `toolcalling` 10/10, `struct_output` 100, `agentic_loop` 100 in every
  arm. There is no headroom for a template to help, exactly as on rose. Read this as *no detectable
  difference on this suite*, not *no difference*.
- **Identical-to-the-decimal at temp 0.7 is surprising** and would normally suggest a labelling
  collision. It is not one: the arms carry distinct `chat_template` values (so distinct `RESUME_KEY`
  row sets), resume skipped only pre-existing combos, and the v22 arms wrote 20 and 77 fresh rows —
  the live log shows 3.6-v22 scoring 11/12 on `reasoning` as it happened.
- **`triage/json_fail = 1` on 3.8 is a generation regression, not a template artifact** — and
  froggeric does not fix it. Making that attribution is the whole reason the v22 arm was run on
  *both* generations.

## Why v22 was run on 3.6 as well

The 3.6 row already had a froggeric arm, but at **v21.3**. Comparing 3.8-v22 against 3.6-v21.3 would
have confounded template version with model generation. The v22-on-3.6 arm (6 benches, ~25 min) makes
the cross-generation froggeric axis readable. It cost little and it is the difference between a
usable comparison and a misleading one.

## Reproduce

All rows are in the Postgres tidy store, keyed by `chat_template`:

```sql
SELECT gguf_file, chat_template, bench, metric, metric_value
FROM tidy
WHERE gguf_file IN ('Qwen3.8-27B-OptiQ-4bit','Qwen3.6-27B-OptiQ-4bit')
  AND chat_template IN ('builtin','froggeric','froggeric-v22') AND status = 'ok';
```

Run ids: `m1-optiq-20260816-112057-benchrun` (3.8 v22, 77 rows),
`m1-optiq-20260816-134346-benchrun` (3.8 builtin, 61 rows),
`m1-optiq-20260816-154126-benchrun` (3.6 v22, 20 rows).

Template used: `chat_template.jinja` v22, sha256 `398edf5b5bb802fb6b9c9a8dba670d09f2aaeef6fdcaa0b2ca307265f59f78dc`
(19262 bytes), held on llm1 at `~/llm-bench/templates/froggeric-qwen-v22.jinja` and vendored into
this repo at `templates/froggeric-qwen-v22.jinja` (identical sha256) by the change that fixes the
`--chat-template` no-op described above.
