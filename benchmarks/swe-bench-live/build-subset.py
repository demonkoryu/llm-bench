#!/usr/bin/env python3
"""Build the PINNED SWE-bench-Live subset. Run once per version; the output is committed.

Comparability is the whole point of this file. Every model must attempt the identical instance list,
so the selection is fully deterministic (fixed seed, sorted inputs) and the result is checked in --
re-running this must reproduce subset-v{VERSION}.json byte-for-byte, and if the upstream dataset
changes it will not, which is exactly the signal we want.

VERSIONS. v1 was 3 instances per language (n=12), v2 was 4 (n=16), v3 is 5 (n=20) -- all three on
2026-09-17, each a request to tighten the interval. v4 has the SAME twenty instances as v3 and
differs only in run_params: the step limit goes 250 -> 1000. v5 keeps those twenty and drops the
observation-truncation overlay, restoring the agent's stock 10,000-character cap. A version bump is required anyway,
because run_params are pinned exactly as the instance list is -- a score is comparable only against
one taken with the same instances AND the same budget. One instance was worth 8.3 points, then 6.25,
now 5.0, and the 95% Wilson half-width has gone 25 -> 22 -> 20 points. Each step is real and each is
small, because interval width falls with the square root of n: halving it costs four times the
instances, and the eligible pool (java is the binding language at 24 distinct repos) caps an
equal-per-language pin at n=96.

Every earlier version's file stays checked in. Each is what some published result was measured
against, and deleting one would leave those numbers describing a set nobody can reconstruct.

A version bump is NOT a re-run. The carry-forward below keeps every previous instance, so an older
result stays valid for the instances it covers and only the new ones have to be rolled out -- which
is what makes extending the pin affordable rather than a full re-sweep of every model. Measured on
the v2 bump: four new instances across six configurations took 98 minutes, against the ~6 hours a
full re-sweep of sixteen would have cost.

Selection rules, in order:
  * four languages (go, java, ts, rust), PER_LANG instances each
  * problem_statement between 200 and 8000 chars -- shorter than 200 is not a usable brief, and
    longer than 8000 crowds the context window of a 32k-served model once the agent adds file
    contents on top
  * FAIL_TO_PASS <= 50 and PASS_TO_PASS <= 2000. This one is load-bearing and was added after the
    first draft drew vavr-io__vavr-3045 with 22,922 F2P tests. The medians are 4-13, but the tails
    reach 22k: those instances are whole-suite runs where the log parser enumerated every test in
    the repo. Resolution demands ALL F2P pass, so such an instance is both very slow to evaluate and
    a criterion no patch realistically satisfies -- it would read as "every model failed" and carry
    no signal. Bounding still leaves 41-50 eligible per language, so nothing is given up.
  * at most one instance per repository, so 20 instances are 20 distinct codebases rather than five
    variations on one, and no repo's idiosyncrasies dominate a language's score
  * ties broken by instance_id sort, then a seeded shuffle
"""
import hashlib, json, random, sys
from pathlib import Path

from datasets import load_dataset
from huggingface_hub import dataset_info

DATASET = "SWE-bench-Live/MultiLang"
LANGS = ["go", "java", "ts", "rust"]
VERSION = 5
PER_LANG = 5
SEED = 20260916

# The pin to carry forward (see the selection loop). Prefer this version's own file so that
# re-running an already-built version reproduces it; fall back to the previous version's file, which
# is the state when a bump is being built for the first time. The seed is deliberately NOT bumped
# with the version: the shuffle order has to stay fixed, or "carry v1 forward and fill the gaps"
# would fill them from a differently-ordered candidate list and the extension would not be
# reproducible from the previous pin.
_HERE = Path(__file__).parent
PRIOR = next(
    (p for p in (_HERE / f"subset-v{VERSION}.json", _HERE / f"subset-v{VERSION - 1}.json") if p.exists()),
    _HERE / f"subset-v{VERSION}.json",
)
MIN_PS, MAX_PS = 200, 8000
MAX_F2P = 50      # resolution requires ALL of them to pass
MAX_P2P = 2000    # bounds how long one evaluation takes

# Instances removed after measurement, with the reason. Each one was drawn by the rules above and
# then disqualified by something only running it could reveal, so the rules alone cannot express it
# -- hence an explicit list rather than a cleverer filter.
#
# Excluding on COST is a budget decision, not a quality one: evaluation runs once per model, so a
# 20-minute instance costs 20 min x every model benchmarked, forever. Two of them were consuming
# ~2.7h of an 8h budget between them while the other six finished in ~8 min combined.
#
# Excluding a GOLD-INVALID instance additionally saves its rollout: an instance that fails with the
# reference patch cannot be resolved by anyone, so every model would spend its full per-instance
# rollout budget earning a guaranteed zero.
# Cost exclusions are BY REPOSITORY, not by instance. Evaluation cost is a property of the repo's
# build and test suite, so swapping gwt-10054 for gwt-10153 would buy nothing -- the first attempt at
# this excluded by instance and drew the same repository straight back in.
EXCLUDE_REPOS = {
    "gwtproject/gwt": "evaluation cost: >20 min for one instance (2026-09-16 gold pass); the cost is the build, not the issue",
    "ghostfolio/ghostfolio": "evaluation cost: >20 min for one instance (2026-09-16 gold pass); the cost is the build, not the issue",
    # Promoted from an instance exclusion after a SECOND instance from this repo also failed gold.
    # One gold failure is an instance; two out of two is the repository's environment on this
    # machine, and drawing a third from it would just spend another pull and another validation to
    # learn the same thing.
    "NVIDIA/OpenShell": "gold-invalid twice (OpenShell-695 and -810 both fail with the reference patch here)",
    # Drawn for v3 and disqualified by its own gold pass at 1611s -- 27 minutes for ONE instance,
    # against a median of 79s across the rest of the pin, and 72% of what evaluating all sixteen
    # existing instances costs put together. PASS_TO_PASS is 4, so almost none of that is tests:
    # it is cargo building the project, which is a property of the repository and will not improve.
    "ProvableHQ/leo": "evaluation cost: 1611s for one instance (2026-09-17 gold pass); the cost is the Rust build, not the issue",
}
# Gold-invalid is instance-specific: the reference patch fails HERE, so no model can resolve it and
# every model would spend a full rollout earning a guaranteed zero. Another instance from the same
# repo may be perfectly fine, so this does not generalise to the repository.
EXCLUDE_INSTANCES = {
    # (NVIDIA__OpenShell-695 moved to EXCLUDE_REPOS once a second instance from the same repo
    # failed the same way -- kept here as a comment so the history of the decision is readable.)
}

rev = dataset_info(DATASET).sha
ds = load_dataset(DATASET)
# STABILITY. A pinned set that reshuffles when one instance is removed is not pinned. Previously
# chosen instances are carried forward untouched (minus exclusions) and only the resulting GAPS are
# filled, so dropping one instance costs one replacement -- not a new subset. Without this, removing
# three instances displaced six, including two that had already been gold-validated at real cost.
prior = []
if PRIOR.exists():
    prior = json.loads(PRIOR.read_text()).get("instances", [])
kept = [
    i for i in prior
    if i["instance_id"] not in EXCLUDE_INSTANCES and i["repo"] not in EXCLUDE_REPOS
]
kept_ids = {i["instance_id"] for i in kept}
kept_repos = {i["repo"] for i in kept}

out, stats = [], {}
for lang in LANGS:
    rows = [
        r for r in ds[lang]
        if MIN_PS <= len(r.get("problem_statement") or "") <= MAX_PS
        and 1 <= len(r["FAIL_TO_PASS"]) <= MAX_F2P
        and len(r["PASS_TO_PASS"]) <= MAX_P2P
        and r["instance_id"] not in EXCLUDE_INSTANCES
        and r["repo"] not in EXCLUDE_REPOS
    ]
    rows.sort(key=lambda r: r["instance_id"])          # deterministic base order
    random.Random(f"{SEED}:{lang}").shuffle(rows)      # seeded, per-language
    carried = [i for i in kept if i["language"] == lang][:PER_LANG]
    picked, seen_repos = [], set(kept_repos)
    for r in rows:
        if len(carried) + len(picked) >= PER_LANG:
            break
        if r["repo"] in seen_repos or r["instance_id"] in kept_ids:
            continue
        seen_repos.add(r["repo"])
        picked.append(r)
    stats[lang] = {"eligible": len(rows), "carried": len(carried), "new": len(picked)}
    out.extend(carried)
    for r in picked:
        out.append({
            "language": lang,
            "instance_id": r["instance_id"],
            "repo": r["repo"],
            "base_commit": r["base_commit"],
            "docker_image": r["docker_image"],
            "problem_statement_chars": len(r["problem_statement"]),
            "fail_to_pass": len(r["FAIL_TO_PASS"]),
            "pass_to_pass": len(r["PASS_TO_PASS"]),
        })

out.sort(key=lambda x: (x["language"], x["instance_id"]))
manifest = {
    "schema": "llm-bench.swe-bench-live.subset",
    "version": VERSION,
    "dataset": DATASET,
    "dataset_revision": rev,
    "seed": SEED,
    "languages": LANGS,
    "per_language": PER_LANG,
    "filters": {"problem_statement_chars": [MIN_PS, MAX_PS], "fail_to_pass_max": MAX_F2P,
                "pass_to_pass_max": MAX_P2P, "max_one_instance_per_repo": True},
    "excluded_repos": EXCLUDE_REPOS,
    "excluded_instances": EXCLUDE_INSTANCES,
    # Pinned RUN parameters: these bound the measurement as much as the instance list does, so a
    # later run with a different cap is not comparable and must not silently look like one.
    "run_params": {
        # 15 minutes per instance (user, 2026-09-16): the fleet's strongest models are also its
        # slowest, and a cap tight enough to exclude them measures decode speed rather than coding.
        # 12 x 15min = 180min of rollout plus ~32min of evaluation puts a model near 212min, so six
        # configs across two cards is ~10.6h -- above the original 8h envelope, accepted so that a
        # capable-but-slow model is not scored as incapable.
        "rollout_timeout_s": 900,
        # Deliberately ABOVE what the wall clock allows, so TIME is the binding constraint and the
        # step count never is.
        #
        # 250 (mini-swe-agent's default) was chosen on the assumption of ~7-9s/step, which put 900s
        # at 100-128 steps. That assumption was wrong for the NInfer configs: they sustain ~3.6s/step
        # and hit exactly 250 steps INSIDE the wall clock on three rollouts, which were then killed
        # by the one limit this bench had promised would never bind -- and killed hardest the fastest
        # models, the opposite of the intent. 1000 would require 0.9s/step to bind, which is below
        # the cost of a single container exec, so it is unreachable for any agent loop rather than
        # merely unlikely.
        "step_limit": 1000,
        # 65536, not the fleet's usual 32768. The agent's history is linear and even with the
        # tightened observation cap a 40-step rollout lands near 50k tokens; at 32k every model
        # exhausts context before it can finish, which measures the window rather than the model.
        "ctx": 131072,
        "agent": "mini-swe-agent==2.4.6",
        # NONE since v5 (user, 2026-09-17). v1-v4 merged an overlay that cut observation truncation
        # from the agent's stock 10,000 characters to 4,000, and that deviation has now outlived its
        # reason twice over. It was sized for a 32k-then-64k served window; the pin has served
        # 131,072 since v1 was measured, and the overlay was never revisited. Reconstructing the
        # true output sizes from the `characters elided` counts the template records shows the stock
        # cap peaks at 114k tokens on the hungriest configuration -- inside the window, measured
        # rather than assumed.
        #
        # It was also not free. The tightened cap fired 71-173 times per configuration, each firing a
        # warning telling the model to go and read the file again, which costs steps in a benchmark
        # whose binding constraint is time. The worst-performing configuration had the most
        # truncations.
        #
        # So the overlay is dropped entirely rather than set to match the stock value: the run now
        # uses mini-swe-agent's packaged config unmodified, which is what SWE-bench-Live's README
        # names as protocol-compliant, and there is no local deviation left to explain.
        "agent_overlay": None,
    },
    "instance_count": len(out),
    "language_stats": stats,
    "instances": out,
}
body = json.dumps(manifest, indent=2, sort_keys=True) + "\n"
manifest["content_sha256"] = hashlib.sha256(body.encode()).hexdigest()
sys.stdout.write(json.dumps(manifest, indent=2, sort_keys=True) + "\n")
