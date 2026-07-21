# Add an `omlx`/MLX backend and benchmark Qwen3.6-27B-5bit on the M1 Mac (llm1)

## Context

The bench harness (`runners/bench-run.mjs`) is hardwired to **one inference engine**: a
remote llama.cpp `llama-server` on the GPU box (`rose`/`llm2`, RX 7900 XT). We want to
benchmark `mlx-community/Qwen3.6-27B-5bit` served by **omlx** (oMLX, an OpenAI-compatible
MLX server) on the **M1 Mac (`llm1`, 32 GB)** — and run it **in parallel** with the bench
already running on `rose`.

This is safe to parallelize: results land in the append-only central Postgres
(`llmbench.measurements`, no PK/unique constraint, concurrent-writer-tolerant). A Mac run
produces rows with `gpu='M1'`, `backend='mlx'`; a `rose` run produces `gpu='RX 7900 XT'`,
`backend='vulkan'` — disjoint, and `--resume` keys on `gpu`+`backend`, so neither run skips
or clobbers the other. The only per-machine lock (`/tmp/llama-server.lock`) doesn't apply to
the Mac. **The running rose bench is untouched by this work.**

The work is two parts: (A) a small, additive engine abstraction in the harness so a non-
llama.cpp backend plugs in cleanly; (B) an operational runbook to stand omlx up on the Mac and
run the bench there.

### Known facts (verified this session)
- **omlx headless (brew, no GUI)**: `brew tap jundot/omlx https://github.com/jundot/omlx && brew install omlx`; serve with `omlx serve --model-dir ~/models --host 0.0.0.0 --port 8000` (foreground; default bind is `127.0.0.1`, so `--host 0.0.0.0` is required for LAN). Needs macOS 15+, Apple Silicon.
- **Model acquisition without the dashboard**: `hf download mlx-community/Qwen3.6-27B-5bit --local-dir ~/models/mlx-community/Qwen3.6-27B-5bit` (~19.4 GB, fits 32 GB unified). Server discovers models in `--model-dir` **at startup only** — download first, then (re)start omlx.
- **API**: OpenAI-compatible. `model` field is **required** (missing → 422); served id = leaf folder name `Qwen3.6-27B-5bit` (org-prefixed `mlx-community/Qwen3.6-27B-5bit` also resolves). `GET /v1/models` lists ids (use for health-check — no `model` needed). `chat_template_kwargs` (Qwen thinking toggle) is a **natively supported** field. No `timings`/`/props` endpoints (llama.cpp-only).
- **Mac control** (now vendored at `infra/machines/llm1/`): `llm1` = `192.168.1.150`, MAC `9c:76:0e:42:2d:f0`, SSH user `remote` (in `admin` group; Homebrew shared to that group so `remote` can `brew install`). Wake: WoL magic packet (`python3 wol.py 9c:76:0e:42:2d:f0`, or `mac start`), then wait for SSH. Sleep: `ssh llm1 'sudo pmset sleepnow'` (passwordless via `/etc/sudoers.d/remote-sleep`; keeps NIC powered for WoL). The vendored `machines/llm1/mac-llm-setup.sh` stands up an **omlx** LaunchDaemon (`0.0.0.0:8000`, `--memory-guard aggressive`) plus a boot-time `iogpu.wired_limit_mb` bump. **Ollama is removed — we are omlx-only** (the repo scripts no longer reference it).

### Decisions taken (from clarification)
- Orchestrator runs **on the Mac** (`--local`, Node on `llm1`, omlx at `127.0.0.1:8000`).
- Benchmark the **requested VLM** `mlx-community/Qwen3.6-27B-5bit` as-is with text-only benches (vision path unused).
- **Nothing is installed on the Mac yet** → the runbook includes install + model download + serve.
- A **max-context / agent-slots capacity probe must work from day one** — not just capability benches. The llama.cpp `agent_ctx` probe can't be reused as-is (see Part A item 7); omlx gets a client-driven equivalent.

---

## Part A — Harness code changes (small, additive, no regression to the llama.cpp path)

The seam is a single engine discriminator on the host, dispatched at one construction site.
`backend` is currently overloaded to mean "llama.cpp build variant" (`vulkan`); we add a real
**`engine`** field (`llamacpp` | `omlx`) alongside it.

### 1. `config/hosts.yaml` — fill in the `m1` placeholder
The `m1:` entry already exists with `llamacpp: null` / "MLX runner only (not yet implemented)".
Replace the placeholder fields with:
```yaml
m1:
   label: "M1 Mac (32 GB unified)"
   gpu: "M1"                                   # recorded as the `gpu` dim
   engine: omlx                                # NEW — selects the omlx server factory
   backend: mlx                                # NEW — recorded in the `backend` column
   mlx: "${MLX_URL:-http://127.0.0.1:8000}"    # NEW — omlx OpenAI endpoint
   ssh_host: "${SSH_HOST_M1:-llm1}"
   port: 8000
   backends: {}
```

### 2. `shared/hosts-config.mjs` — resolve engine + inference URL
`loadHostConfig` currently hardcodes `backend='vulkan'` and reads only `host.llamacpp`. Make it
engine-aware (keep the existing return keys so llama.cpp callers are untouched):
- `const engine = host.engine ?? 'llamacpp';`
- `backend = opts.backend ?? host.backend ?? (engine === 'omlx' ? 'mlx' : 'vulkan');`
- `llamaUrl: resolveEnv(host.mlx ?? host.llamacpp)` (omlx URL wins when present).
- Add `engine` to the returned descriptor.

### 3. `runners/omlx-server.mjs` — NEW, mirrors the `llamacppServer` interface (HTTP-only)
Sibling to `runners/llamacpp-server.mjs`. Factory `omlxServer({ inferenceUrl, debug })` returning
the subset `bench-run.mjs` uses: `{ client, startServer, stopServer, killAll, waitHealthy,
waitVramClear, snapshotVram, snapshotMem }`. No SSH, no host scripts — pure HTTP:
- `client = createClient(inferenceUrl, { debug, model: () => currentModel })` (see change 4).
- `startServer({ hf_repo, mlxModel })`: set `currentModel = mlxModel ?? leaf(hf_repo)`; `GET /v1/models` and **throw a clear error if the id isn't served** ("download it with `hf download …` and restart omlx") — never auto-download.
- `waitHealthy(ms)`: poll `GET /v1/models` until reachable and the target id is listed.
- `killAll`, `stopServer`, `waitVramClear`: no-ops (resolve immediately). `snapshotVram`/`snapshotMem`: return `null`/`{vram:null,gtt:null}` so any stray probe call can't crash.

### 4. `shared/llm/client.mjs` — settable `model` (backward-compatible)
Today `model: 'local'` is hardcoded (llama.cpp ignores it). omlx **requires** the real id. Add a
`model` option to `createClient` (default `'local'`), resolved per request
(`typeof model === 'function' ? model() : model`) so `omlxServer` can switch it at `startServer`.
`tokPerSec`/`prefillTokPerSec` already return `null` when there's no `timings` (fine for omlx).

### 5. `runners/bench-run.mjs` — engine dispatch + two guards + engine-scoped model filter
- Read `engine` from the host descriptor.
- **Model filter**: only run models whose engine matches the host —
  `(m.engine ?? 'llamacpp') === engine` — so a normal `rose` run **never** picks up the MLX
  entry (and vice versa). This lets the MLX model stay enabled without polluting GPU runs.
- **Skip `probeHostBuild`** when `engine !== 'llamacpp'` → `llamacpp_build = null` (no `llama-server --version` over SSH).
- **Skip the systemd router stop/restart** when `engine !== 'llamacpp'` (there's no llama-server router on the Mac; avoids needing `--keep-router`).
- **Factory dispatch** at the single construction site (currently `const srv = llamacppServer({…})`):
  `engine === 'omlx' ? omlxServer({ inferenceUrl: host.llamaUrl, debug }) : llamacppServer({…})`.
- Pass the omlx id through the existing `startServer` call: add `mlxModel: m.mlx_model` to the
  `srv.startServer({ hf_repo, hf_file, ctx, extraFlags })` object (llama.cpp ignores it).
- `platformBase.backend` already comes from `host.backend` → now `'mlx'`.

### 6. `config/models.yaml` — add the MLX model entry
`deriveSubjectDims` is override-friendly, so no code change there — just declare the fields the
GGUF parsers can't infer:
```yaml
- hf_repo: mlx-community/Qwen3.6-27B-5bit
  hf_file: Qwen3.6-27B-5bit          # synthetic base id (no .gguf) → gguf_file column + modelBaseId
  engine: omlx                        # keeps it out of llama.cpp/rose runs (change 5)
  mlx_model: Qwen3.6-27B-5bit         # omlx request id (leaf folder name)
  label: "Qwen3.6-27B 5bit (MLX)"
  family: qwen3.6
  type: dense
  arch: gated-delta-dense
  quant: "MLX-5bit"                   # override — GGUF quant regex won't match "5bit"
  effective_bpw: 5.0                  # override
  total_params: 27
  active_params: 27
  think: optional
  think_control: enable_thinking      # omlx supports chat_template_kwargs natively (verify honored)
  tools: true
  native_max_ctx: 262144
  ctx_cap: 32768
  kv_variants: []                     # do NOT fan out KV-quant variants (llama.cpp-only concept)
  extra_flags: { batch-size: null, ubatch-size: null }   # neutralize llama.cpp defaults on MLX rows
  benches: [agent_ctx, triage, reasoning, toolcalling, summarization, docqa]
```

### 7. `benches/probes/agent_ctx_mlx.mjs` — NEW, client-driven capacity probe (max ctx + agent slots)
The existing `benches/probes/agent_ctx.mjs` is llama.cpp/amdgpu-specific: it reloads
`llama-server` at different `-c/--parallel --kv-unified` and gates on **rocm-smi VRAM+GTT
spill** against the RX 7900 XT's `CARD_TOTAL_MIB`. None of that exists on Apple-Silicon/omlx
(unified memory — no VRAM/GTT split, no rocm-smi; omlx sets context per-model, not via a
reload flag). So omlx gets a **purely client-driven** probe (pure HTTP — no server reloads, no
VRAM snapshots), reusing the *same* needle-in-haystack fills and coherence gate:
- Reuse `makeFillPrompt` (`shared/codebase.mjs`) and the "does the slot retrieve ITS OWN needle" check (identical to the llama.cpp probe's `runSlots`).
- **Max single-sequence context**: boundary-search the fill depth (from `ctx_cap` up toward `native_max_ctx`, capped) → the deepest depth that still coheres without erroring, recorded as `planner_ctx`. *(the max-context measurement.)*
- **Agent slots**: at `coder_ctx = min(65536, maxCtx)`, fire an increasing number N of concurrent needle requests until a slot errors or goes incoherent → the largest N where all slots cohere is `n_coders`/`n_slots`. *(the agent-slots measurement.)*
- Gate on **coherence + request success**, not a VRAM formula — memory pressure surfaces as an omlx error or an incoherent slot. Bound total requests (~a dozen), mirroring how the llama.cpp probe bounds reloads (`MAX_LOADS`).
- **Emit `bench: 'agent_ctx'`** with the same row shape (`{score:n_coders, n_slots, n_coders, coherent_slots, total_ctx, planner_ctx, coder_ctx, verified, status, notes}`) so it feeds the existing fleet score (`analysis/score.mjs`) and the `general`-scope path **unchanged** — no schema/scoring change.

**Registry dispatch**: keep a single `agent_ctx` entry whose `run(ctx)` delegates by engine —
`(ctx.model.engine === 'omlx' ? runMlx : runLlamacpp)(ctx)` — so a `rose` run keeps the exact
current behavior and an `m1` run gets the client-driven probe. `selfManagesServer` stays `true`
(the omlx path needs no lifecycle; it calls `srv.waitHealthy()` = `GET /v1/models` at its start).
`fit_ctx` (llama-fit-params) stays llama.cpp-only and is simply not in the MLX model's bench list.

**No changes needed** to `analysis/pg-store.mjs`, `shared/tidy-schema.mjs`, the capability
benches, or the scoring/dashboard code: the schema already carries `backend`/`gpu`/`host` and
nullable `llamacpp_build`/`driver`; capability benches only touch the engine-agnostic `client`
contract, and the new probe emits the existing `agent_ctx` row shape.

---

## Part B — Operational runbook (Mac, one-time + run)

### B0. Wake the Mac (from the dev PC, Linux)
`python3 ~/projects/infra/machines/llm1/wol.py 9c:76:0e:42:2d:f0` (or `mac start`). Then `ssh llm1`
(add to dev-PC `~/.ssh/config`: `Host llm1 / HostName 192.168.1.150 / User remote`). Sleep when
done: `ssh llm1 'sudo pmset sleepnow'`.

### B1. Remove Ollama, install omlx, download the model (as `remote`, over SSH — CLI only, no GUI)
```bash
# Remove the old Ollama server — we are omlx-only now:
sudo launchctl bootout system/com.ollama.server 2>/dev/null || true
sudo rm -f /Library/LaunchDaemons/com.ollama.server.plist
brew uninstall ollama 2>/dev/null || true ; rm -rf ~/.ollama

# Install omlx + HF CLI:
brew tap jundot/omlx https://github.com/jundot/omlx && brew install omlx
brew install huggingface-cli        # or: pip install -U huggingface_hub

# Download the model (omlx picks it up at next (re)start):
hf download mlx-community/Qwen3.6-27B-5bit \
    --local-dir ~/models/mlx-community/Qwen3.6-27B-5bit
```
Requires macOS 15+ (verify `sw_vers`). ~19.4 GB download. The serve daemon, RAM tuning, and
firewall are then applied by `machines/llm1/mac-llm-setup.sh` (B2).

### B2. Serve omlx on :8000 (+ RAM tuning + firewall) via the setup script
Run the vendored setup script — it installs the omlx LaunchDaemon (`com.omlx.server`,
caffeinated, `--memory-guard aggressive --memory-guard-gb 28`, `RunAtLoad`/`KeepAlive`), the
boot-time Metal wired-memory bump (`iogpu.wired_limit_mb=28672`, see B2a), the `socketfilterfw`
exception for :8000, and passwordless sleep:
```bash
scp infra/machines/llm1/mac-llm-setup.sh remote@192.168.1.150:~/
ssh llm1 'bash ~/mac-llm-setup.sh'
```
After the model download (B1), refresh omlx's startup discovery:
`ssh llm1 'sudo launchctl kickstart -k system/com.omlx.server'`.
Verify: `curl -s http://127.0.0.1:8000/v1/models` lists `Qwen3.6-27B-5bit`.
One-off alternative (no daemon): `nohup caffeinate -s omlx serve --model-dir ~/models --host 0.0.0.0 --port 8000 --memory-guard aggressive --memory-guard-gb 28 >~/omlx.log 2>&1 &`.

**For an honest capacity probe (item 7)**: set the model's `max_model_len` high (its native
window) in omlx's per-model `model_settings.json`, and do **not** pass `--paged-ssd-cache-dir`,
so the probe finds the real **unified-RAM** ceiling rather than an artificial cap or an
SSD-backed context that would inflate the number.

### B2a. Maximize LLM-available unified RAM (do before serving + probing)
On a 32 GB M1 the model alone is ~19.4 GB, so the KV/context pool lives in what's left —
squeeze out as much as is safe (this directly raises the max-ctx / agent-slots the item-7 probe
finds). macOS caps Metal-usable unified memory (~21–24 GB by default) and omlx's guard defaults
to `RAM − 8 GB`; `mac-llm-setup.sh` raises **both** — this section explains the knobs it sets:
1. **Metal wired limit** (the key macOS lever): `sudo sysctl iogpu.wired_limit_mb=28672`
   (~28 GB, leaving ~4 GB for macOS — check the current value first with
   `sysctl iogpu.wired_limit_mb`). Not persistent across reboot; for durability set it at boot
   via a tiny LaunchDaemon (`com.local.iogpu-wired.plist` running
   `sysctl -w iogpu.wired_limit_mb=28672`), which also avoids an interactive sudo at run time.
2. **omlx memory guard**: the `--memory-guard aggressive --memory-guard-gb 28` flags in B2's
   serve command (raise omlx's own ceiling toward the wired limit).
3. **Free competing RAM**: Ollama has been removed from the box (B1), and the omlx LaunchDaemon
   needs no GUI login — run headless so nothing else holds unified memory during the run.

Leave a few GB of headroom — an over-aggressive wired limit starves macOS and destabilizes the
box. Note: `remote` has passwordless sudo only for `/usr/bin/pmset`; the `sysctl` bump needs the
admin password (or the boot LaunchDaemon in step 1, or an added `/usr/sbin/sysctl` sudoers entry).

### B3. Bench harness on the Mac
```bash
brew install node
# ALWAYS clone from git.xor0.de (origin) — never the GitHub mirror:
git clone https://git.xor0.de/demonkoryu/llm-bench.git ~/llm-bench && cd ~/llm-bench && npm install --omit=dev
# ~/llm-bench/.env (chmod 600): LLMBENCH_PG_HOST=192.168.1.120 (+ PORT/DB/USER),
#   LLMBENCH_DB_PASSWORD=<llmbench role pw, same as dev-PC .env>
```
Central-db (`192.168.1.120:5432`) is reachable from the Mac over the LAN. No DuckDB needed
(PG-native path; pure-JS `postgres` + `openai` + `js-yaml`).

### B4. Run (parallel to the rose bench)
```bash
MLX_URL=http://127.0.0.1:8000 node runners/bench-run.mjs \
    --target m1 --local \
    --benches agent_ctx,triage,reasoning,toolcalling,summarization,docqa \
    --think both --samples 1 --ctx 32768 --resume
```
Router/probe steps auto-skip (engine `omlx`). Each result is inserted to Postgres immediately, so
a crash loses nothing and `--resume` fills gaps.

---

## Verification

1. **Unit-level (before touching the Mac)**: from the dev PC, point at a running omlx (or a
   stub) — `MLX_URL=http://<mac>:8000 node -e "import('./runners/omlx-server.mjs')…"` — and
   confirm `waitHealthy` sees the model and `client.chat([{role:'user',content:'hi'}])` returns.
   Confirm a normal `rose` run still ignores the MLX entry (engine filter) and behaves identically.
2. **End-to-end on the Mac**: run B4 with `--benches triage --samples 1` first (fast smoke).
   Watch stderr for `triage … → N/M`. Then add `agent_ctx` and watch the client-driven probe
   report `1×Nk planner + K coders … coherent` — confirm it finds a plausible max-ctx +
   slot count for 32 GB (not 0, not an implausibly huge SSD-backed number). Then the full set.
3. **Store**: `ssh 192.168.1.120 "docker exec central-db psql -U llmbench -d llmbench -tAF'|' -c \"SELECT bench,think_mode,count(*) FROM measurements WHERE gpu='M1' AND backend='mlx' GROUP BY 1,2\""` — rows present (incl. `agent_ctx`), disjoint from rose.
4. **Think toggle**: compare a `think` vs `no_think` triage row; if omlx's Qwen3.6 template
   ignores `enable_thinking`, switch the entry to `think_control: system_keyword` (or run
   `--think no_think` only) and re-check.
5. **Parallelism**: confirm the concurrent rose run's rows keep landing throughout (its
   `gpu='RX 7900 XT'` counts keep rising) — proves no cross-run interference.
6. **Dashboard**: rebuild (push to `main` → Forgejo `pages.yml`, or local export); the MLX
   config appears as a new entity (`backend=mlx`, `gpu=M1`).

## Open items / limitations (flag, not blockers)
- **Capacity probe ships (item 7); throughput/speed do not (yet)**: the client-driven
  `agent_ctx` gives the MLX config a `general`-scope max-ctx + agent-slots metric from the start.
  The remaining llama.cpp+ROCm probes (`throughput`, `speed`, `kv_per_tok`, `prefix_cache`,
  `fit_ctx`) are excluded. So the MLX config may still fall short of "full bench coverage" for a
  composite score under some dashboard selections. Follow-up: a small client-driven omlx
  throughput/TTFT probe deriving tok/s from `usage` + wall-clock (no `timings` needed) would
  backfill the rest of the `general` rows.
- **omlx capacity semantics differ from llama.cpp**: the MLX `agent_ctx` is coherence/success-
  gated on unified RAM, not VRAM+GTT-spill-gated — so its numbers are comparable in *meaning*
  (coder agents alongside a planner) but not a like-for-like of the physical gate. Fine for the
  fleet score; worth a footnote if the M1 and rose fleet numbers are compared head-to-head.
- **VLM**: `Qwen3.6-27B-5bit` is vision-language; only its text path is exercised. Fine as decided.
- **`omlx start` (brew services)** may not read our `--host/--port` flags — hence the LaunchDaemon
  / `nohup` recommendation for a known-good bind.
- **Repo remote on the Mac**: clone **only from `git.xor0.de` (origin), always** — never the
  GitHub mirror. Only runtime deps are needed (`npm install --omit=dev`).
