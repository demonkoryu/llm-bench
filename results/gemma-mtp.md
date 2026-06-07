# Gemma4 MTP speculative decoding — llama.cpp PR #23398 trial

**Verdict: works on the dense 12B (~2× decode), but blocked for our production config
by a Vulkan quantized-KV acceptance bug. Not adopted.**

Proposal 2 from the MTP discussion: build the WIP Gemma4-MTP branch and wire the Gemma
assistant drafters. Done — here's what we found.

## Setup

- **Branch:** [ggml-org/llama.cpp#23398](https://github.com/ggml-org/llama.cpp/pull/23398)
  "Gemma 4 MTP Support" (open, approved; head `efd651a8e`, build `version: 9560`).
- **Built isolated** in a git worktree at `llm2:~/llama.cpp-mtp/build-vulkan` (VK_BIN
  override) so the production binaries at `~/llama.cpp/build-vulkan` are untouched.
- **Target:** our fleet's `Gemma4-12B Q5_K_M` (`unsloth/gemma-4-12b-it-GGUF`).
- **Drafter:** `MTP/gemma-4-12B-it-MTP-Q8_0.gguf` (465 MB, ~408M-param `gemma4_assistant`
  head — a *separate* draft model, unlike Qwen3.6's embedded MTP head). Won't load in
  stock llama.cpp; needs this branch.
- Invocation: `--model-draft <drafter> --spec-type draft-mtp --spec-draft-n-max 4`,
  `-fa on`, int-dot off. Scripts: `scripts/llm2/gemma-mtp-ab.sh`, `gemma-mtp-kvtest.sh`.

## Result — the drafter works, but only with f16 KV

Decode t/s on Gemma4-12B (code workload, greedy, warmup discarded):

| KV cache | MTP | decode t/s | draft accept | vs prod baseline |
| :--- | :--- | ---: | ---: | ---: |
| q8_0 | off | 43.6 | — | **baseline (production)** |
| f16  | off | 49.8 | — | +14% (KV type alone) |
| **f16**  | **n4** | **89.3** | **64.2%** (367/572) | **2.05×** |
| q8_0 | n4  | 31.2 | **0.2%** (5/2014) | 0.72× — *net loss* |

- **With f16 KV the MTP drafter is excellent:** 64% acceptance, **1.79× over the f16-off
  control** (89.3 / 49.8) and **2.05× over today's production** (q8_0-off). This matches
  the PR's ">2× for dense models" claim — confirmed on RX 7900 XT / Vulkan.
- **With q8_0 KV it is broken:** 0.2% acceptance (5 accepted out of 2014 drafted). The
  target rejects essentially every drafted token, so MTP pays pure draft/verify overhead
  and runs **slower than no MTP at all** (31 vs 44 t/s).

## Why it's blocked: the quantized-KV bug isn't fixed on Vulkan

PR #23398's notes say the "0% draft acceptance with `-ctk q8_0 -ctv q8_0`" bug was fixed
by adding Hadamard-rotation support (a shared-cache rotation-state mismatch). On our build
that fix **does not engage on the Vulkan/gfx1100 backend** — q8_0 KV still gives ~0%
acceptance. The fix presumably lands on the CUDA path where the bug was reported/verified.

This is the opposite of Qwen3.6-35B, whose MTP accepts 73% at q8_0 KV
([results/mtp-probe.md](mtp-probe.md)) — because Qwen uses an *embedded* MTP head, a
different code path that doesn't hit the separate-drafter shared-cache rotation bug.

## Decision

**Not production-ready on this host.** Our whole fleet runs `q8_0` KV — it's what makes the
large context windows fit in 20 GiB. Adopting Gemma4 MTP would force `f16` KV, which roughly
doubles KV memory and shrinks max-ctx; the 2× short-context decode win doesn't justify
losing long-context capacity across the board. Options if we want to revisit:

1. **Wait for the PR** to fix quantized-KV acceptance on Vulkan (it's still open/WIP — worth
   a note on the PR that the Hadamard fix doesn't engage on the Vulkan backend).
2. **Test the ROCm build** of the branch — untested here (we built Vulkan only). If ROCm's
   draft path escapes the q8_0 bug, a per-model ROCm+MTP config for Gemma4-12B could be a
   real ~2× decode win. Needs a second worktree build (~30–60 min).
3. **f16 KV only for a dedicated short-context Gemma4-12B profile** — viable but niche.

## Cleanup

Left in place on llm2 for follow-up (isolated, no effect on production):
`~/llama.cpp-mtp` (worktree + `build-vulkan`) and `~/drafters/gemma-4-12B-it-MTP-Q8_0.gguf`.
Remove with: `git -C ~/llama.cpp worktree remove ~/llama.cpp-mtp --force && rm -rf ~/drafters`.
