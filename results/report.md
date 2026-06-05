# LLM Benchmark Report

Generated from `llm-benchmarks-rose-rx7900xt-vulkan-20260605-095301.csv` — 552 result rows across 40 bench types.

## triage

### backend=vulkan

| Model | Think | Score | Halls | JSON fail | tok/s | VRAM | Status |
|---|---|---|---|---|---|---|---|
| gemma-4-E4B-it-Q5_K_M--nothi | no_think | 90.1 | 6 | 0 | 82.1 | 5516 MiB | ok |
| Qwen3-14B-Q5_K_M--think | think | 90.0 | 0 | 0 | 58.9 | 12719 MiB | ok |
| gemma-4-E4B-it-Q5_K_M--think | think | 90.0 | 0 | 0 | 100.7 | 5524 MiB | ok |
| Qwen3.6-35B-A3B-UD-IQ4_XS--think | think | 89.4 | 0 | 0 | 143.4 | 20432 MiB | ok |
| gemma-4-12b-it-Q5_K_M--think | think | 89.4 | 0 | 0 | 53.5 | 10640 MiB | ok |
| gemma-4-26B-A4B-it-UD-Q4_K_M--think | think | 89.2 | 0 | 0 | 99.4 | 18717 MiB | ok |
| Qwen3-30B-A3B-Instruct-2507-IQ4_XS | n/a | 88.3 | 6 | 0 | 117.1 | 20113 MiB | ok |
| Qwen3.6-35B-A3B-UD-IQ4_XS--nothi | no_think | 88.2 | 7 | 0 | 98.1 | 20432 MiB | ok |
| Qwen3-Coder-30B-A3B-Instruct-UD-Q4_K_XL | n/a | 87.8 | 7 | 0 | 106.9 | 19884 MiB | ok |
| gemma-4-E4B-it-Q8_0--think | think | 87.5 | 0 | 0 | 84.0 | 7102 MiB | ok |
| gemma-4-E4B-it-Q8_0--nothi | no_think | 87.0 | 7 | 0 | 74.0 | 7094 MiB | ok |
| Qwen3-30B-A3B-Instruct-2507-UD-Q4_K_XL | n/a | 86.7 | 7 | 0 | 126.6 | 20374 MiB | ok |
| gemma-4-26B-A4B-it-UD-Q4_K_M--nothi | no_think | 86.6 | 8 | 0 | 79.9 | 18717 MiB | ok |
| Qwen3.5-9B-Q5_K_M--nothi | no_think | 86.2 | 8 | 0 | 71.0 | 10274 MiB | ok |
| Qwen3-14B-Q5_K_M--nothi | no_think | 85.9 | 8 | 0 | 56.4 | 12716 MiB | ok |
| gemma-4-12b-it-Q5_K_M--nothi | no_think | 83.3 | 11 | 0 | 48.7 | 10636 MiB | ok |
| granite-4.0-h-tiny-Q5_K_M | n/a | 73.8 | 13 | 1 | 144.7 | 6042 MiB | ok |
| nvidia_Nemotron-3-Nano-4B-Q8_0--think | think | 66.2 | 0 | 4 | 130.8 | 4328 MiB | ok |
| nvidia_Nemotron-3-Nano-4B-Q8_0--nothi | no_think | 60.5 | 1 | 5 | 131.1 | 4328 MiB | ok |

## reasoning

### backend=vulkan

| Model | Think | Accuracy | tok/s | Status |
|---|---|---|---|---|
| Qwen3-14B-Q5_K_M--think | think | 100.0 | 59.5 | ok |
| Qwen3.6-35B-A3B-UD-IQ4_XS--think | think | 100.0 | 145.2 | ok |
| gemma-4-E4B-it-Q8_0--think | think | 100.0 | 84.6 | ok |
| gemma-4-E4B-it-Q5_K_M--think | think | 100.0 | 101.5 | ok |
| gemma-4-26B-A4B-it-UD-Q4_K_M--nothi | no_think | 100.0 | 88.3 | ok |
| gemma-4-26B-A4B-it-UD-Q4_K_M--think | think | 100.0 | 102.5 | ok |
| gemma-4-12b-it-Q5_K_M--think | think | 100.0 | 54.5 | ok |
| LFM2.5-8B-A1B-Q5_K_M | n/a | 100.0 | 250.0 | ok |
| nvidia_Nemotron-3-Nano-4B-Q8_0--think | think | 100.0 | 131.9 | ok |
| Qwen3-30B-A3B-Instruct-2507-UD-Q4_K_XL | n/a | 91.7 | 184.6 | ok |
| Qwen3-14B-Q5_K_M--nothi | no_think | 91.7 | 68.0 | ok |
| Qwen3.6-35B-A3B-UD-IQ4_XS--nothi | no_think | 91.7 | 131.2 | ok |
| gemma-4-12b-it-Q5_K_M--nothi | no_think | 91.7 | 52.7 | ok |
| nvidia_Nemotron-3-Nano-4B-Q8_0--nothi | no_think | 91.7 | 132.0 | ok |
| Qwen3.5-9B-Q5_K_M--nothi | no_think | 91.7 | 87.2 | ok |
| Qwen3-30B-A3B-Instruct-2507-IQ4_XS | n/a | 83.3 | 161.9 | ok |
| gemma-4-E4B-it-Q8_0--nothi | no_think | 83.3 | 82.5 | ok |
| gemma-4-E4B-it-Q5_K_M--nothi | no_think | 83.3 | 95.2 | ok |

## toolcalling

### backend=vulkan

| Model | Accuracy | Status |
|---|---|---|
| Qwen3-30B-A3B-Instruct-2507-UD-Q4_K_XL | 100.0 | ok |
| Qwen3-30B-A3B-Instruct-2507-IQ4_XS | 100.0 | ok |
| Qwen3-14B-Q5_K_M--nothi | 100.0 | ok |
| Qwen3-14B-Q5_K_M--think | 100.0 | ok |
| Qwen3.6-35B-A3B-UD-IQ4_XS--nothi | 100.0 | ok |
| Qwen3.6-35B-A3B-UD-IQ4_XS--think | 100.0 | ok |
| gemma-4-E4B-it-Q8_0--nothi | 100.0 | ok |
| gemma-4-E4B-it-Q8_0--think | 100.0 | ok |
| gemma-4-E4B-it-Q5_K_M--nothi | 100.0 | ok |
| gemma-4-E4B-it-Q5_K_M--think | 100.0 | ok |
| gemma-4-26B-A4B-it-UD-Q4_K_M--nothi | 100.0 | ok |
| gemma-4-26B-A4B-it-UD-Q4_K_M--think | 100.0 | ok |
| gemma-4-12b-it-Q5_K_M--nothi | 100.0 | ok |
| gemma-4-12b-it-Q5_K_M--think | 100.0 | ok |
| granite-4.0-h-tiny-Q5_K_M | 100.0 | ok |
| Qwen3.5-9B-Q5_K_M--nothi | 100.0 | ok |
| Qwen3-Coder-30B-A3B-Instruct-UD-Q4_K_XL | 90.0 | ok |
| LFM2.5-8B-A1B-Q5_K_M | 90.0 | ok |

## toolcalling_decay

### backend=vulkan

| Model | Think | Score | Status |
|---|---|---|---|
| Qwen3-14B-Q5_K_M--nothi | no_think | - | ok |

## summarization

### backend=vulkan

| Model | Think | Score | Status |
|---|---|---|---|
| Qwen3-14B-Q5_K_M--nothi | no_think | 92.2 | ok |
| Qwen3-14B-Q5_K_M--think | think | 90.0 | ok |
| Qwen3.6-35B-A3B-UD-IQ4_XS--think | think | 83.3 | ok |
| Qwen3.5-9B-Q5_K_M--nothi | no_think | 82.2 | ok |
| gemma-4-E4B-it-Q8_0--think | think | 81.1 | ok |
| Qwen3-30B-A3B-Instruct-2507-UD-Q4_K_XL | n/a | 80.0 | ok |
| Qwen3-30B-A3B-Instruct-2507-IQ4_XS | n/a | 80.0 | ok |
| gemma-4-E4B-it-Q5_K_M--think | think | 78.9 | ok |
| gemma-4-12b-it-Q5_K_M--nothi | no_think | 77.8 | ok |
| Qwen3-Coder-30B-A3B-Instruct-UD-Q4_K_XL | n/a | 75.6 | ok |
| LFM2.5-8B-A1B-Q5_K_M | n/a | 75.6 | ok |
| gemma-4-26B-A4B-it-UD-Q4_K_M--think | think | 74.4 | ok |
| gemma-4-26B-A4B-it-UD-Q4_K_M--nothi | no_think | 72.2 | ok |
| Qwen3.6-35B-A3B-UD-IQ4_XS--nothi | no_think | 71.1 | ok |
| gemma-4-E4B-it-Q5_K_M--nothi | no_think | 71.1 | ok |
| nvidia_Nemotron-3-Nano-4B-Q8_0--think | think | 67.2 | ok |
| gemma-4-E4B-it-Q8_0--nothi | no_think | 66.7 | ok |
| gemma-4-12b-it-Q5_K_M--think | think | 66.7 | ok |
| granite-4.0-h-tiny-Q5_K_M | n/a | 64.2 | ok |
| nvidia_Nemotron-3-Nano-4B-Q8_0--nothi | no_think | 9.2 | ok |

## maxctx

### backend=vulkan

| Model | Max ctx (tokens) | ≈ chars | VRAM MiB |
|---|---|---|---|
| Qwen3.6-35B-A3B-UD-IQ4_XS | 182272 | 729,088 | 20432 |
| Qwen3.5-9B-Q5_K_M | 161792 | 647,168 | 10267 |
| gemma-4-12b-it-Q5_K_M | 129024 | 516,096 | 10632 |
| gemma-4-E4B-it-Q8_0 | 126976 | 507,904 | 7083 |
| gemma-4-E4B-it-Q5_K_M | 126976 | 507,904 | 5505 |
| gemma-4-26B-A4B-it-UD-Q4_K_M | 126976 | 507,904 | 18710 |
| granite-4.0-h-tiny-Q5_K_M | 126976 | 507,904 | 6039 |
| granite-4.0-h-tiny-Q5_K_M | 126976 | 507,904 | 6039 |
| LFM2.5-8B-A1B-Q5_K_M | 108544 | 434,176 | 7083 |
| Qwen3-30B-A3B-Instruct-2507-UD-Q4_K_XL | 79872 | 319,488 | 20371 |
| Qwen3-30B-A3B-Instruct-2507-IQ4_XS | 79872 | 319,488 | 20109 |
| Qwen3-Coder-30B-A3B-Instruct-UD-Q4_K_XL | 63488 | 253,952 | 19877 |
| Qwen3-Coder-30B-A3B-Instruct-UD-Q4_K_XL | 63488 | 253,952 | 19877 |
| Qwen3-14B-Q5_K_M | 30720 | 122,880 | 12709 |
| nvidia_Nemotron-3-Nano-4B-Q8_0 | 14336 | 57,344 | 4320 |
| nvidia_Nemotron-3-Nano-4B-Q8_0 | 14336 | 57,344 | 4320 |
