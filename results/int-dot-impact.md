# Vulkan int8 dot-product: decode sweep (corrected)

**TL;DR — on this build, enabling `int dot: 1` does *not* speed up decode for any fleet
model. It is flat-to-negative (0% … −7.4% tg).** An earlier version of this file reported a
"+37% Nemotron" decode win; that was a **measurement artifact** (see "What went wrong"
below). The corrected, warmup-controlled numbers show int-dot should be **disabled at
runtime** on this GPU/driver.

Hardware/build: AMD RX 7900 XT, RADV (Mesa 25.2), `llama.cpp` `a121232fd`, `build-vulkan`
with `int dot: 1` (modern glslc). int-dot toggled on the *same* binary via the runtime env
var `GGML_VK_DISABLE_INTEGER_DOT_PRODUCT=1` (off) vs unset (on) — exactly equivalent to the
build-flag difference, no rebuild needed. `llama-bench -fa 1 -ngl 99 -ctk q8_0 -ctv q8_0
-n 128 -r 3`. Per model: one **cold warmup invocation discarded**, then `off / on / off / on`
(all warm), reported as the mean of each warm pair. t/s.

## Decode (tg128), warm steady-state

| Model | quant / arch | off (int dot:0) | on (int dot:1) | Δ tg |
|---|---|---:|---:|---:|
| Qwen3-30B-2507 UD-Q4_K_XL | MoE, Q4_K | 179.98 | 166.74 | **−7.4%** |
| LFM2.5-8B | MoE, Q5_K | 316.40 | 294.35 | **−7.0%** |
| Gemma4-26B QAT UD-Q4_K_XL | MoE, Q4_K | 130.36 | 123.00 | **−5.6%** |
| Gemma4-26B QAT q4_0 | MoE, q4_0 | 125.89 | 119.03 | **−5.5%** |
| Gemma4-E4B Q5_K_M | dense, Q5_K | 109.40 | 104.54 | **−4.4%** |
| Qwen3-30B-2507 IQ4_XS | MoE, IQ4 | 130.99 | 125.55 | **−4.2%** |
| Gemma4-26B UD-Q4_K_M | MoE, Q4_K | 105.92 | 103.59 | −2.2% |
| Granite-4-H-Tiny Q5_K_M | hybrid, Q5_K | 186.51 | 182.92 | −1.9% |
| Gemma4-12B Q5_K_M | dense, Q5_K | 55.50 | 54.65 | −1.5% |
| Qwen3-14B Q5_K_M | dense, Q5_K | 61.10 | 60.82 | −0.5% |
| Gemma4-12B QAT q4_0 | dense, q4_0 | 61.64 | 61.39 | −0.4% |
| Gemma4-12B QAT UD-Q4_K_XL | dense, Q4_K | 63.54 | 63.31 | −0.4% |
| Nemotron-3-Nano-4B Q8_0 | hybrid, Q8 | 136.12 | 136.04 | −0.1% |
| Gemma4-E4B Q8_0 | dense, Q8 | 90.04 | 90.09 | +0.1% |
| Qwen3.5-9B Q5_K_M | dense, Q5_K | 86.31 | 86.50 | +0.2% |

Prefill (pp512) was measured for the Q8/IQ4 trio and is **flat off-vs-on** (≤0.2%): int-dot
does not touch the prefill path on a coopmat build (prefill stays on the coopmat fp16 GEMM;
int-dot only swaps the decode GEMV kernel). Within-run stddev was ≤0.6 t/s everywhere, and
the two warm reps per state agree to <0.3% — these deltas are real, not noise.

## Read

The int8 dot-product **decode GEMV kernel is simply slower than the coopmat / dequant→fp16
path** for our quants on this GPU+driver. The penalty scales with how much of decode is
weight mat-vec: the big **MoE Q4_K** models (Qwen3-30B-2507, Gemma4-26B, LFM2.5) lose
5–7.4%; small **dense Q8** models (Nemotron, Gemma4-E4B-Q8) are flat because the int8 path
isn't selected at their shapes. **No model gains.** IQ4_XS even regresses 4% despite IQ
quants not being int8-MMQ-covered — enabling the device flag perturbs kernel selection on
the q8_0 KV-cache flash-attention path.

## What went wrong (methodology correction)

The previous version of this file, and my first pass of this sweep, reported large *gains*
(+20% to +46% decode, "+37% Nemotron"). **All of those were a warmup/run-ordering
artifact.** Each `llama-bench` invocation is a separate process that reloads the model and
starts from **idle GPU clocks**; the clock ramp outlasts llama-bench's own internal warmup,
so the **first invocation per model reads ~15–19% low**. Both earlier methodologies always
measured the *disabled* state first (cold) and the *enabled* state second (warm), manufacturing
a phantom "int-dot gain" that was really just clock ramp. The alternating `on/off/on/off`
control made it obvious:

```
Gemma4-26B-Q4_K_M:  on 83.6(cold) → off 105.5 → on 103.1 → off 104.6   (warm on≈off, not +46%)
LFM2.5-8B:          on 261(cold)  → off 318.3 → on 295.3 → off 318.2   (warm on −7%, real)
Nemotron-Q8_0:      first-cold 52→71 "(+37%)"; true warm steady-state is 136 either way (flat)
```

**Lesson for all future speed A/Bs: discard one cold warmup invocation per model, and
alternate the two states** — never measure A-cold-then-B-warm.

## Implication / recommended action

- **Disable int-dot at runtime for the Vulkan server**: set
  `GGML_VK_DISABLE_INTEGER_DOT_PRODUCT=1` in the llama-server environment (backend=vulkan).
  This recovers up to **+7.4%** decode on the main MoE (Qwen3-30B-2507) and +4–7% on the
  other MoE/Q5 models, with zero downside (flat on the rest). It changes the run fingerprint,
  so re-run the speed benches afterward.
- The modern-glslc build work (README → "GPU host: building llama.cpp") is **not wasted**:
  it's what made `int dot: 1` available so we could A/B it rigorously, and a different
  GPU/driver (or a future RADV kernel) may flip the sign. But on *this* RX 7900 XT + RADV +
  KHR_coopmat stack, the right operational choice is int-dot **off**. The README's framing of
  int-dot as a "decode-throughput win" should be softened to "build-time *available*, but
  measured neutral-to-negative here — disabled at runtime; see results/int-dot-impact.md."
