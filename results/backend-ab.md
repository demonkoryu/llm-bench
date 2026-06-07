# Backend A/B — vulkan vs rocm

Host `llm2` · KV `q8_0` · reps 3 · p=512,4096 · n=128 · `-b 2048 -ub 2048` (production) · vulkan int-dot `off` · warmup discarded. t/s; Δ = rocm vs vulkan.

| Model | pp512 vk | pp512 rocm | pp512 Δ | pp4096 vk | pp4096 rocm | pp4096 Δ | tg128 vk | tg128 rocm | tg128 Δ |
| :--- | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: |
| Qwen3-Coder-30B Q4_K_XL | 2248 | 1644 | -26.9% | 2415 | 862 | -64.3% | 151 | 88 | -41.9% |
| Qwen3-30B-2507 Q4_K_XL | 2310 | 1677 | -27.4% | 2425 | 861 | -64.5% | 151 | 88 | -41.7% |
| Qwen3-30B-2507 IQ4_XS | 2216 | 1813 | -18.2% | 2342 | 878 | -62.5% | 132 | 114 | -13.8% |
| Qwen3-14B Q5_K_M | 1198 | 1206 | +0.7% | 1076 | 651 | -39.5% | 61 | 52 | -15.0% |
| Qwen3.5-9B Q5_K_M | 1996 | 2307 | +15.6% | 2041 | 1957 | -4.1% | 86 | 74 | -14.6% |
| Qwen3.6-35B IQ4_XS | 2193 | 2273 | +3.7% | 2826 | 2150 | -23.9% | 53 | 85 | +59.8% |
| Gemma4-E4B Q8_0 | 3538 | 3301 | -6.7% | 3512 | 2235 | -36.4% | 90 | 68 | -24.3% |
| Gemma4-E4B Q5_K_M | 3354 | 2994 | -10.7% | 3355 | 2096 | -37.5% | 110 | 84 | -23.7% |
| Gemma4-26B Q4_K_M | 2360 | 2124 | -10.0% | 2736 | 1383 | -49.5% | 105 | 70 | -33.0% |
| Gemma4-12B Q5_K_M | 1369 | 1365 | -0.3% | 1300 | 761 | -41.5% | 56 | 47 | -15.1% |
| Gemma4-12B QAT q4_0 | 1503 | 1502 | -0.1% | 1430 | 798 | -44.2% | 62 | 55 | -10.9% |
| Gemma4-26B QAT q4_0 | 2513 | 2265 | -9.9% | 2854 | 1402 | -50.9% | 126 | 82 | -34.8% |
| Gemma4-12B QAT UD-Q4_K_XL | 1502 | 1507 | +0.3% | 1427 | 798 | -44.1% | 64 | 56 | -12.3% |
| Gemma4-26B QAT UD-Q4_K_XL | 2510 | 2261 | -9.9% | 2858 | 1403 | -50.9% | 130 | 83 | -36.4% |
| LFM2.5-8B Q5_K_M | 5813 | 6737 | +15.9% | 7221 | 9163 | +26.9% | 282 | 229 | -18.9% |
| Granite-4-H-Tiny Q5_K_M | 805 | 4142 | +414.4% | 5971 | 4690 | -21.5% | 186 | 121 | -35.1% |
| Nemotron-3-Nano-4B Q8_0 | 3765 | 3578 | -5.0% | 3871 | 2925 | -24.4% | 71 | 119 | +66.7% |

> Δ is **rocm relative to vulkan**: negative ⇒ vulkan faster, positive ⇒ rocm faster.
> All rows use **production batch sizing** `-b 2048 -ub 2048` (config/models.yaml
> `defaults.extra_flags`) and vulkan **int-dot off**. Each row discards a full `-r 3`
> warmup, then measures `-r 3`. Qwen3.5-9B's decode row was independently re-measured
> after the fleet pass (see the methodology note) — the rest are single-pass.

## ⚠️ This supersedes the earlier `-ub 512` table

The first version of this A/B ran `llama-bench` at its default `-ub 512`. **Production
never uses 512** — `start-server.sh` + `defaults.extra_flags` set `-ub 2048` on every
model (the prefill-ubatch-throttle fix, which recovers 4–10× Vulkan prefill). Measuring
the backends at 512 made the *prefill* columns fiction. This table is the corrected,
production-faithful comparison. The decode (tg128) column is unaffected by ubatch and
is unchanged from before.

## Read — keep **vulkan** as the default

**Decode (tg128): vulkan wins 15 of 17**, by 11–42% — the Q4_K MoEs most (Qwen3-30B class
−42%, Gemma4-26B −33 to −36%). **Two models flip to rocm:**
- **Qwen3.6-35B IQ4_XS — rocm +60% decode** (vk 53 → rocm 85). The IQ4 MTP model is vulkan's
  worst decoder; rocm's int8 MMQ handles IQ4_XS far better. This is the clearest backend
  switch in the fleet — rocm wins decode *and* its pp4096 is only −24% (vk's prefill is so
  strong here that −24% still leaves rocm at a usable 2150 t/s).
- **Nemotron-3-Nano-4B Q8_0 — rocm +66% decode** as measured (vk 71 → rocm 119). Caveat
  unchanged: vulkan Nemotron decode is unusually sensitive to a preceding long prefill —
  *isolated* short-context decode measures ~136 t/s, above rocm. Verdict is workload-
  dependent; confirm on the production speed bench before switching.

**Prefill (pp4096): vulkan wins 16 of 17 at production batch sizing.** The single rocm
prefill win is **LFM2.5-8B (+27%)**. Everything else prefers vulkan, and the MoE deficits
on rocm are large and **genuine** (not a measurement artifact — see below): Qwen3-30B class
**−64%**, Gemma4-26B **−50%**, Gemma4-12B **−42 to −44%**.

### The rocm prefill collapse is real — and not flag-fixable

At `-ub 2048` the long-context (pp4096) gap *widens* vs the old `-ub 512` table (Qwen3-30B
−59% → −64%): the bigger ubatch lifts **both** backends, but vulkan benefits far more, so
rocm falls further behind. Two candidate fixes were tested on the worst model
(Qwen3-Coder-30B) and **neither recovers it**:
- **`-ub 2048` vs `-ub 512`** — vulkan pp4096 1863 → 2441 (+31%), rocm 734 → 862 (+17%).
  Helps rocm a little, vulkan a lot. Net: collapse worse, not better.
- **`ROCBLAS_USE_HIPBLASLT=1`** — pp512 1680 → 1620, pp4096 857 → 853, tg128 87.4 → 87.4.
  Flat-to-negative. llama.cpp's HIP backend runs its own MMQ/HIP prefill kernels, not
  rocBLAS GEMM, so the hipBLASLt routing env never engages. (hipBLASLt *is* linked into
  the binary; it's simply not on the prefill path.)

The collapse is a property of llama.cpp's ROCm prefill kernels on gfx1100 (RDNA3), not a
config we're leaving on the table. The practical mitigation is the one already in place:
**vulkan is the default and has no collapse** (its pp4096 is the fleet's strongest).

### Retraction: Granite is **not** a rocm-prefill win

The old table had Granite-4-H-Tiny at **rocm +412% pp512 / +367% pp4096** and recommended
rocm for prefill-heavy Granite workloads. **That was a `-ub 512` artifact.** At production
`-ub 2048`, vulkan Granite pp4096 jumps **821 → 5971 t/s (7.3×)** and now **beats rocm
(4690, −21.5%)**. Granite's vulkan prefill was never broken — it was just the throttle
hitting this hybrid (mamba/SSM) hardest. The pp512 column still shows rocm far ahead
(vk 805) because Granite has a large fixed per-call cost that only amortises once the
prompt exceeds one ubatch; for any realistic long-doc prefill, **vulkan wins**. Combined
with vulkan's +35% decode, **Granite is now vulkan on both axes** — the earlier "rocm for
prefill" advice is withdrawn.

### Bottom line
- **Default stays vulkan** (int-dot off, `-ub 2048`): best decode for 15/17 and best
  long-context prefill for 16/17.
- **Switch to rocm for: Qwen3.6-35B IQ4_XS** (wins decode +60%, prefill cost tolerable) —
  the one unambiguous case. **Nemotron** remains workload-dependent (verify on the speed
  bench). **LFM2.5** is the lone rocm prefill win but loses decode −19%, so only worth it
  for a prefill-dominated LFM2.5 workload.
- **No longer recommended for rocm: Granite** (reversed — vulkan wins both at production
  batch sizing).

*Method note:* `llama-bench -fa 1 -ngl 99 -ctk/ctv q8_0 -b 2048 -ub 2048 -p 512,4096 -n 128
-r 3`, one discarded `-r 3` warmup per (model, backend). The warmup-confound lesson
(results/int-dot-impact.md) applies — that's why the warmup discard is mandatory. During
the fleet pass two hybrids (Qwen3.5-9B, LFM2.5) showed run-to-run decode noise despite the
warmup; **Qwen3.5-9B's decode was re-measured in isolation** (vulkan 86.45 ± 0.09 t/s at
both `-ub 512` and `-ub 2048`, confirming ubatch does not affect its decode and that the
fleet pass's transient 52 t/s reading was spurious) and its row reflects the clean re-run.
