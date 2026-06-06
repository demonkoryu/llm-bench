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
