# llm-bench

Local LLM benchmark suite for picking an **agentic fleet** on a single GPU. It measures
each model on document comprehension, coding/tool-use, speed, context length and VRAM
footprint, then ranks them by a **capability** score and a **fleet-suitability** score,
and renders an interactive, self-contained dashboard.

- **Orchestrator** — `runners/bench-run.mjs` (Node, dev host): the model × think × bench
  matrix loop. Bench modules live in `benches/` (reuse the graders in `benchmarks/*`);
  performance/capacity **probes** (`benches/probes/`) self-manage the server.
- **Inference** — a `llama.cpp` server on a GPU host, driven over SSH; system concerns
  (start/stop, VRAM, health, systemd-router coexistence) are in `runners/llamacpp-server.mjs`
  + `scripts/llm2/`.
- **Store** — a **tidy DuckDB/Parquet** dataset: `results/tidy/**/measurements.parquet`,
  one row per measured metric with every config axis (chat_template, kv_quant, quant, arch,
  finetune, llamacpp_build, sampling, think…) as a queryable column. Expensive facts
  (context ceilings, KV footprint) are memoized in `results/caps/capabilities.json`,
  keyed by (gguf, quant, kv, backend, gpu, **llamacpp_build**) so a llama.cpp upgrade
  invalidates them.
- **Analysis** — `analysis/` (fresh, tidy-native): `score.mjs` (+ `scoring-config.mjs`)
  computes capability/fleet over any filtered slice; `backfill.mjs` imports legacy
  `run.json`; `export-dashboard.mjs` snapshots the static page.
- **Config** — `config/models.yaml` (models, sampling, structured subject dims) and
  `config/hosts.yaml` (GPU host endpoints/SSH; set `SSH_HOST` if the alias doesn't resolve).

---

## 1. Running benchmarks

Prerequisites: Node ≥ 22, `npm install`, and a reachable GPU host configured in
`config/hosts.yaml` with the `llama.cpp` server scripts deployed (`npm run deploy`).

```bash
SSH_HOST=<ip> npm run bench -- --models Qwen3.6 --benches toolcalling,reasoning,triage \
    --think both --samples 1 --ctx 16384
```

The orchestrator emits **tidy Parquet** natively (plus a small run manifest under
`results/runs/<run_id>/`) and consults the capabilities cache to skip re-probing
context ceilings. Flags: `--models <substr,…>`, `--benches <name,…>`, `--think both|no_think|think`,
`--samples N` (multi-sample → per-metric mean + `spread`), `--ctx <n>`, `--target <host>`,
`--chat-template <path-on-host>` (A/B a custom template), `--keep-router` (don't stop the
host's systemd `llama-server` service).

Benches (`benches/`): `triage, reasoning, reasoning_hard, toolcalling, summarization,
docqa, coding_{multipl,hard,practical,bugfix}, agentic_loop, struct_output,
instruction_following`, plus **probes** (`benches/probes/`, self-manage the server):
`maxctx, kv_per_tok, throughput` (e2e/ttft), `speed, prefix_cache, quality_decay,
parallel_gen`.

> **Host note:** the GPU host runs a systemd `llama-server` model-router on port 8090.
> `bench-run` stops it for the run and restarts it after; it needs passwordless sudo on
> the host. Historical results are already in the store — `npm run backfill` re-imports
> any legacy `run.json`, `npm run caps-seed` re-seeds ceilings from it.

### Comparability

There's no separate "fingerprint" to reconcile any more: every measurement row carries
its own serving/platform dimensions (backend, kv_quant, flash_attn, batch/ubatch,
`llamacpp_build`, gpu, …). To compare like-for-like, filter on them; to see a config
difference, pivot on it. `llamacpp_build` (from `llama-server --version`) is captured per
run, so a silent llama.cpp upgrade shows up as a new value and invalidates the cached
context ceilings for that build.

---

## 2. Querying the store

Everything lands in the tidy Parquet dataset — analyse it any way you like, no fixed
"report" step. DuckDB reads it directly:

```bash
duckdb -c "SELECT chat_template, 100.0*sum(metric_value) FILTER(WHERE metric='toolcall_pass')
             /sum(metric_value) FILTER(WHERE metric='toolcall_total') AS pct
           FROM read_parquet('results/tidy/**/*.parquet', hive_partitioning=true)
           WHERE bench='toolcalling' GROUP BY 1"
```

Or use the app's API / the scorer (`analysis/score.mjs`) programmatically. The store never
collapses configs: two runs that differ in *any* dimension (template, quant, KV, build…)
are distinct, queryable rows — the thing the old `model|think|bench` merge couldn't do.

---

## 3. The dashboard

A **unified explorer**: a facet rail (filter by any dimension) driving four views —
**Pivot** (A/B any axis with Δ), **Pareto** (quality vs throughput, for dense-vs-MoE),
**Leaderboard** (capability/fleet with weight dials), **Coverage** (run vs not).

```bash
npm run dashboard            # local interactive app (Node + DuckDB) → http://localhost:5178
npm run dashboard:export     # snapshot a self-contained results/dashboard.html (static)
```

- **Local app** — live DuckDB querying, richest interactivity. Run it while iterating.
- **Static export** — one self-contained HTML (data + scorer + engine inlined; faceting
  runs client-side). Published to **<https://pages.xor0.de/llm-bench/>** and mobile-friendly:
  a push to `main` that changes `results/dashboard.html` redeploys via Forgejo Actions →
  the `pages` branch → Caddy. Regenerate with `dashboard:export` before pushing.

---

## GPU host: building `llama.cpp` (ROCm + Vulkan)

The orchestrator drives a `llama.cpp` server on the GPU host over SSH; the host carries
**two** builds, switched with `run-suite --backend <vulkan|rocm>`. This section is the
source of truth for reproducing them (e.g. in Docker). Reference hardware: **AMD RX 7900
XT** (`gfx1100`, RDNA3, 20 GiB), Ubuntu 24.04, ROCm 7.2.3, Mesa/RADV 25.2. Tested against
llama.cpp `ggml-org/llama.cpp` @ commit **`a121232fd`**.

```bash
git clone https://github.com/ggml-org/llama.cpp && cd llama.cpp
```

### ROCm build (`build-rocm/`)

```bash
export PATH=/opt/rocm/bin:$PATH
HIPCXX=/opt/rocm/bin/amdclang++ cmake -S . -B build-rocm \
  -DGGML_HIP=ON -DAMDGPU_TARGETS=gfx1100 -DCMAKE_BUILD_TYPE=Release -DLLAMA_CURL=ON
cmake --build build-rocm --config Release -j"$(nproc)" --target llama-server llama-bench llama-cli
```

For `gfx1100`, `-DGGML_HIP=ON` **auto-enables** the RDNA3 fast paths — you do not pass them
explicitly, but verify they landed in `build-rocm/CMakeCache.txt`:
`GGML_HIP_ROCWMMA_FATTN=ON` (WMMA flash-attention), `GGML_HIP_GRAPHS=ON`,
`GGML_HIP_MMQ_MFMA=ON` (native int8 MMQ). Runtime needs the **ROCm 7.x** stack.

### Vulkan build (`build-vulkan/`) — ⚠️ needs a modern `glslc`

```bash
cmake -S . -B build-vulkan \
  -DGGML_VULKAN=ON -DGGML_NATIVE=ON -DCMAKE_BUILD_TYPE=Release \
  -DVulkan_GLSLC_EXECUTABLE=/opt/vulkan-sdk/x86_64/bin/glslc      # ← see below, do NOT omit
cmake --build build-vulkan -j"$(nproc)" --target llama-server llama-bench
```

**The `glslc` version is load-bearing for whether int-dot is even _available_.**
llama.cpp's int8 dot-product path is gated at _build time_ on a CMake feature-test that
tries to compile a `GL_EXT_integer_dot_product` shader. The **stock Ubuntu 24.04 `glslc`
(shaderc 2023.8 / glslang 14) cannot compile it**, so the macro
`GGML_VULKAN_INTEGER_DOT_GLSLC_SUPPORT` is silently left undefined and the int8 path is
compiled out — the device reports `int dot: 0`, with **no error**. Use a `glslc` from a
recent **Vulkan SDK ≥ 1.3.290** (we used LunarG **1.4.350.1** → shaderc v2026.2) to get
`int dot: 1`:

> **Measured caveat — int-dot is _off_ at runtime on this host.** Having `int dot: 1`
> available let us A/B it rigorously (runtime toggle `GGML_VK_DISABLE_INTEGER_DOT_PRODUCT`).
> On this RX 7900 XT + RADV + KHR_coopmat build it is **neutral-to-negative for decode**
> (0% … −7.4% tg; prefill unaffected) — it only swaps the decode GEMV kernel, and that
> kernel is slower than the coopmat path for our quants. So we **disable it at runtime**.
> Still build with the modern glslc (a different GPU/driver may flip the sign). Full data
>
> - the warmup-confound that earlier faked a "+37% win": [`results/int-dot-impact.md`](results/int-dot-impact.md).

```bash
VER=$(curl -s https://vulkan.lunarg.com/sdk/latest/linux.txt)        # e.g. 1.4.350.1
curl -s -o sdk.tar.xz "https://sdk.lunarg.com/sdk/download/$VER/linux/vulkansdk-linux-x86_64-$VER.tar.xz"
mkdir -p /opt/vulkan-sdk && tar -xJf sdk.tar.xz -C /opt/vulkan-sdk --strip-components=1
# glslc is the prebuilt /opt/vulkan-sdk/x86_64/bin/glslc — point -DVulkan_GLSLC_EXECUTABLE at it
```

Runtime needs **Mesa/RADV ≥ 24.x** (exposes `VK_KHR_cooperative_matrix` and accelerated
integer dot for `gfx1100`). The build only needs the modern `glslc`; the Vulkan headers
and loader can stay at the distro version.

### Verify the build is optimal

A correct Vulkan build prints this device line on load (any `llama-bench`/server start):

```
ggml_vulkan: 0 = Radeon RX 7900 XT (RADV NAVI31) | fp16: 1 | int dot: 1 | matrix cores: KHR_coopmat
```

`int dot: 1` **and** `matrix cores: KHR_coopmat` must both be present — `int dot: 0` means
the glslc was too old (rebuild with a newer SDK). For ROCm, confirm
`GGML_HIP_ROCWMMA_FATTN=ON` in its CMakeCache.

### Server launch flags

The server is launched by [`scripts/llm2/start-server.sh`](scripts/llm2/start-server.sh):
`-fa on`, `--cache-type-k/v q8_0` (quantized KV), `--jinja`, `--reasoning-format auto`,
`-np 1`. Batch sizing (`-b 2048 -ub 2048`, the Vulkan prefill-throttle fix) is **not** in
the script — it is injected per-model from `config/models.yaml` `defaults.extra_flags`. See
that file's header for the rationale. For the **vulkan** backend the script also exports
`GGML_VK_DISABLE_INTEGER_DOT_PRODUCT=1` (int-dot measured net-negative for decode here —
override with `LLAMA_VK_INT_DOT=1`; see [`results/int-dot-impact.md`](results/int-dot-impact.md)).

---

## Scoring model (summary)

Defined in `shared/scoring.mjs` (pure module, shared by Node and the dashboard). Structure
is fixed in code; only the **dials** (weights/exponents) are adjustable in the UI.

- **Capability** (headline) = `coding × comprehension`.
  - **comprehension** (additive): triage/categorization, summarization, docqa, reasoning.
  - **coding** (multiplicative): hard gates `toolcalling × struct_output` × a competence
    bundle (coding grade, agentic loop, instruction following). A missing gate zeroes it.
  - Speed is **not** in capability — it informs the fleet score.
- **Fleet suitability** (geometric blend, ranks capable all-rounders that you can run many
  of):
  ```
  fleet = capability^w_cap × ctx_norm^w_ctx × slots_norm^w_slots × throughput^w_thru
  ```
  `w_cap=2` makes capability dominate; `ctx_norm` clamps main ctx at a 100k tier;
  `slots_norm` rewards how many 1-main-+-N-worker slots fit in VRAM (from measured KV/token
  - maxctx). `throughput^w_thru` is **off by default** (needs `parallel-gen`); raise the
    `w_thru` dial to weight measured aggregate tok/s.

`results/report.json` and the dashboard self-describe the formula via the `SCORING` export,
so the displayed formula can't drift from the code.

---

## Benchmark winner (2026-06-09)

**Gemma4-26B QAT q4_0 · KV q5_0 [no_think]** — fleet-suitability rank 1.

| Metric | Value |
|--------|-------|
| Model | `google/gemma-4-26B-A4B-it-qat-q4_0-gguf` / `gemma-4-26B_q4_0-it.gguf` |
| KV cache | q5_0 (symmetric for FA kernel) |
| Capability score | 80% (rank 5) |
| Fleet suitability | 0.610 (rank 1) |
| Main context | 102,400 tokens |
| Worker slots | +4 × 65,536 tokens |
| Total slots | 5 (1 main + 4 workers) |
| Weights | 14,100 MiB |
| Aggregate tok/s | 176.7 (measured parallel-gen) |

Deployed to production at `llm.local.xor0.de/v1` — see
[infra repo](https://git.xor0.de/demonkoryu/infra) `llm/` directory.

Key deployment flags: `-ngl 99 -fa on -b 2048 -ub 2048 --cache-type-k q5_0 --cache-type-v q5_0 --ctx-size 430080 -np 5 --no-mmproj --jinja --reasoning-format auto --swa-full`.

> **MTP disabled.** Gemma4 MTP with quantized KV on Vulkan gives 0% draft acceptance
> (Hadamard-rotation bug). See `results/gemma-mtp.md`.
