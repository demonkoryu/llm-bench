# LLM Benchmark Report

Generated from `llm-benchmarks-rose-rx7900xt-vulkan-20260605-203524.csv` — 92 result rows across 13 bench types.

## triage

### backend=vulkan

| Model | Think | Score | Halls | JSON fail | tok/s | VRAM | Status |
|---|---|---|---|---|---|---|---|
| Qwen3-30B-A3B-Instruct-2507-UD-Q4_K_XL | n/a | 88.8 | 6 | 0 | 111.1 | 20004 MiB | ok |
| Qwen3-Coder-30B-A3B-Instruct-UD-Q4_K_XL | n/a | 87.8 | 7 | 0 | 104.0 | 19983 MiB | ok |
| gemma-4-26B_q4_0-it--nothi | no_think | 86.0 | 9 | 0 | 93.7 | 15974 MiB | ok |
| Qwen3-30B-A3B-Instruct-2507-IQ4_XS | n/a | 84.7 | 8 | 0 | 116.4 | 19139 MiB | ok |
| gemma-4-12b-it-qat-q4_0--nothi | no_think | 84.0 | 10 | 0 | 52.8 | 8940 MiB | ok |
| granite-4.0-h-tiny-Q5_K_M | n/a | 73.8 | 13 | 1 | 145.5 | 6075 MiB | ok |

## reasoning

### backend=vulkan

| Model | Think | Accuracy | tok/s | Status |
|---|---|---|---|---|
| gemma-4-12b-it-qat-q4_0--nothi | no_think | 100.0 | 58.2 | ok |
| gemma-4-26B_q4_0-it--nothi | no_think | 100.0 | 90.9 | ok |
| LFM2.5-8B-A1B-Q5_K_M | n/a | 100.0 | 249.9 | ok |
| Qwen3-30B-A3B-Instruct-2507-UD-Q4_K_XL | n/a | 91.7 | 152.9 | ok |
| Qwen3-30B-A3B-Instruct-2507-IQ4_XS | n/a | 83.3 | 163.3 | ok |

## toolcalling

### backend=vulkan

| Model | Accuracy | Status |
|---|---|---|
| Qwen3-30B-A3B-Instruct-2507-UD-Q4_K_XL | 100.0 | ok |
| Qwen3-30B-A3B-Instruct-2507-IQ4_XS | 100.0 | ok |
| gemma-4-12b-it-qat-q4_0--nothi | 100.0 | ok |
| gemma-4-26B_q4_0-it--nothi | 100.0 | ok |
| granite-4.0-h-tiny-Q5_K_M | 100.0 | ok |
| Qwen3-Coder-30B-A3B-Instruct-UD-Q4_K_XL | 80.0 | ok |
| LFM2.5-8B-A1B-Q5_K_M | 80.0 | ok |

## summarization

### backend=vulkan

| Model | Think | Score | Status |
|---|---|---|---|
| Qwen3-30B-A3B-Instruct-2507-IQ4_XS | n/a | 85.6 | ok |
| Qwen3-30B-A3B-Instruct-2507-UD-Q4_K_XL | n/a | 83.3 | ok |
| gemma-4-12b-it-qat-q4_0--nothi | no_think | 83.3 | ok |
| Qwen3-Coder-30B-A3B-Instruct-UD-Q4_K_XL | n/a | 75.6 | ok |
| gemma-4-26B_q4_0-it--nothi | no_think | 74.4 | ok |
| granite-4.0-h-tiny-Q5_K_M | n/a | 64.2 | ok |
| LFM2.5-8B-A1B-Q5_K_M | n/a | 53.6 | ok |

## maxctx

### backend=vulkan

| Model | Max ctx (tokens) | ≈ chars | VRAM MiB |
|---|---|---|---|
| gemma-4-26B_q4_0-it | 131072 | 524,288 | 16376 |
| LFM2.5-8B-A1B-Q5_K_M | 131072 | 524,288 | 7311 |
| granite-4.0-h-tiny-Q5_K_M | 131072 | 524,288 | 6072 |
| gemma-4-12b-it-qat-q4_0 | 102400 | 409,600 | 8936 |
| Qwen3-Coder-30B-A3B-Instruct-UD-Q4_K_XL | 65536 | 262,144 | 19977 |
| Qwen3-30B-A3B-Instruct-2507-UD-Q4_K_XL | 65536 | 262,144 | 20001 |
| Qwen3-30B-A3B-Instruct-2507-IQ4_XS | 65536 | 262,144 | 19135 |
