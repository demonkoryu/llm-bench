# KV-cache-quant sweep — vulkan / RDNA3

Host `llm2` · backend `vulkan` · int-dot `off` · reps 2 · p=512 · n=128 · depth=0,16384 · `-fa 1 -ngl 99`. t/s; Δ vs `q8_0` (production).

> Symmetric f16 / q8_0 / q4_0 span the precision range. `q8_0/q4_0` is the **asymmetric** probe — if its decode collapses vs the symmetric states, the flash-attention kernel de-fused on RADV (the documented CUDA/HIP behaviour).

## Qwen3-30B-2507 Q4_K_XL

| KV state | pp512@d0 | tg128@d0 | tg128@d16384 | Δ tg128@d16384 vs q8_0 |
| :--- | ---: | ---: | ---: | ---: |
| f16 | 2389 | 201 | 130 | +10.8% |
| **q8_0** | 2331 | 180 | 117 | +0.0% |
| q4_0 | 2326 | 180 | 118 | +1.0% |
| q8_0/q4_0 | 2329 | 177 | 116 | -1.1% |
| q4_0/q8_0 | 2333 | 177 | 117 | -0.4% |

## Qwen3.6-35B IQ4_XS

| KV state | pp512@d0 | tg128@d0 | tg128@d16384 | Δ tg128@d16384 vs q8_0 |
| :--- | ---: | ---: | ---: | ---: |
| f16 | 2217 | 43 | 107 | +70.7% |
| **q8_0** | 2189 | 43 | 63 | +0.0% |
| q4_0 | 2179 | 43 | 79 | +26.0% |
| q8_0/q4_0 | 2191 | 43 | 70 | +11.3% |
| q4_0/q8_0 | 2195 | 43 | 70 | +11.7% |

## Gemma4-12B Q5_K_M

| KV state | pp512@d0 | tg128@d0 | tg128@d16384 | Δ tg128@d16384 vs q8_0 |
| :--- | ---: | ---: | ---: | ---: |
| f16 | 1415 | 55 | 54 | +43.0% |
| **q8_0** | 1370 | 56 | 38 | +0.0% |
| q4_0 | 1368 | 56 | 43 | +14.5% |
| q8_0/q4_0 | 1372 | 56 | 35 | -7.6% |
| q4_0/q8_0 | 1372 | 56 | 35 | -6.7% |

## LFM2.5-8B Q5_K_M

| KV state | pp512@d0 | tg128@d0 | tg128@d16384 | Δ tg128@d16384 vs q8_0 |
| :--- | ---: | ---: | ---: | ---: |
| f16 | 5941 | 331 | 266 | +0.2% |
| **q8_0** | 5885 | 321 | 266 | +0.0% |
| q4_0 | 5841 | 321 | 265 | -0.1% |
| q8_0/q4_0 | 5847 | 319 | 264 | -0.4% |
| q4_0/q8_0 | 5870 | 320 | 264 | -0.5% |
