# Backend A/B — vulkan vs rocm

Host `llm2` · KV `q8_0` · reps 3 · p=512,4096 · n=128 · vulkan int-dot `off` · warmup discarded. t/s; Δ = rocm vs vulkan.

| Model | pp512 vk | pp512 rocm | pp512 Δ | pp4096 vk | pp4096 rocm | pp4096 Δ | tg128 vk | tg128 rocm | tg128 Δ |
| :--- | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: |
| Qwen3-Coder-30B Q4_K_XL | 2258 | 1659 | -26.5% | 1863 | 734 | -60.6% | 151 | 88 | -41.8% |
| Qwen3-30B-2507 Q4_K_XL | 2319 | 1679 | -27.6% | 1810 | 739 | -59.2% | 151 | 88 | -41.7% |
| Qwen3.6-35B IQ4_XS | 2181 | 2262 | +3.7% | 2022 | 1599 | -20.9% | 53 | 85 | +60.0% |
| Nemotron-3-Nano-4B Q8_0 | 3767 | 3588 | -4.7% | 3600 | 2729 | -24.2% | 71 | 119 | +66.5% |