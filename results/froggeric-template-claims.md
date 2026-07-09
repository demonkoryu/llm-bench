# Froggeric fixed chat-template — testing the *claims* (round 2)

Round 1 (`froggeric-template-ab.md`) A/B'd end-to-end capability and found no material
difference — because the built-in templates already top out at short context, and the
template's real claims are multi-turn / long-context behaviors that suite didn't exercise.
This round tests the **claims themselves**, mostly by *rendering* (llama.cpp `/apply-template`
+ `/tokenize`) rather than generating — so the results are deterministic and model-independent.

**Models:** all 4 Qwen3.6 (2 dense-hybrid 27B, 2 A3B-MoE 35B). **Results were byte-identical
across all four** (rendering is tokenizer-driven), so the template effect is not model-specific.

## Verdict by claim

| Probe | Claim | Result | Evidence |
|---|---|---|---|
| P1 prefix-stability | "100% KV-cache hits / no prefix destruction" | **✅ confirmed fixed** | built-in invalidates 171 tok over 2 turns; froggeric 0, prefix stable |
| P7 real cache reuse | (P1 in practice) | **✅ directional** | froggeric reuses more prefix (627 vs 478 cached @turn3); small at short length |
| P2 token-footprint | "reduces token waste" | **❌ opposite** | froggeric +25% (tools) / +24% (think-history) |
| P3 empty-think | "empty-think poisoning" | ➖ no difference | identical render (66 tok, 1 shell) |
| P4 mid-convo system | "mid-conversation system prompts crash" | ➖ not reproduced | built-in renders it fine, no error |
| P5 oversized tool return | "oversized API returns exceed context" | ➖ not fixed as-shipped | both → ~40k tok; froggeric truncation defaults **off** |
| P6 agentic-recovery | "stalling / stuck repeating failed calls" | ➖ no difference | both 3/3: recover on transient/bad-arg, stop gracefully on permanent fail |

## The one real win: KV-cache prefix stability (P1 / P7)

The official Qwen template strips `<think>` blocks from **past** assistant turns (only the
latest turn keeps its reasoning). So when a new turn is appended, the rendering of earlier
turns *changes* — `render(history)` stops being an exact prefix of `render(history + turn)` —
and every token from the first divergence onward must be re-prefilled. Measured:

```
built-in : turn1 invalidates 91 tok, turn2 invalidates 80 tok  → 171 total, prefix=false
froggeric: 0 / 0                                                → 0 total,   prefix=true  (preserve_thinking=true)
```

This is **per-turn, cumulative, and grows with conversation length** — exactly the "prefix
cache destruction" the template targets. P7 (driving the real conversation and reading
`timings.prompt_n`) confirms froggeric reuses a larger cached prefix (627 vs 478 tokens at
turn 3), though at only 3 turns the absolute re-prefill saving is modest.

## The cost: it's heavier, not lighter (P2)

Rendering identical conversations, froggeric produces **more** tokens, not fewer:

```
plain chat        54  → 54    (+0)
tools schema     413  → 515   (+102, +25%)   verbose XML tool preamble + instructions
multiturn+think  656  → 813   (+157, +24%)   preserved reasoning in history
```

So the "reduces token waste" framing is inverted for standard traffic — the template **trades
tokens for cache stability**. Net value depends on workload: long multi-turn agentic sessions
(re-prefill dominates) favor froggeric; short or single-turn favor the leaner built-in.

## Claims that didn't reproduce as-shipped

- **P4 mid-conversation system message** — the built-in template handles it without error; no crash to fix here.
- **P5 oversized tool returns** — froggeric *can* truncate (`max_tool_response_chars`) but it
  defaults to `0` (off), so as-shipped both templates pass a 160k-char tool blob straight through (~40k tokens).
- **P6 agentic error-recovery** — on transient errors, bad-argument correction, and a permanently
  failing tool, both templates behaved identically (recover, or stop gracefully without looping).
- **P3 empty-think** — no accumulation observed under either template.

## Method / reproduce

`node runners/template-claims.mjs --models Qwen3.6 --ctx 32768` (manages both arms + all probes).
Render-only spot check vs any server: `--probe-url <url> [--probe-model <id>]`. Fixtures in
`runners/template-claims-fixtures.mjs`; raw output `results/template-claims.json`.
