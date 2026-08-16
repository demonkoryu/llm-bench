# Froggeric fixed chat-template A/B — Qwen3.6 / Qwen3.8 OptiQ on Apple M1

Companion to [`froggeric-template-ab.md`](froggeric-template-ab.md), which ran the same six benches
on **rose / llama.cpp / GGUF** at template **v21.3**. This one runs on **m1 / OptiQ / MLX** at
template **v22**, and adds a second model generation.

**Question.** Does [froggeric/Qwen-Fixed-Chat-Templates](https://huggingface.co/froggeric/Qwen-Fixed-Chat-Templates)
(`chat_template.jinja`, v22) beat the template **bundled with the mlx-community quant** on the M1
serving path — and does the answer change between Qwen3.6 and Qwen3.8?

**Verdict.** **No quality difference; an apparent throughput cost.** Every quality metric is
*identical to the decimal* across all three template arms within each generation — not "no material
difference", literally the same numbers. But on the 3.8 pair, where both arms cover all 28 benches,
23 of 77 metrics do move, and every one of them is a performance metric moving the same way:
froggeric is slower. The template costs ~111 extra prompt tokens on a one-tool payload and buys
nothing measurable in quality.

Treat the *size* of the slowdown as unproven (`samples: 1`, and `speed_short` is the noisiest probe
in the suite). Treat the *direction* as not-yet-explained: the obvious dismissal is thermal drift on
a hot M1, but the ordering runs against it — the froggeric arm ran first from cold, the builtin arm
second on an already-hot machine, and it was the second arm that was faster.

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

## Results — quality (the six benches all five arms share)

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

## Results — the full 3.8 pair (77 metrics, all 28 benches)

The table above is the *shared* slice, kept so all five arms line up. It is not the limit of the
evidence: the 3.8 pair is 28-vs-28, so the template A/B there covers everything, including the
probes. Of 77 metrics, **54 are identical and 23 moved** — and the split is clean.

**Identical (54)** — every quality metric, including the long-context ones: `agent_ctx`,
`quality_decay` at 0k/16k/32k, `coding_hard`, `coding_practical`, `coding_bugfix`, `summarization`,
`docqa`, plus all six shared benches above.

**Moved (23)** — every performance metric, all in the same direction:

| metric | builtin | froggeric-v22 | Δ |
|---|---|---|---|
| speed_short/tok_s | 13.20 | 10.18 | **−22.9%** |
| speed_long-32k/tok_s | 14.91 | 13.00 | **−12.8%** |
| e2e-2k/tok_s | 13.29 | 12.07 | −9.2% |
| e2e-2k/score | 54.66 | 50.10 | −8.3% |
| e2e-8k/tok_s | 10.66 | 9.86 | −7.6% |
| e2e-2k/prefill_tps | 65.00 | 59.72 | −8.1% |
| speed_prefill-4k/prefill_tps | 62.96 | 60.65 | −3.7% |
| e2e-32k/tok_s | 6.58 | 6.34 | −3.6% |
| ttft-2k (ms) | 29091 | 31662 | **+8.8%** |
| ttft-8k (ms) | 116394 | 118935 | +2.2% |
| ttft-32k (ms) | 516927 | 519469 | +0.5% |
| prefix_cache_warm_ms | 116842 | 119253 | +2.1% |
| prefix_cache_cold_ms | 117011 | 119358 | +2.0% |
| prefix_cache_speedup | 1.0014 | 1.0009 | −0.1% |

Two things about the shape of this. The deltas are **largest at short context and shrink as context
grows** (ttft +8.8% at 2k → +0.5% at 32k), which is what a fixed per-request prompt overhead of ~111
tokens looks like when amortised over a growing prefill. That is a coherent mechanism. But it does
not explain `speed_short/tok_s` at −22.9%, since decode throughput should be nearly independent of
prompt length — so at least part of this is noise, and possibly all of it.

`samples: 1` means none of this is replicated. **Do not quote these percentages as measurements.**

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
- **Identical-to-the-decimal at temp 0.7 is surprising and remains UNEXPLAINED.** It is not a
  labelling collision: the arms carry distinct `chat_template` values (so distinct `RESUME_KEY` row
  sets), resume skipped only pre-existing combos, and the v22 arms wrote 20 and 77 fresh rows — the
  live log shows 3.6-v22 scoring 11/12 on `reasoning` as it happened. The perf metrics from the same
  runs differ, which rules out the arms being literally the same rows. But *why* a changed prompt
  yields bit-identical grades at non-greedy sampling was never established — fixed seed, or graders
  too coarse to resolve the difference, are both untested. This is the loose end most likely to be
  hiding something; anyone extending this work should settle it first.
- **This platform structurally cannot test froggeric's headline claim.** Its main argument is about
  KV-cache invalidation caused by mutated past turns. On the int4-KV path prefix-cache reuse is
  already nil (`speedup ≈ 1.001` in *both* arms), so there is no cache benefit available to protect.
  A null result here was close to guaranteed regardless of template quality — this suite tests the
  tools-block change, not the cache claim.
- **`triage/json_fail = 1` on 3.8 is a generation regression, not a template artifact** — and
  froggeric does not fix it. Making that attribution is the whole reason the v22 arm was run on
  *both* generations.

## Why v22 was run on 3.6 as well

The 3.6 row already had a froggeric arm, but at **v21.3**. Comparing 3.8-v22 against 3.6-v21.3 would
have confounded template version with model generation. The v22-on-3.6 arm (6 benches, ~25 min) makes
the cross-generation froggeric axis readable. It cost little and it is the difference between a
usable comparison and a misleading one.

It is **6 benches, not 28**, which is the main gap left here: the throughput finding above cannot be
checked against 3.6, because that arm has no speed probes. Extending it to the full 28 is the
cheapest way to learn whether the slowdown is real or an `n=1` artifact.

## Known limitations

- `samples: 1` on every arm. No spread, nothing replicated.
- **Ceiling saturation.** `toolcalling` 10/10, `struct_output` 100, `agentic_loop` 100 in all five
  arms — those benches have no discriminating power for these models and should not be read as
  evidence of equivalence.
- `triage/json_fail = 1` on 3.8 is a single case at `n=1`. It is consistent across both 3.8 arms,
  but "generation regression" is the hypothesis, not the finding.
- **The serving stack being constant across generations is an assumption, not a check.**
  `engine_version` is not a column in the tidy store. The 3.6 rows are from 2026-07-22/23 and the
  3.8 rows from 2026-08-15/16; mlx-optiq was deliberately *not* upgraded in between (0.4.2
  throughout, see the config comment), but that cannot be verified from the recorded rows.

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
