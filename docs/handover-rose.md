You are picking up benchmarking work on `~/llm-bench` (origin: https://git.xor0.de/demonkoryu/llm-bench.git,
branch `main`). Read this whole brief before touching anything — several of the facts below are ones a
previous session got wrong the hard way.

## Where you are

You are on the box that is called **`rose`** by the benchmark and **`llm2`** by DNS — same machine,
192.168.1.120. Both GPUs (2x V100, 32 GiB each) and the central Postgres `measurements` store are
**local to you**. The fleet is V100-only as of 2026-08-26; everything AMD/Vulkan and Apple/MLX was
purged from the store and the tree (see `results/archive/README.md`).

**ONE GPU PER MODEL as of 2026-08-27** (`93d7c8f`). `scripts/llm2/start-server.sh` pins the container
to device 0 and `hosts.yaml` declares `vram_total_mib: 32768`. Before that date every llama.cpp row
was a two-card layer-split measurement against a 65536 ceiling, so any pre-08-27 capacity or speed
number describes hardware this fleet no longer uses. `LLAMA_GPUS=all` reproduces the old behaviour.
Measured cost of the switch: decode 8-28% slower and 12k prefill 25% slower than layer-split across
two cards — two V100s bring twice the bandwidth, which outweighs the PCIe crossing. That is a
deliberate trade for one-model-per-GPU, not a regression.

## The job

Goal, in the user's words: run the models that show no data, publish the results, and keep the
retired-hardware cruft out.

Done already (do not redo):
- `gemma-4-26B-A4B-it-qat-UD-Q4_K_XL` `agent_ctx` on both KV quants — q4_0 = 1x128k planner + 17x64k
  coders, pool 1,245,184 tok, 53,216 MiB; q5_0 = 16 coders, pool 1,179,648 tok, 52,978 MiB. Published.
  [correction 2026-08-26] An earlier revision of this brief credited these numbers to
  `gemma-4-31B-it-IQ4_XS`. The store attributes them to the 26B QAT UD-Q4_K_XL artifact, and that entry
  is the only gemma one that declares `kv_variants: [q4_0, q5_0]` — the 31B IQ4_XS entry declares none,
  so it cannot have produced two KV-quant rows. `Gemma4-31B IQ4_XS` has **zero** rows; it is still to
  be measured.
- Three previously-parked entries measured and their manifests committed: `LFM2.5-8B-A1B` (48 rows),
  `granite-4.0-h-tiny` (59), `Nemotron-3-Nano-4B` (86).
- A silent dashboard bug fixed (commit `6388a2c`): Observable Framework's build passes
  `useStale:true` to data loaders, so it served a cached `measurements.json` from 21 July — 2288 rows
  including deleted Vulkan hardware — without running the loader. `dashboard/copy-lib.mjs` now
  deletes `dashboard/src/.observablehq/cache/data` on every dev/build. CI was never affected (fresh
  clone), which is why it only ever bit someone checking their work locally.
- Dashboard is live and correct: 1269 rows, gemma at 17/16 coders, zero non-V100 rows.

Outstanding as of 2026-08-28 (the 2026-08-26 sweep, its crash, and every follow-up are CLOSED —
kept below under "Crash audit" because the reasoning still applies to the next failure):

1. **Single-request coherence is a pass/fail check on llama.cpp hosts, not a ceiling search.**
   `agent_ctx` Phase 1a asks "is the planner coherent at 100k/128k?" and takes yes/no; caps derives
   `coherence_ceiling` from `planner_ctx`. The MLX probe (`agent_ctx_mlx.mjs`, host parked) DOES climb
   — start at ctx_cap, x2 up / /2 down — to find the deepest coherent single sequence. Porting that
   climb to the llama.cpp path would give real per-model ceilings. Contained work, not started.
2. **Two conflicting live ninfer `agent_ctx` rows.** `qwen3_6_35b_a3b.ninfer` on `rose-ninfer1` at
   ctx=131072 has TWO rows in `$LATEST` reporting 4 vs 6 coders at otherwise identical identity —
   some other identity dimension keeps them apart. Untouched: deleting either changes a published
   capacity number and it is not known which is right.
3. **`notes` is not a store column.** Probes emit it; `insertRows` drops it. That is why the pre-fix
   `agent_ctx` skip verdicts took a re-measure to diagnose instead of a query.
4. **`benches/**` is not a pages trigger path.** A bench-logic fix does not republish on its own —
   the same trap `results/runs/**` sets. Trigger paths: `dashboard/**`, `analysis/**`, `shared/**`,
   `config/models.yaml`, the workflow file, `workflow_dispatch`.

Closed on 2026-08-27/28, do not redo (all pushed, dashboard rebuilt and verified at 3041 rows):
- Five harness defects that were publishing numbers measuring the harness, not the model: the triage
  budget asymmetry (`61fb063`), answers routed to `reasoning_content` (`767eecb`), pre-fix `agent_ctx`
  false skip verdicts, the `kv_per_tok` mislabel (`7273549`, now `vram_per_ctx_tok`), and the 2-GPU
  deployment (`93d7c8f`).
- Flat token budgets on every quality bench and the full 21-bench list on all llama.cpp entries
  (`9315d44`). The probes keep their small budgets ON PURPOSE — `prefix_cache` times a cache hit with
  4 tokens, `speed` measures TTFT with 8, `throughput`/`parallel_gen` fix length via `ignore_eos`.
- The concurrent-coherence metric removed entirely — code, 28 rows, dashboard (`d3609db`). Coherence
  is measured one request at a time now. Reasoning in that commit message; it matters if anyone
  proposes reinstating it.
- Nemotron-3-Nano parked at user request (`bd0f624`). Its 95 rows are RETAINED and unpublished;
  un-parking republishes them with no re-measure. Note bench-run resolves `--models` with
  `includeDisabled:true`, so a named parked model STILL RUNS — parking alone does not stop a queue.
- LFM2.5 `triage` gate removed and vindicated: json_fail 0/18, C1 0.889, R1 1.000.

## Check the state before you act, like this

Postgres is the only source of truth for what has been measured — not the run manifests, not the
dashboard. Query it through `analysis/pg-store.mjs`:

```js
import { query } from '/home/demonkoryu/llm-bench/analysis/pg-store.mjs';
// query() returns an ARRAY directly and takes NO bind parameters — interpolate into the SQL.
const rows = await query("SELECT * FROM $LATEST WHERE status IS DISTINCT FROM 'partial'");
```

Schema facts that are easy to get backwards:
- **`bench`** carries the depth (`ttft-8k`, `quality_decay-64k`). **`metric`** carries the *name of the
  value* (`score`, `n_coders`, `n_slots`, `planner_ctx`, `vram_mib`, `coherent_slots`, `verified`, ...),
  and the number itself is in `metric_value`. If you filter `metric='ttft-8k'` you get nothing and it
  looks like missing data.
- Timestamp column is **`ts`**. There is no `measured_at`.
- `$TIDY` is raw `measurements`; `$LATEST` is a latest-wins `DISTINCT ON` over a 16-dimension identity
  key that **includes `host`, `backend`, `gpu`** — so the same model on two backends is two live rows.
- Any DELETE must target raw `measurements`, never `$LATEST`: deleting a live row just promotes the
  superseded row underneath it.

## Running benches

Run from this box with `BENCH_LOCAL=1`. This box cannot `ssh llm2`, i.e. itself (host key
verification fails), but that does not confine runs to the workstation: `shared/host-exec.mjs`
switches every machine-level operation between SSH and local, and `BENCH_LOCAL=1` selects `bash -c`
instead of `ssh <host>`.

```bash
BENCH_LOCAL=1 node runners/bench-run.mjs --target rose --models '<label or hf_file>' --benches <list>
```

- `--models` matches on **`label:` OR `hf_file` substring** and resolves with `includeDisabled:true`,
  so it will happily run a PARKED model — parking alone does not stop a queue that names one.
- **`--no-resume` is required to re-measure combos already recorded `status='ok'`.** Plain resume
  fills only gaps: exactly right after ADDING a bench to an entry, useless after changing how an
  existing bench measures.
- **`--benches` does NOT intersect with the model entry's own declared `benches:` list**
  (`runners/bench-run.mjs:397` — `benchNames.filter((b) => BENCHES[b])`). Passing a union across
  models therefore runs benches an entry deliberately excludes. Generate the list per model from
  `config/models.yaml` instead. The default is only `toolcalling,reasoning`, which silently
  under-measures if you forget the flag.
- Before and after any run, make sure no orphan server holds VRAM. From the workstation:
  `ssh llm2 'bash -s' < scripts/llm2/stop-server.sh`; on rose itself: `bash scripts/llm2/stop-server.sh`.
  Then check both GPUs read 0 MiB. A stray `llama-server` holding ~9 GiB has twice caused capacity
  probes to under-report.
- `agent_ctx` load failures are genuine allocation failures (the container OOMs ~2s in), but their
  *elapsed seconds* mean nothing: until commit `775728d` the health poll kept counting against a
  process that had already exited, then polled again in a silent `health.sh` fallback. Do not cite
  those durations as load times or as evidence about capacity. `scripts/llm2/alive.sh` now aborts
  the wait within ~10s of an exit — if you see a poll run past ~15s with the container gone, that
  script is missing from this checkout.

Measured per-entry costs on one V100 (2026-08-27, 13 entries each):
capacity+speed ~16 min · budget re-measure (`--think no_think`) 6.5 min · the four probes ~5 min ·
the six generation benches ~30 min. Worst case 94 min on Qwen3.6-27B — the GatedDeltaNet hybrid
decodes at ~34 t/s, so each think pass costs 4-5x what a gemma costs. The `think` passes ARE the
cost: all no_think passes plus every probe total ~12 min against ~2h for the think passes.

## Publishing

`.forgejo/workflows/pages.yml` triggers on `dashboard/**`, `analysis/**`, `shared/**`,
`config/models.yaml`, the workflow file, and `workflow_dispatch`. **`results/runs/**` is not a
trigger path** — committing manifests alone does not republish. The build reads Postgres directly, so
a rebuild is what makes new rows visible.

To verify a publish, fetch the data payload, **not** the rendered HTML — the pages are client-loaded
shells and grepping them for a model name returns 0 even when the data is there:

```bash
H=$(curl -s https://pages.xor0.de/llm-bench/ | grep -oE 'measurements\.[a-f0-9]+\.json' | head -1)
curl -s "https://pages.xor0.de/llm-bench/_file/data/$H" | node -e 'let s="";process.stdin.on("data",d=>s+=d).on("end",()=>{const r=JSON.parse(s);console.log(r.length,"rows")})'
```

## Crash audit — what the dead sweep did and did not damage (2026-08-26)

Asked of the store directly, not inferred from the manifests.

Clean:
- **Zero `partial` rows** in raw `measurements` (1747 `ok`, 14 `skip`). The bench in flight when the
  sweep died wrote nothing at all — the server was still generating at 16:50:27, then `stop: cancel
  task`, and no fragment reached the store.
- **No two runs on the same host ever wrote rows in overlapping windows.** The two-orchestrator VRAM
  fight this brief warns about has not happened. Test: pairwise overlap of per-`run_id`
  `[min(ts), max(ts)]` windows grouped by host.
- **The V100-only purge was complete.** Raw `measurements` holds `gpu=V100` and nothing else, on hosts
  `rose` / `rose-ninfer0` / `rose-ninfer1`. No retired-hardware row can resurface from underneath a
  deleted live row.

Suspect, and each gated on a re-measure rather than deleted on suspicion:
1. `qwen3.6-27b` IQ4_XS · KV q5_0 · `triage` · **no_think**, 11 rows at 16:47:24 from the crashed run
   `v100-cuda-20260826-164526-ovqp-benchrun`: `json_fail=18` (all 18 cases unparseable), every
   `triage_R*`/`triage_C*` at 0 — recorded `ok`, so resume treats it as done and skips it. It is the
   only entry in the fleet with a total json_fail (others 0–8), and the **same config's `think` pass,
   measured 20:17:32 on the same server, scores `json_fail=0`, `C1=0.944`, `C2=1`, R2–R7 all 1.**
2. `qwen3.8-27b` Q6_K · `agent_ctx`, 14 rows (7 per KV variant, q8_0 at 08-23T21:08 and k8v4 at
   23:06): `status='skip'` from the `fail()` path in `benches/probes/agent_ctx.mjs:171` — `score=0`,
   `n_coders=0`. Three days *before* `e114cd7` and `775728d`, the two commits that fixed exactly this
   false-verdict class. The reason is unrecoverable from the store: the probe emits `notes`, but there
   is **no `notes` column**, so `insertRows` drops it. Nothing in `analysis/score.mjs` or the dashboard
   filters on status — only `partial` is dropped — so a skipped probe publishes as a measured 0.

Neither slice has anything underneath it in raw (11 rows and 7+7 rows are the whole slice), so
deleting those exact `measurement_id`s cannot promote an older row — but **measure first, then delete**:
delete-then-measure risks ending with no data at all for the slice if the re-measure crashes, while
measure-then-delete never does. Latest-wins means a fresh row supersedes the old one immediately, so
the dashboard is correct the moment the re-measure lands, with or without the DELETE.

Also: this brief says Nemotron landed 86 rows. It is 95 — 86 at 15:49–15:57 plus 9 more at 16:44.

Eight `run_id`s in the store have no manifest under `results/runs/` here: `114409-l12d` (10 rows),
`144237-rnus` (2), `154852-7rtv` (86), `161904-01nh` (9), `164526-ovqp` (11),
`v100-skinny-2026-08-24T1333` and `T1541` (99 each), `v100-ninfer-20260825-190750-benchrun-fleet` (18).
They live on the workstation — except `164526-ovqp`, the run that crashed before writing one, whose 11
rows therefore have no provenance record anywhere.

## Ground rules

- Push only to `origin` (Forgejo at git.xor0.de). Never GitHub. A `gh` remote was found on this
  checkout earlier and removed — don't recreate it.
- Commit messages end with `Co-Authored-By: Claude Opus 5 <noreply@anthropic.com>`.
- Style: 140 cols, spaces (tab = 3), full braces, LF; the repo's `biome.json` wins.
- When you find a written source contradicting what you observe, fix the source in the same turn and
  say so in one line. Don't hardcode volatile values (ports, PIDs, run ids) into docs.
- Durable findings go to Basic Memory (MCP `memory`), one note per subject; add a `[correction]`
  observation rather than silently overwriting an older claim.

Start by reporting what the store actually contains per model, and what the running sweep has landed
so far, before deciding what to measure next.
