# Froggeric fixed chat-template A/B — Qwen3.6

**Question.** Does [froggeric/Qwen-Fixed-Chat-Templates](https://huggingface.co/froggeric/Qwen-Fixed-Chat-Templates)
(`chat_template.jinja`, version `qwen3.6-froggeric-v21.3`, XML tool format as shipped) beat the
**built-in GGUF chat template** for the affected models on our benches?

**Verdict.** **No material difference at short context.** Across 4 Qwen3.6 models × 6 benches (both
think states where applicable), the template produced **5 wins, 3 losses, 32 ties** (|Δ| > 0.5).
Every non-tie is a *single-case flip* on a small-N bench, and wins/losses roughly cancel. No
regression on core short-context capability; no reproducible gain either. Throughput was flat.

## Setup

- **Models** (only Qwen3.6, per request — both dense-hybrid and MoE architectures):
  `Qwen3.6-27B-IQ4_XS`, `Qwen3.6-27B-UD-Q4_K_XL` (dense-hybrid), `Qwen3.6-35B-A3B-IQ4_XS` (MTP),
  `Qwen3.6-35B-A3B-APEX-I-Compact` (MoE). The two 27B were temporarily un-parked for this run.
- **Arms.** baseline = `--jinja` (built-in GGUF template); treatment = same GGUF +
  `--chat-template-file froggeric.jinja`. Only variable changed between arms.
- **Benches** (focused; no long-context per request): `toolcalling`, `agentic-loop`,
  `struct-output`, `instruction-following`, `triage`, `reasoning`. Excluded: `maxctx`,
  `speed-decay`, `quality-decay`, `kv-probe`.
- **Env.** rose / RX 7900 XT, Vulkan, KV q5_0, ctx 16384, greedy (temp 0, deterministic).
- **Tool format.** Tested as shipped (XML `<function=…>`). llama.cpp parsed it into structured
  `tool_calls` correctly — toolcalling stayed 10/10 on every model, so the XML-vs-Hermes format
  change was *not* a parser regression here.

## Results (baseline → treatment, Δ)

| Model | tool (nothi/think) | agentic | struct | instr | triage (nothi/think) | reasoning (nothi/think) | tps |
|---|---|---|---|---|---|---|---|
| 27B-IQ4_XS | 100/100 | 100 | 100 | 92.9 | 89.5→87.7 (**−1.9**) / 88.3 | 91.7 / 91.7→100 (**+8.3**) | 25.0→25.2 |
| 27B-UD-Q4_K_XL | 100/100 | 100 | 100 | 96.4 | 91.4→88.9 (**−2.5**) / 88.3→87.7 (−0.6) | 100 / 100 | 24.2→24.4 |
| 35B-IQ4_XS (MTP) | 100/100 | 80→**100** (**+20**) | 100 | 96.4 | 92.0 / 88.3→88.9 (+0.6) | 83.3→91.7 (**+8.3**) / 100 | 127.8→135.9 |
| 35B-APEX | 100/100 | 100 | 100 | 96.4 | 90.7→93.2 (**+2.5**) / 88.3 | 100 / 100 | 75.9→76.1 |

Cells with no arrow were identical in both arms (ceiling or unchanged). All deltas above are one
graded item moving: agentic = 5 tasks (1 = 20%), reasoning = 12 cases (1 = 8.3%), triage rubric
over 18 cases. `struct-output` and `instruction-following` were byte-identical between arms.

## Interpretation

- **Ceiling problem.** The built-in templates already score at/near ceiling on tool-use (10/10),
  structured output (100%), and instruction-following — there's little room for a template to help.
- **Noise, not signal.** The 35B-IQ4 agentic `+20` (the eye-catching number) is a single task
  recovering; the 27B triage losses are one extra hallucinated anchor. These don't survive as a
  trend across models.
- **Throughput.** No sign of the "80% faster" claim — `power_eff` tps is flat (largest move 127.8→
  135.9, ~6%, within run-to-run variance). Expected: that claim is about deep-Jinja compile cost
  (llama.cpp caches the compiled template) and long contexts, neither of which this suite stresses.
- **What this can't tell you.** The template's headline claims — KV-cache invalidation from mutated
  past turns, token waste at long context, agentic stalls in long loops — are **multi-turn /
  long-context** behaviors. This short-context, mostly short-turn suite (excluded per request)
  does not exercise them. So: *no reason to switch, no reason to fear switching* on this evidence.

## Reproduce

Run IDs per arm are in `results/ab-froggeric-manifest.tsv`; regenerate the table with
`node ab-compare.mjs`. Raw per-run data under `results/runs/<run_id>/run.json`.
