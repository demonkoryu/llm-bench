# llm-bench

Local LLM benchmark suite for picking an **agentic fleet** on a single GPU. It measures
each model on document comprehension, coding/tool-use, speed, context length and VRAM
footprint, then ranks them by a **capability** score and a **fleet-suitability** score,
and renders an interactive **Observable Framework** dashboard.

- **Orchestrator** — `runners/bench-run.mjs` (Node): the model × think × bench matrix loop.
  Runs **on the benchmarking host** from a git checkout (see §4); the dev box is only for
  editing. Bench modules live in `benches/` (reuse the graders in `benchmarks/*`);
  performance/capacity **probes** (`benches/probes/`) self-manage the server.
- **Inference** — engines are selected per host by `engine:` in `config/hosts.yaml`. Two are
  live, both CUDA on the V100 host: a `llama.cpp` server (`engine: llamacpp`, default;
  lifecycle/VRAM/health/systemd-router in `runners/llamacpp-server.mjs` + `scripts/llm2/`), and
  **NInfer** (`engine: ninfer`, one instance per card, `runners/ninfer-server.mjs` +
  `scripts/llm2/ninfer/`). A third, **OptiQ** (MLX) on Apple Silicon (`engine: optiq`,
  `runners/optiq-server.mjs`), is **parked as of 2026-08-26** — the fleet is V100-only, so every
  `engine: optiq` model carries `disabled: true` and `--target m1` matches nothing. The code and
  host block are kept as the record of how it was wired. (RapidMLX was the prior Apple-Silicon
  engine; retired 2026-07-22 → `archive/rapidmlx/`.)
- **Store** — a **central Postgres** table, `llmbench.measurements` (central-db @
  192.168.1.120), one row per measured metric with every config axis (chat_template, kv_quant,
  quant, arch, finetune, llamacpp_build, sampling, think…) as a queryable column. `bench-run`
  writes rows here directly (`analysis/pg-store.mjs` `insertRows`); there is no Parquet file
  and no sync step — Postgres is the single source of truth. Access needs `LLMBENCH_DB_PASSWORD`
  (auto-loaded from a gitignored `.env`; see `.env.example`). Expensive facts (context ceilings,
  KV footprint) are still memoized in `results/caps/capabilities.json`, keyed by (gguf, quant,
  kv, backend, gpu, **llamacpp_build**) so a llama.cpp upgrade invalidates them.
- **Analysis** — `analysis/`: `score.mjs` (+ `scoring-config.mjs`) computes capability/fleet
  over any filtered slice; `query-engine.mjs` owns the dashboard's metric catalog +
  pivot/pareto/leaderboard/coverage reshaping; `pg-store.mjs` is the read/write layer (all SQL
  runs through DuckDB's `postgres` extension, `$TIDY` → `pg.measurements`).
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

The orchestrator writes each result straight to Postgres as it completes (plus a small run
manifest under `results/runs/<run_id>/`) and consults the capabilities cache to skip re-probing
context ceilings. Needs `LLMBENCH_DB_PASSWORD` in the env or `.env`. Flags: `--models <substr,…>`,
`--benches <name,…>`, `--think both|no_think|think`,
`--samples N` (multi-sample → per-metric mean + `spread`), `--ctx <n>`, `--target <host>`,
`--chat-template <path-on-host>` (A/B a custom template), `--keep-router` (don't stop the
host's systemd `llama-server` service).

Benches (`benches/`): `triage, reasoning, reasoning_hard, toolcalling, summarization,
docqa, coding_{multipl,hard,practical,bugfix}, agentic_loop, struct_output,
instruction_following`, plus **probes** (`benches/probes/`, self-manage the server):
`maxctx, vram_per_ctx_tok, throughput` (e2e/ttft), `speed, prefix_cache, quality_decay,
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

Everything lands in the central Postgres table `llmbench.measurements` — analyse it any way you
like, no fixed "report" step. Query it through the app's engine (`$TIDY` expands to the table):

```bash
node -e "import('./analysis/pg-store.mjs').then(async m=>{
  const r = await m.query(\`SELECT chat_template,
      100.0*sum(metric_value) FILTER(WHERE metric='toolcall_pass')
           /sum(metric_value) FILTER(WHERE metric='toolcall_total') AS pct
    FROM \$TIDY WHERE bench='toolcalling' GROUP BY 1\`);
  console.table(r);})"
```

…or hit the DB directly (`docker exec central-db psql -U llmbench -d llmbench`), or use the
scorer (`analysis/score.mjs`) programmatically. The store never collapses configs: two runs that
differ in any measured dimension (template, quant, KV, build…) are distinct, queryable rows —
the thing the old `model|think|bench` merge couldn't do. (Scoring intentionally merges across
`llamacpp_build`, but the rows themselves keep the build for provenance.)

---

## 3. The dashboard

An **Observable Framework** app in `dashboard/` — a shared facet form driving four views:
**Leaderboard** (capability/speed/fleet, sortable), **Pareto** (quality vs throughput, bubble
size = VRAM), **Pivot** (A/B any two dims as a heatmap, with a Δ baseline), **Coverage** (run
vs not). The compute is the same pure `analysis/query-engine.mjs` + `score.mjs` the rest of the
suite uses (mirrored into `dashboard/src/lib/` at build time), so the dashboard can't drift
from the scoring.

**Data flow.** Benchmark runs write rows directly to the **central Postgres**
(`llmbench.measurements` on llm2). The dashboard's build-time data loader reads them through
DuckDB's `postgres` extension and bakes a static snapshot, so the published page needs no live
DB connection. No sync step — the store the run writes is the store the dashboard reads.

```bash
cp .env.example .env && edit .env         # set LLMBENCH_DB_PASSWORD (llmbench role password)
cd dashboard && npm ci && npm run dev      # local preview → http://localhost:3000
npm run build                              # static dist/ (what CI publishes)
```

Published to **<https://pages.xor0.de/llm-bench/>** (mobile-friendly). A push to `main` touching
`dashboard/` or `analysis/` — or a manual **Run workflow** after a data refresh — builds `dist/`
on the Forgejo runner and deploys it via the `pages` branch → Caddy. CI needs the
`LLMBENCH_DB_PASSWORD` Actions secret.

## 4. Deployment & running on a benchmarking host

**The matrix runs *on* the benchmarking host, from a git checkout — not from the dev box.**
Each benchmarking machine holds a checkout of this repo at `~/llm-bench` and runs `bench-run`
there; the dev box (where you edit) never drives the matrix. The single source of truth is the
Forgejo remote `origin` (`git.xor0.de/demonkoryu/llm-bench`); the Postgres store is central
(on llm2) and reachable from every host (needs `LLMBENCH_DB_PASSWORD`).

**Update loop (edit here → run there):**

```bash
# 1. On the dev box: edit, then commit + push to origin (Forgejo).
git commit -am "…" && git push origin main
# 2. Pull the change onto the benchmarking host (SSHes in, git pull --ff-only, chmods scripts).
scripts/deploy.sh --host <llm1|llm2>
# 3. Run the matrix ON that host, from the checkout; observe over SSH.
ssh <host> 'cd ~/llm-bench && node runners/bench-run.mjs --target <host> --benches … '
```

The two host types differ only in how inference is served:

- **llama.cpp hosts (rose / llm2).** `bench-run` owns the `llama-server` lifecycle and
  coexists with the host's systemd `llama-server` router. Run with `--local` (env
  `BENCH_LOCAL=1`) so the host scripts + router `systemctl` execute locally instead of over
  SSH. Readiness: `scripts/llm2/ready.sh`.
- **OptiQ (MLX) hosts (m1 / llm1) — PARKED 2026-08-26.** Nothing below is runnable while the
  fleet is V100-only: every `engine: optiq` model is `disabled: true`, so `--target m1` matches
  no model and exits 1. Kept as the record of the wiring. OptiQ is a **persistent daemon**
  (`optiq serve`), launched
  separately by [`scripts/llm1/serve.sh`](scripts/llm1/serve.sh) (installs via `pipx install
  mlx-optiq`). For `engine: optiq` the harness server-lifecycle is a **no-op** — it never starts/
  stops/reloads the daemon, has no VRAM readout, and talks to it over **loopback**
  (`127.0.0.1:8080`), so there is no `systemctl` and no SSH server-management (no `--local` needed).
  Launch (or relaunch — e.g. for the mixed-precision `--kv-config` KV A/B) the daemon with
  `serve.sh`, then run `bench-run --target m1` from the checkout. `serve.sh` also asserts the Metal
  wired-memory limit (`sysctl iogpu.wired_limit_mb`, set by the operator; it warns but never writes
  it). **Auth caveat:** OptiQ requires `Authorization` on POST by default and rejects the SDK's
  `Bearer EMPTY`, so the daemon must run `--no-auth` (serve.sh does). The prior RapidMLX engine is
  retired → [`archive/rapidmlx/`](archive/rapidmlx/).

---

## GPU host: the `llama.cpp` backend

The orchestrator drives a `llama.cpp` server on the GPU host over SSH. Reference hardware:
**rose** — 2x NVIDIA Tesla V100 PCIe 32 GB (`sm_70`, 64 GB total), declared in
[`config/hosts.yaml`](config/hosts.yaml).

The backend is a **prebuilt CUDA container image**, not an in-tree build.
[`scripts/llm2/backends.sh`](scripts/llm2/backends.sh) is the source of truth for detection: it
reports `cuda docker:<image>` when both the image and `nvidia-smi` are present, and exits
non-zero otherwise, which is how the harness auto-selects the backend. The image name comes from
`$LLAMA_IMAGE` (default `llama-server-cuda`) and is also declared per host under
`backends.cuda.image`, so read it from there rather than hardcoding it — it is built out of band
on the host and the tag moves.

The NInfer engine is the other CUDA path and *does* build in-tree, from
[`scripts/llm2/ninfer/Dockerfile.v100`](scripts/llm2/ninfer/Dockerfile.v100); see the
`rose-ninfer0` / `rose-ninfer1` host blocks for how the two per-card instances are wired.

> The ROCm and Vulkan build recipes that used to live here were removed 2026-08-26 with the
> RX 7900 XT they described (`gfx1100`, RDNA3, 20 GiB) — including the `glslc`/int-dot build
> gate, which was specific to llama.cpp's Vulkan shader feature-test and has no CUDA analogue.
> `git log -- README.md` still has them if that card ever comes back.


### Server launch flags

The server is launched by [`scripts/llm2/start-server.sh`](scripts/llm2/start-server.sh):
`-fa on`, `--cache-type-k/v q8_0` (quantized KV), `--jinja`, `--reasoning-format auto`,
`-np 1`. Batch sizing (`-b 2048 -ub 2048`) is **not** in the script — it is injected per-model
from `config/models.yaml` `defaults.extra_flags`. See that file's header for the rationale.

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

## Benchmark winner (2026-06-09) — RETIRED HARDWARE

> Measured on the RX 7900 XT under Vulkan. Those measurements were deleted from the store on
> 2026-08-26 when the fleet went V100-only (see [`results/archive/`](results/archive/)), so
> **none of the numbers below can be reproduced from the current data set** and no V100 run has
> re-crowned a winner yet. Kept because the deployment flags are what production still runs.

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

> **MTP was disabled for this deployment.** Gemma4 MTP with quantized KV on Vulkan gave 0% draft
> acceptance (Hadamard-rotation bug). That finding is Vulkan-specific: on V100/CUDA the
> `Gemma4-26B QAT UD-Q4_K_XL` entry now runs `spec-type: draft-mtp` with a pinned draft KV
> quant and is measured with speculation on — the V100 evidence is the run log under
> `results/bench-mtp-*.log` plus the `spec_decode` dimension in the store. (The old
> `results/gemma-mtp.md` writeup this used to link is gone.)
