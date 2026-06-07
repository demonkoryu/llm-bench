# KV-cache-quant sweep — rocm / RDNA3

Host `llm2` · backend `rocm` · int-dot `n/a` · reps 2 · p=512 · n=128 · depth=0,16384 · `-fa 1 -ngl 99`. t/s; Δ vs `q8_0` (production).

> Symmetric f16 / q8_0 / q4_0 span the precision range. `q8_0/q4_0` is the **asymmetric** probe — if its decode collapses vs the symmetric states, the flash-attention kernel de-fused on RADV (the documented CUDA/HIP behaviour).

## Qwen3.6-35B IQ4_XS

| KV state | pp512@d0 | tg128@d0 | tg128@d16384 | Δ tg128@d16384 vs q8_0 |
| :--- | ---: | ---: | ---: | ---: |
| f16 | 2267 | 89 | 82 | +6.1% |
| **q8_0** | 2277 | 85 | 77 | +0.0% |
| q4_0 | 2260 | 84 | 66 | -14.5% |
| q8_0/q4_0 | 1446 | 82 | 32 | -58.4% |
| q4_0/q8_0 | 1464 | 82 | 32 | -58.2% |

## Gemma4-12B Q5_K_M

| KV state | pp512@d0 | tg128@d0 | tg128@d16384 | Δ tg128@d16384 vs q8_0 |
| :--- | ---: | ---: | ---: | ---: |
| f16 | 1380 | 52 | 49 | +11.5% |
| **q8_0** | 1365 | 47 | 44 | +0.0% |
| q4_0 | 1366 | 45 | 42 | -5.5% |
| q8_0/q4_0 | 411 | 40 | 16 | -63.2% |
| q4_0/q8_0 | 388 | 39 | 15 | -65.4% |
