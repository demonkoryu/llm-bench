# Backend A/B — vulkan vs rocm

Host `llm2` · KV `q8_0` · reps 3 · p=512,4096 · n=128 · vulkan int-dot `off` · warmup discarded. t/s; Δ = rocm vs vulkan.

| Model | pp512 vk | pp512 rocm | pp512 Δ | pp4096 vk | pp4096 rocm | pp4096 Δ | tg128 vk | tg128 rocm | tg128 Δ |
| :--- | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: |
| Qwen3-Coder-30B Q4_K_XL | 2276 | 1658 | -27.2% | 1878 | 742 | -60.5% | 151 | 88 | -41.6% |
| Qwen3-30B-2507 Q4_K_XL | 2327 | 1691 | -27.3% | 1816 | 741 | -59.2% | 151 | 88 | -41.7% |
| Qwen3-30B-2507 IQ4_XS | 2231 | 1832 | -17.9% | 1762 | 766 | -56.5% | 132 | 113 | -14.2% |
| Qwen3-14B Q5_K_M | 1197 | 1205 | +0.7% | 1064 | 605 | -43.1% | 61 | 52 | -15.2% |
| Qwen3.5-9B Q5_K_M | 2000 | 2335 | +16.8% | 1922 | 1772 | -7.8% | 86 | 74 | -14.7% |
| Qwen3.6-35B IQ4_XS | 2195 | 2260 | +3.0% | 2030 | 1606 | -20.9% | 53 | 85 | +60.2% |
| Gemma4-E4B Q8_0 | 3518 | 3292 | -6.4% | 3282 | 2682 | -18.3% | 90 | 68 | -24.1% |
| Gemma4-E4B Q5_K_M | 3357 | 3083 | -8.2% | 3127 | 2536 | -18.9% | 110 | 84 | -23.3% |
| Gemma4-26B Q4_K_M | 2361 | 2131 | -9.8% | 2105 | 1435 | -31.8% | 106 | 70 | -33.9% |
| Gemma4-12B Q5_K_M | 1368 | 1370 | +0.1% | 1250 | 912 | -27.0% | 56 | 47 | -15.1% |
| Gemma4-12B QAT q4_0 | 1502 | 1505 | +0.2% | 1361 | 986 | -27.6% | 62 | 55 | -11.4% |
| Gemma4-26B QAT q4_0 | 2508 | 2273 | -9.4% | 2235 | 1487 | -33.5% | 126 | 82 | -34.8% |
| Gemma4-12B QAT UD-Q4_K_XL | 1499 | 1523 | +1.6% | 1354 | 965 | -28.7% | 64 | 56 | -12.2% |
| Gemma4-26B QAT UD-Q4_K_XL | 2504 | 2297 | -8.3% | 2228 | 1506 | -32.4% | 130 | 83 | -36.4% |
| LFM2.5-8B Q5_K_M | 5827 | 6736 | +15.6% | 5596 | 6612 | +18.2% | 322 | 228 | -29.0% |
| Granite-4-H-Tiny Q5_K_M | 812 | 4156 | +411.8% | 821 | 3834 | +367.1% | 187 | 121 | -35.0% |
| Nemotron-3-Nano-4B Q8_0 | 3753 | 3591 | -4.3% | 3586 | 2729 | -23.9% | 71 | 118 | +66.5% |

> Δ is **rocm relative to vulkan**: negative ⇒ vulkan faster, positive ⇒ rocm faster.
> All vulkan rows use **int-dot off** (production config). Each row discards a full `-r 3`
> warmup, then measures `-r 3`; within-run stddev was ≤0.7 t/s and the 4 slow-ramping big
> models (both 30B Qwens, Qwen3.6-35B, Nemotron) were independently re-measured and
> reproduced to <0.5% — these deltas are solid.

## Read — keep **vulkan** as the default; 3 models want **rocm**

**Decode (tg128): vulkan wins 15 of 17**, by 11–42% — the MoE Q4_K models most (Qwen3-30B
class −42%, Gemma4-26B −34 to −36%). **Two models flip to rocm**, and the flip is real
(reproduced, sd ≈ 0.01):
- **Qwen3.6-35B IQ4_XS — rocm +60% decode** (vk 53 → rocm 85). The IQ4 MTP model is vulkan's
  worst decode performer; rocm's native int8 MMQ handles IQ4_XS far better.
- **Nemotron-3-Nano-4B Q8_0 — rocm +66% decode** as measured here (vk 71 → rocm 118). Caveat:
  vulkan's Nemotron decode is unusually sensitive to a preceding long prefill — *isolated*
  decode (no pp4096 in the same process) measures **136 t/s**, above rocm. So the verdict for
  Nemotron depends on workload: rocm is steadier under decode-after-long-prefill, vulkan is
  faster for short-context decode. Confirm with the production speed bench before switching.

**Prefill (pp4096): vulkan wins almost everywhere, often hugely** — rocm's long-context
prefill collapses (Qwen3-30B rocm 740 vs vk ~1850, −60%; Gemma4-26B −32%). This is the
Vulkan `-ub 2048` advantage. **Exceptions where rocm prefills faster:**
- **Granite-4-H-Tiny — rocm +412% pp512 / +367% pp4096** (vk 812 vs rocm 4156). Vulkan
  prefill on this hybrid (mamba/SSM) is badly broken-slow; rocm is ~5× faster. But vulkan
  still wins its *decode* (+35%). Net: rocm for prefill-heavy (long-doc) use, vulkan for
  decode-heavy.
- **LFM2.5-8B — rocm +16–18% prefill**, but vulkan wins decode +29%.

### Bottom line
- **Default stays vulkan** (int-dot off): best decode for 15/17 and best long-context
  prefill for most of the fleet.
- **Consider rocm for**: **Qwen3.6-35B IQ4_XS** (rocm wins both decode and is competitive on
  prefill — the clearest backend switch), and **Granite-4-H-Tiny** if its workload is
  prefill-dominated (5× prefill, at the cost of −35% decode).
- **Nemotron**: workload-dependent; verify on the production speed bench.
- The pp4096 collapse on rocm is the single biggest backend axis — any model that prefills
  long contexts strongly prefers vulkan.

*Method note:* `llama-bench -fa 1 -ngl 99 -ctk/ctv q8_0 -p 512,4096 -n 128 -r 3`, one
discarded warmup per (model, backend). The earlier int-dot sweep's warmup-confound lesson
(results/int-dot-impact.md) applies here too — that's why the warmup discard is mandatory.