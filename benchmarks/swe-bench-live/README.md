# SWE-bench-Live, on a pinned subset

Real GitHub issues, resolved (or not) inside each repository's own container. `benches/swe_live.mjs`
drives [mini-swe-agent](https://github.com/SWE-agent/mini-swe-agent) against the configuration under
test, then the SWE-bench-Live harness runs that repo's suite to decide whether the patch resolved the
issue. All or nothing per instance; no partial credit.

This file documents the part that is **not** automated: choosing what goes in the pin, and the gold
pass that decides what is allowed to stay. `benches/swe_live.mjs` refers the operator here when a
manifest carries no `gold_validated` block.

## What a version is

`subset-v{N}.json` pins **both** the instance list **and** the run parameters — rollout timeout, step
limit, context, agent version, agent overlay. A score is comparable only against another taken with
the same instances *and* the same budget, so changing either means a new version, never a silent
re-run. Every version's file stays checked in: each is what some published result was measured
against, and deleting one would leave those numbers describing a set nobody can reconstruct.

| version | n | shape |
|---|---|---|
| v1 | 12 | 3 × go/java/ts/rust |
| v2 | 16 | 4 each |
| v3 | 20 | 5 each |
| v4 | 20 | same instances; step limit 250 → 1000 |
| v5 | 20 | same instances; dropped the 4,000-char observation overlay |
| v6 | 23 | adds cpp at 3 — see below |

A bump is **not** a re-sweep. `build-subset.py` carries every prior instance forward and fills only
the gaps, and the bench's rollout ledger (`rollouts.json` per configuration) skips any instance
already attempted under the same budget. So v5 → v6 costs three rollouts per configuration, not
twenty-three. A bump that changes `run_params` is the expensive kind — it invalidates every stored
rollout, which is why v5 took 8h16m and v6 takes about two hours.

## Building a version

```bash
# 1. bump VERSION and (if adding a language) LANGS in build-subset.py, then:
python benchmarks/swe-bench-live/build-subset.py > /tmp/v6.json   # NOT straight to subset-v6.json
```

Write to a temp file and move it into place. The builder reads the previous pin from
`subset-v{VERSION}.json` if it parses, and a shell redirect creates that file *empty before python
starts* — `_usable()` now tolerates this, but a temp file makes the intent obvious.

Re-running must reproduce the committed `instances` list exactly. `language_stats` legitimately
differs on a rebuild (the new language flips from `new=5` to `carried=5` once the bump's own file is
the prior); it is provenance and nothing reads it. Compare `instances`.

Then materialize the machine-local working set — the evaluation harness reads a local dataset file,
and the images must be present before any rollout:

```bash
python benchmarks/swe-bench-live/materialize.py --manifest benchmarks/swe-bench-live/subset-v6.json
bash ~/.local/state/swe-live/pull-images.sh     # refuses below 60 GB free
```

Pull large additions smallest-first by hand: `pull-images.sh` walks `images.txt` in sorted order and
aborts the whole run at the floor, so an unlucky order strands the set. Never
`docker system prune -a` — Docker reports the pinned instance images as "reclaimable" because no
container holds them between sweeps, and blanket pruning re-downloads ~200 GB.

## The gold pass, and the two gates

Run the benchmark's own **reference patch** on every new instance before any model attempts it:

```bash
cd ~/.local/state/swe-live/SWE-bench-Live
~/.local/state/swe-live/venv/bin/python -m evaluation.evaluation \
  --dataset ~/.local/state/swe-live/subset.jsonl --patch_dir gold --platform linux \
  --workers 1 --output_dir ~/.local/state/swe-live/logs/gold-v6 --overwrite 1 \
  --instance_ids <id>
```

Sequential, one instance at a time, and **time each one**. Per-instance evaluation cost is as
load-bearing as validity, because evaluation runs once per configuration benchmarked, forever.

**Gate 1 — validity.** `resolved != true` with the reference patch means no model can resolve it, so
every model would spend a full rollout earning a guaranteed zero. Add the **instance** to
`EXCLUDE_INSTANCES` with the date and reason. Instance-scoped, because another instance from the same
repo may be fine. If a *second* instance from the same repo also fails, promote it to
`EXCLUDE_REPOS` — one failure is an instance, two out of two is that repo's environment on this
machine (the `NVIDIA/OpenShell` precedent).

**Gate 2 — cost.** Goes to `EXCLUDE_REPOS` — by **repository**, not by instance, because evaluation
cost is a property of the build and test suite. The first attempt at this excluded by instance and
drew the same repository straight back in.

The working bar is **the pin's own worst kept instance**, currently `antvis__G2-7076` at 444s: past
what the pin already tolerates is out of line by the pin's own standard, which beats an invented
number. Precedents: `gwtproject/gwt` and `ghostfolio/ghostfolio` at >20 min, `ProvableHQ/leo` at
1611s, and the four cpp repos at 590–951s.

**A language may simply have fewer affordable instances, and that is a result, not a failure.** The
v6 cpp draw needed nine gold evaluations: three cost 29–111s, four cost 590–951s, two were
gold-invalid. The distribution is bimodal because in C++ the build *is* the cost — an image either
ships usable artifacts or recompiles — so redrawing within the expensive band never converges. cpp
was capped at its three affordable instances via `PER_LANG_OVERRIDE` rather than buying two more at
roughly a third of the pin's entire evaluation budget. `per_language` is a map from v6 on, and the
page states the uneven counts and the coarser per-language step that follows.

**Redraw loop.** Add the exclusion to the builder and regenerate. The carry-forward keeps everything
that already passed and fills only the new gap, so a redraw costs one image and one validation, not
a whole language. `docker rmi` the rejected image before pulling its replacement.

**Then hand-merge `gold_validated`** into the manifest — the builder does not emit it, and
`scoredInstances()` throws without it:

```json
"gold_validated": {
  "resolvable": ["...every pinned instance that passed..."],
  "eval_seconds": { "<instance_id>": 79 },
  "eval_seconds_total": 2572,
  "harness_commit": "9a27349",
  "host": "rose (62 GB RAM, 32 CPU)",
  "validated_at": "2026-09-16 (v1) / ...",
  "note": "why anything was rejected, with its timing"
}
```

Never paste the previous version's `resolvable` unchanged. The denominator is the gold-validated set,
not the pinned set, so a stale block makes the bench score N pinned instances against a smaller
denominator — the new rollouts are paid for and silently discarded.

Only once that block exists, bump `MANIFEST` in `benches/swe_live.mjs`.
`dashboard/copy-lib.mjs` imports `MANIFEST_PATH` from there, so the published page follows.

## Sweeping

`~/.local/state/swe-live/run-v{N}/sweep.sh` frees both V100s, then works a shared queue across two
lanes. Each item **must** pass `--no-resume`: every already-measured configuration has a successful
`swe_live` row, and the default would skip all of them and exit clean having done nothing. It re-runs
the *bench*, not the rollouts — the ledger still carries everything unchanged.

Watch the per-configuration line. `5 rolled out this run, 20 carried from earlier runs` is a pin
extension working. `25 rolled out` means a run parameter moved and you are paying for a full
re-sweep.

Afterwards, `node analysis/backfill-swe-live.mjs --apply` is **required**, not optional: the bench
stores only the current evaluation pass's `swe_eval_s`, and the backfill accumulates it across passes
into `ledger.eval_seconds.passes[version]`. Skip it and the page reports the cost of judging five
patches as the whole pin's evaluation cost.

Do **not** run `analysis/retire-swe-live-before.mjs` for an instance-only bump. It exists for a
`run_params` change, where every stored rollout really is a measurement of something else. With
run_params unchanged the new rows supersede the old at the same identity via `$LATEST` latest-wins,
and retiring would blank rows that are legitimately still valid.
