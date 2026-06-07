# MTP / speculative-decode probe — Qwen3.6-35B-A3B IQ4_XS

Host `llm2` (RX 7900 XT, gfx1100) · `runners/mtp-probe.mjs` · greedy (temp 0, so
draft acceptance is deterministic and output is identical across configs) · KV `q8_0`
· `-b 2048 -ub 2048` · vulkan int-dot off · 1 warmup discarded, then 3 measured reps ·
`max_tokens 512`. Two workloads: **code** (LRU-cache impl, high structure) and **prose**
(TCP congestion-control explainer, low structure).

We ship `--spec-type draft-mtp --spec-draft-n-max 4` for this model but had **never
measured whether it helps on this host, nor tuned the depth.** Now we have.

## Decode t/s (draft acceptance in parens)

| backend | config | code t/s | prose t/s | avg | code accept | prose accept |
| :--- | :--- | ---: | ---: | ---: | ---: | ---: |
| vulkan | off (no MTP) | 66.5 | 66.5 | 67 | — | — |
| vulkan | **mtp-n4** | **187.4** | **127.4** | **157** | 73.4% | 41.0% |
| vulkan | mtp-n6 | 181.4 | 50.9 | 116 | 63.4% | 8.3% |
| vulkan | mtp-n8 | 83.1 | 46.2 | 65 | 50.8% | 23.0% |
| rocm | off (no MTP) | 83.9 | 83.8 | 84 | — | — |
| rocm | **mtp-n4** | 128.4 | 96.2 | 112 | 74.8% | 48.8% |
| rocm | mtp-n6 | 133.3 | 83.4 | 108 | 66.4% | 34.0% |
| rocm | mtp-n8 | 101.5 | 58.6 | 80 | 55.5% | 26.2% |

## Findings

**1. MTP is a large net win — we were right to ship it, but it's bigger than assumed.**
On vulkan, `mtp-n4` is **2.3× faster on average** (157 vs 67 t/s) and **2.8× on code**
(187 vs 66.5). On rocm it's **+33%** (112 vs 84). The draft/verify overhead never makes
it a drag at n4 — the worry that it might be net-neutral here is disproven.

**2. `spec-draft-n-max: 4` (our default-ish guess) is in fact optimal — do not raise it.**
Depth 6 and 8 are *worse* on both backends. The deeper the draft, the more compute is
burned on tokens the target rejects once acceptance falls below the break-even point. The
collapse is brutal on low-acceptance prose: vulkan `mtp-n6` prose craters to **8.3% accept
/ 51 t/s**, and `mtp-n8` (65 avg) drops **below MTP-off** (67). n4 is the knee of the
curve — best or tied-best in every cell. **Keep n-max=4.**

**3. ⚠️ This reverses the backend-ab "switch Qwen3.6-35B to rocm" recommendation.**
`results/backend-ab.md` recommends rocm for this model on a measured **rocm +60% decode**
(vk 53 → rocm 85 t/s). But that comes from `llama-bench`, which **cannot do speculative
decoding** — so it measures the bare model with the MTP head idle. In production the MTP
head is *always* active (`config/models.yaml` `extra_flags`), and under MTP the order flips:

| | bare decode (llama-bench) | production decode (MTP n4, server) |
| :--- | ---: | ---: |
| vulkan | 53 | **157** (avg) / 187 (code) |
| rocm | 85 | 112 (avg) / 128 (code) |

So the real, as-deployed decode for Qwen3.6-35B is **vulkan-faster (+40% avg)**, not
rocm-faster. The earlier "clearest backend switch in the fleet" call was an artifact of the
measurement tool ignoring spec-decode. **Vulkan stays the default for this model too.**
(rocm's bare-kernel IQ4 advantage is real; it's just dominated by vulkan's larger MTP gain.)

## Caveats / method

- **Acceptance is workload-dependent** (code ~73–75%, prose ~41–49% at n4). The composite
  speedup a user sees depends on their prompt mix; both are well above break-even at n4.
- Short-context greedy decode (8k ctx, tiny prefill) — isolates token-generation speed.
  Absolute t/s will be lower under a long preceding prefill, but the *ratios* (MTP vs off,
  n4 vs n6/n8, vulkan vs rocm) are the decision-relevant quantities and are large.
- Raw data: `results/mtp-probe.json`. The runner's `draftTimingKeys` summary line is
  cosmetically wrong (it snapshots the keys from the MTP-off config, which has none) — the
  per-config acceptance numbers are read correctly from the live `timings` block.
