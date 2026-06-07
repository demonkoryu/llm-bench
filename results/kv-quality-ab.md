# KV-cache q4 vs q8 — quality · speed · VRAM (Vulkan / RDNA3)

Host `llm2` · backend `vulkan` · RX 7900 XT · ctx 49,152 · greedy (temp 0) · 5 rep(s). All three axes measured under one load per (model, KV state): **VRAM** at load (weights + full KV at this ctx), **decode t/s** from a warmup-discarded 256-token burst (production flags, so MTP is included where it applies), and **quality** = % of 6 planted integer needles correct at each context depth.

> q4_0 KV roughly halves KV bytes/token vs q8_0 → the VRAM delta is the headroom you buy. KV-quant *quality* error accumulates with context, so the regression is read at the deepest depth, not depth 0. `q8_0/q4_0` is the **asymmetric** state (K high / V low): K is the sensitive cache, so it should recover most of what symmetric `q4_0` loses while keeping ~75% of the V saving.

## Headline — q4 / asym vs q8_0 (Δ on each axis)

Quality Δ in accuracy points at the deepest shared depth; speed Δ and VRAM Δ as % change. Negative VRAM = memory saved (good); positive speed = faster.

| model | depth | Δqual q4 | Δqual asym | Δspeed q4 | Δspeed asym | ΔVRAM q4 | ΔVRAM asym |
| :--- | ---: | ---: | ---: | ---: | ---: | ---: | ---: |
| Qwen3-30B-2507 Q4_K_XL | 40k | -17 | -17 | +0.1% | -1.8% | -5.8% | -2.9% |
| Qwen3.6-35B IQ4_XS | 40k | +0 | +0 | +10.3% | +10.3% | -1.2% | -0.6% |
| Gemma4-12B Q5_K_M | 40k | +0 | +0 | -2.6% | -0.1% | -4.5% | -2.2% |
| LFM2.5-8B Q5_K_M | 40k | -3 | -17 | -3.7% | -4.0% | -2.2% | -1.1% |

## Qwen3-30B-2507 Q4_K_XL

| KV state | VRAM MiB | decode t/s | acc 0k | acc 24k | acc 40k |
| :--- | ---: | ---: | ---: | ---: | ---: |
| **q8_0** | 19715 | 167 | 67% | 83% | 83% |
| q4_0 | 18563 | 168 | 67% | 83% | 67% |
| q8_0/q4_0 | 19139 | 164 | 67% | 77% | 67% |

## Qwen3.6-35B IQ4_XS

| KV state | VRAM MiB | decode t/s | acc 0k | acc 24k | acc 40k |
| :--- | ---: | ---: | ---: | ---: | ---: |
| **q8_0** | 19499 | 150 | 67% | 67% | 67% |
| q4_0 | 19259 | 166 | 67% | 67% | 67% |
| q8_0/q4_0 | 19379 | 166 | 67% | 67% | 67% |

## Gemma4-12B Q5_K_M

| KV state | VRAM MiB | decode t/s | acc 0k | acc 24k | acc 40k |
| :--- | ---: | ---: | ---: | ---: | ---: |
| **q8_0** | 9657 | 55 | 83% | 50% | 67% |
| q4_0 | 9223 | 54 | 83% | 63% | 67% |
| q8_0/q4_0 | 9441 | 55 | 100% | 67% | 67% |

## LFM2.5-8B Q5_K_M

| KV state | VRAM MiB | decode t/s | acc 0k | acc 24k | acc 40k |
| :--- | ---: | ---: | ---: | ---: | ---: |
| **q8_0** | 6481 | 286 | 100% | 100% | 83% |
| q4_0 | 6336 | 275 | 100% | 83% | 80% |
| q8_0/q4_0 | 6408 | 274 | 100% | 87% | 67% |
