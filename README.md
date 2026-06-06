# llm-bench

Local LLM benchmark suite for picking an **agentic fleet** on a single GPU. It measures
each model on document comprehension, coding/tool-use, speed, context length and VRAM
footprint, then ranks them by a **capability** score and a **fleet-suitability** score,
and renders an interactive, self-contained dashboard.

- **Orchestrator** — Node, runs on your dev host (benches, graders, scoring, charts).
- **Inference** — a `llama.cpp` server on a GPU host, driven over SSH; system concerns
  (start/stop, VRAM, health) are shell scripts in `scripts/llm2/`.
- **Config** — `config/models.yaml` (models, sampling, `defaults.extra_flags`) and
  `config/hosts.yaml` (GPU host endpoints/SSH). Quant is baked into each GGUF filename.

Results live in `results/` (now tracked in git): immutable run dirs under
`results/runs/<run_id>/run.json`, plus the generated `report.json`, `dashboard.html`,
and `chart`/`fleet` SV**G**/PNG.

---

## 1. Running benchmarks

Prerequisites: Node ≥ 22, `npm install`, and a reachable GPU host configured in
`config/hosts.yaml` with the `llama.cpp` server scripts deployed (`npm run deploy`).

```bash
npm run dry-run                 # print the model × think × bench matrix and exit (no GPU)
npm run bench                   # core suite (triage, reasoning, toolcalling, summarization,
                                #   docqa, coding, speed, maxctx) for every enabled model
node runners/run-suite.mjs --full   # core suite + ALL secondary runners, then rebuild report+charts
```

A **full run** chains the secondaries that feed the dashboard: `kv-probe`,
`struct-output`, `throughput-ttft`, `speed-decay`, `quality-decay`,
`instruction-following`, `prompt-cache`, `agentic-loop`.

> **Note:** `parallel-gen` (pargen) is **not** in the `--full` chain. It produces the
> `speed_pargen-*` rows that the fleet score's *throughput* term uses. Run it explicitly
> when you want measured throughput in the fleet ranking:
> ```bash
> node runners/parallel-gen.mjs --input <run-id>
> ```

Useful `run-suite` flags: `--models <substr,…>`, `--benches <name,…>`, `--skip-think`
(hybrids, no-think only), `--skip-maxctx`, `--resume` (skip combos already `ok` in the
prior run), `--target <host>`, `--backend <vulkan|rocm>`, `--debug`.

### The config marker
Every run records a readable **`environment`** fingerprint (GPU, backend, KV-cache quant,
flash-attn, ngl/np, batch/ubatch defaults, and the verbatim `start-server.sh` launch line)
— see `shared/run-fingerprint.mjs`. On start, `run-suite` compares it to the previous run
and **warns if the server config changed** (measurements across a change aren't
comparable). It is config-file derived, so it does *not* capture the llama.cpp build commit
or GPU driver — it labels runs for comparability, not bit-for-bit reproducibility.

---

## 2. Post-processing results

Each runner writes its own immutable run dir. **Consolidate** them into one checkpoint,
then build the report/dashboard from it.

```bash
npm run consolidate             # merge all runs → ONE checkpoint carrying the fingerprint
                                #   + report the coverage gap (what still needs running)
npm run report                  # results/report.json  (capability + fleet + provenance, machine-readable)
npm run dashboard               # results/dashboard.html  (interactive, self-contained)
npm run chart                   # results/chart.svg|png   (static ranking + per-metric panels)
npm run results                 # results/report.md       (human-readable tables)
node runners/fleet-analysis.mjs # results/fleet.svg|png   (static VRAM-packing tables)
```

`consolidate-checkpoint` merges deterministically (a successful measurement beats an
error, newest timestamp wins), preserves original timestamps, asserts no measurement is
dropped, then **archives** the absorbed run dirs under `results/runs/_archive/` (it never
hard-deletes — pass `--purge-delete` only if you mean it). Re-run it after a gap-fill
(e.g. after `parallel-gen`) to fold the new run back into a single checkpoint.

All consumers default to the newest run (= the checkpoint); pass `--input <run-id>` one or
more times to merge specific runs instead.

---

## 3. Showing the dashboard

**Live:** the latest dashboard is published at **<https://pages.xor0.de/llm-bench/>**
(every push to `main` that changes `results/dashboard.html` redeploys it via Forgejo
Actions → the `pages` branch → a Caddy static server).

The dashboard is the primary way to read results. It is a **single self-contained
`results/dashboard.html`** — no server, no network, no dependencies (the scoring code and
all data are inlined). Turning the weight **dials** re-ranks everything live in-browser
using the exact same scoring code as Node, so the numbers can't drift from `report.json`.

```bash
npm run dashboard               # (re)generate results/dashboard.html from the latest checkpoint
```

Then open `results/dashboard.html` in a browser (double-click, or `file://` the absolute
path). It shows: the **capability** ranking (top-5 get 1–5 star badges, carried across
every table), the **fleet-suitability** ranking (main ctx + worker slots), a **context**
view, a per-model normalized **breakdown**, a **data-sources / required-runs** coverage
panel, the environment header + comparability banner, and a tidy-CSV export.

### For agents

- **To present results to a human:** regenerate and open the dashboard.
  ```bash
  npm run dashboard
  # then open the file, e.g. on Windows:
  start results/dashboard.html      # macOS: open  ·  Linux: xdg-open
  ```
  If you have a browser/preview tool, point it at the absolute path of
  `results/dashboard.html`. It renders offline from `file://`.
- **To read results programmatically (no browser):** use **`results/report.json`** — it
  carries the same data the dashboard computes: `ranking` (capability), `fleet` +
  `fleet_ranking`, per-model group scores, `environment`, and `provenance` (whether merged
  runs share a server config). Don't scrape the HTML.
- **If the data looks empty or stale:** run `npm run consolidate` first (the dashboard/report
  read the newest checkpoint), then `npm run dashboard`.

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

**The `glslc` version is load-bearing for whether int-dot is even *available*.**
llama.cpp's int8 dot-product path is gated at *build time* on a CMake feature-test that
tries to compile a `GL_EXT_integer_dot_product` shader. The **stock Ubuntu 24.04 `glslc`
(shaderc 2023.8 / glslang 14) cannot compile it**, so the macro
`GGML_VULKAN_INTEGER_DOT_GLSLC_SUPPORT` is silently left undefined and the int8 path is
compiled out — the device reports `int dot: 0`, with **no error**. Use a `glslc` from a
recent **Vulkan SDK ≥ 1.3.290** (we used LunarG **1.4.350.1** → shaderc v2026.2) to get
`int dot: 1`:

> **Measured caveat — int-dot is *off* at runtime on this host.** Having `int dot: 1`
> available let us A/B it rigorously (runtime toggle `GGML_VK_DISABLE_INTEGER_DOT_PRODUCT`).
> On this RX 7900 XT + RADV + KHR_coopmat build it is **neutral-to-negative for decode**
> (0% … −7.4% tg; prefill unaffected) — it only swaps the decode GEMV kernel, and that
> kernel is slower than the coopmat path for our quants. So we **disable it at runtime**.
> Still build with the modern glslc (a different GPU/driver may flip the sign). Full data
> + the warmup-confound that earlier faked a "+37% win": [`results/int-dot-impact.md`](results/int-dot-impact.md).

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
  + maxctx). `throughput^w_thru` is **off by default** (needs `parallel-gen`); raise the
  `w_thru` dial to weight measured aggregate tok/s.

`results/report.json` and the dashboard self-describe the formula via the `SCORING` export,
so the displayed formula can't drift from the code.
