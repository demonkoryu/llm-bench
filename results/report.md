# LLM Benchmark Report

Generated from `llm-benchmarks-rose-rx7900xt-vulkan-20260604-202514.csv` — 404 result rows across 31 bench types.

## triage

### backend=vulkan

| Model | Think | Score | Halls | JSON fail | tok/s | VRAM | Status |
|---|---|---|---|---|---|---|---|
| gemma-4-26B-A4B-it-UD-Q4_K_M--think | think | 90.0 | 0 | 0 | 82.4 | 17696 MiB | ok |
| Qwen3-Coder-30B-A3B-Instruct-UD-Q4_K_XL | n/a | 89.7 | 6 | 0 | 128.3 | 19819 MiB | ok |
| gemma-4-E4B-it-Q5_K_M--nothi | no_think | 89.6 | 6 | 0 | 85.1 | 5464 MiB | ok |
| Qwen3.6-35B-A3B-UD-IQ4_XS--think | think | 89.4 | 0 | 0 | 80.5 | 18711 MiB | ok |
| gemma-4-12b-it-Q5_K_M--think | think | 89.2 | 0 | 0 | 40.5 | 8577 MiB | ok |
| Qwen3-14B-Q5_K_M--think | think | 88.6 | 0 | 0 | 59.1 | 11567 MiB | ok |
| Qwen3.6-35B-A3B-UD-IQ4_XS--nothi | no_think | 88.3 | 6 | 0 | 68.2 | 18711 MiB | ok |
| gemma-4-E4B-it-Q8_0--think | think | 88.3 | 0 | 0 | 81.2 | 7042 MiB | ok |
| gemma-4-E4B-it-Q5_K_M--think | think | 88.3 | 0 | 0 | 97.0 | 5464 MiB | ok |
| gemma-4-12b-it-Q5_K_M--nothi | no_think | 88.3 | 6 | 0 | 39.8 | 8574 MiB | ok |
| gemma-4-E4B-it-Q8_0--nothi | no_think | 87.6 | 8 | 0 | 74.3 | 7042 MiB | ok |
| Qwen3-14B-Q5_K_M--nothi | no_think | 85.9 | 8 | 0 | 57.0 | 11567 MiB | ok |
| gemma-4-26B-A4B-it-UD-Q4_K_M--nothi | no_think | 85.7 | 8 | 0 | 73.7 | 17696 MiB | ok |
| Qwen3-30B-A3B-Instruct-2507-UD-Q4_K_XL | n/a | 85.3 | 7 | 0 | 122.3 | 20044 MiB | ok |
| Qwen3-30B-A3B-Instruct-2507-IQ4_XS | n/a | 85.3 | 7 | 0 | 112.9 | 17323 MiB | ok |
| granite-4.0-h-tiny-Q5_K_M | n/a | 75.1 | 16 | 0 | 152.4 | 5534 MiB | ok |
| nvidia_Nemotron-3-Nano-4B-Q8_0--think | think | 65.4 | 0 | 4 | 70.8 | 3858 MiB | ok |
| nvidia_Nemotron-3-Nano-4B-Q8_0--nothi | no_think | 61.6 | 0 | 5 | 70.8 | 3858 MiB | ok |

## reasoning

### backend=vulkan

| Model | Think | Accuracy | tok/s | Status |
|---|---|---|---|---|
| Qwen3-14B-Q5_K_M--think | think | 100.0 | 59.8 | ok |
| Qwen3.6-35B-A3B-UD-IQ4_XS--nothi | no_think | 100.0 | 82.8 | ok |
| Qwen3.6-35B-A3B-UD-IQ4_XS--think | think | 100.0 | 82.2 | ok |
| gemma-4-E4B-it-Q8_0--think | think | 100.0 | 83.9 | ok |
| gemma-4-E4B-it-Q5_K_M--think | think | 100.0 | 101.1 | ok |
| gemma-4-26B-A4B-it-UD-Q4_K_M--nothi | no_think | 100.0 | 84.7 | ok |
| gemma-4-26B-A4B-it-UD-Q4_K_M--think | think | 100.0 | 84.7 | ok |
| LFM2.5-8B-A1B-Q5_K_M | n/a | 100.0 | 232.3 | ok |
| nvidia_Nemotron-3-Nano-4B-Q8_0--nothi | no_think | 100.0 | 71.4 | ok |
| nvidia_Nemotron-3-Nano-4B-Q8_0--think | think | 100.0 | 71.4 | ok |
| gemma-4-12b-it-Q5_K_M--nothi | no_think | 100.0 | 52.1 | ok |
| gemma-4-12b-it-Q5_K_M--think | think | 100.0 | 49.8 | ok |
| Qwen3-30B-A3B-Instruct-2507-UD-Q4_K_XL | n/a | 91.7 | 174.2 | ok |
| Qwen3-14B-Q5_K_M--nothi | no_think | 91.7 | 68.1 | ok |
| gemma-4-E4B-it-Q5_K_M--nothi | no_think | 91.7 | 103.1 | ok |
| Qwen3-30B-A3B-Instruct-2507-IQ4_XS | n/a | 83.3 | 143.7 | ok |
| gemma-4-E4B-it-Q8_0--nothi | no_think | 75.0 | 86.1 | ok |

## toolcalling

### backend=vulkan

| Model | Accuracy | Status |
|---|---|---|
| Qwen3-30B-A3B-Instruct-2507-UD-Q4_K_XL | 100.0 | ok |
| Qwen3-30B-A3B-Instruct-2507-IQ4_XS | 100.0 | ok |
| Qwen3-14B-Q5_K_M--nothi | 100.0 | ok |
| Qwen3.6-35B-A3B-UD-IQ4_XS--nothi | 100.0 | ok |
| gemma-4-E4B-it-Q8_0--nothi | 100.0 | ok |
| gemma-4-E4B-it-Q5_K_M--nothi | 100.0 | ok |
| gemma-4-26B-A4B-it-UD-Q4_K_M--nothi | 100.0 | ok |
| granite-4.0-h-tiny-Q5_K_M | 100.0 | ok |
| Qwen3-14B-Q5_K_M--think | 100.0 | ok |
| Qwen3.6-35B-A3B-UD-IQ4_XS--think | 100.0 | ok |
| gemma-4-E4B-it-Q8_0--think | 100.0 | ok |
| gemma-4-E4B-it-Q5_K_M--think | 100.0 | ok |
| gemma-4-26B-A4B-it-UD-Q4_K_M--think | 100.0 | ok |
| gemma-4-12b-it-Q5_K_M--nothi | 100.0 | ok |
| Qwen3-Coder-30B-A3B-Instruct-UD-Q4_K_XL | 90.0 | ok |
| gemma-4-12b-it-Q5_K_M--think | 80.0 | ok |
| LFM2.5-8B-A1B-Q5_K_M | 60.0 | ok |

## summarization

### backend=vulkan

| Model | Think | Score | Status |
|---|---|---|---|
| Qwen3-14B-Q5_K_M--nothi | no_think | 92.2 | ok |
| Qwen3-14B-Q5_K_M--think | think | 90.0 | ok |
| gemma-4-26B-A4B-it-UD-Q4_K_M--think | think | 82.2 | ok |
| Qwen3-Coder-30B-A3B-Instruct-UD-Q4_K_XL | n/a | 77.8 | ok |
| gemma-4-E4B-it-Q8_0--think | think | 76.7 | ok |
| gemma-4-E4B-it-Q5_K_M--think | think | 75.6 | ok |
| Qwen3.6-35B-A3B-UD-IQ4_XS--think | think | 74.4 | ok |
| gemma-4-26B-A4B-it-UD-Q4_K_M--nothi | no_think | 74.4 | ok |
| LFM2.5-8B-A1B-Q5_K_M | n/a | 73.3 | ok |
| Qwen3.6-35B-A3B-UD-IQ4_XS--nothi | no_think | 71.1 | ok |
| gemma-4-E4B-it-Q5_K_M--nothi | no_think | 71.1 | ok |
| Qwen3-30B-A3B-Instruct-2507-IQ4_XS | n/a | 70.0 | ok |
| Qwen3-30B-A3B-Instruct-2507-UD-Q4_K_XL | n/a | 68.9 | ok |
| gemma-4-E4B-it-Q8_0--nothi | no_think | 68.9 | ok |
| gemma-4-12b-it-Q5_K_M--nothi | no_think | 64.7 | ok |
| granite-4.0-h-tiny-Q5_K_M | n/a | 64.2 | ok |
| gemma-4-12b-it-Q5_K_M--think | think | 61.9 | ok |
| nvidia_Nemotron-3-Nano-4B-Q8_0--think | think | 24.4 | ok |
| nvidia_Nemotron-3-Nano-4B-Q8_0--nothi | no_think | 20.3 | ok |

## maxctx

### backend=vulkan

| Model | Max ctx (tokens) | ≈ chars | VRAM MiB |
|---|---|---|---|
| gemma-4-E4B-it-Q8_0 | 126976 | 507,904 | 5924 |
| gemma-4-E4B-it-Q5_K_M | 126976 | 507,904 | 4478 |
| granite-4.0-h-tiny-Q5_K_M | 126976 | 507,904 | 5526 |
| gemma-4-12b-it-Q5_K_M | 120832 | 483,328 | 9293 |
| Qwen3-Coder-30B-A3B-Instruct-UD-Q4_K_XL | 79872 | 319,488 | 20343 |
| Qwen3-30B-A3B-Instruct-2507-UD-Q4_K_XL | 79872 | 319,488 | 20366 |
| Qwen3.6-35B-A3B-UD-IQ4_XS | 75776 | 303,104 | 19753 |
| gemma-4-26B-A4B-it-UD-Q4_K_M | 71680 | 286,720 | 17913 |
| Qwen3-30B-A3B-Instruct-2507-IQ4_XS | 69632 | 278,528 | 19354 |
| LFM2.5-8B-A1B-Q5_K_M | 36864 | 147,456 | 6010 |
| Qwen3-14B-Q5_K_M | 30720 | 122,880 | 12251 |
| nvidia_Nemotron-3-Nano-4B-Q8_0 | 18432 | 73,728 | 3884 |
