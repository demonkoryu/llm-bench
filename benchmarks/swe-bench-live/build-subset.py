#!/usr/bin/env python3
"""Build the PINNED SWE-bench-Live subset. Run once per version; the output is committed.

Comparability is the whole point of this file. Every model must attempt the identical instance list,
so the selection is fully deterministic (fixed seed, sorted inputs) and the result is checked in --
re-running this must reproduce the committed subset-v{VERSION}.json's INSTANCE LIST exactly, and if
the upstream dataset changes it will not, which is exactly the signal we want.

The one field that legitimately differs on a rebuild is `language_stats`, and knowing that saves
mistaking a benign diff for a real one. It records how the build WENT, not what the pin IS: on the
first build of a bump the new language reads carried=0/new=5, and on any rebuild it reads
carried=5/new=0, because PRIOR is by then the bump's own file. Nothing consumes it; it is provenance.
Compare `instances` when you want the real answer.

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

v7 takes cpp from 3 back to 5 (n=25), by user decision after v6 published. It is a genuine trade
against v6's reasoning rather than a correction of it: the two extra instances are worth whatever
they cost to evaluate, because a language contributing 3 where the others contribute 5 moves its rate
in 33-point steps and reads as an afterthought on the page. v6 stays checked in and is what the
2026-09-18 n=23 results were measured against.

v6 adds a FIFTH LANGUAGE, cpp, at 3 instances rather than 5 (n=23) -- see PER_LANG_OVERRIDE for why.
run_params are unchanged from v5, which is the whole point: the rollout ledger's budget covers the
run parameters and not the instance list, so every one of the twenty v5 rollouts carries forward from
disk and only the three new ones have to run -- three rollouts per configuration rather than
twenty-three.

Its value is COVERAGE, not precision, and the distinction is worth being honest about. n=23 moves
one instance from 5.0 to 4.3 points and narrows the half-width by about a fourteenth; it does not
make any pair of models distinguishable. On the v5 results the best-separated pair (11/20 against 7/20)
differs on 6 instances against 2, which is McNemar p=0.29, and separating it at 80% power would take
roughly 72 instances. Only 8 of the 20 v5 instances discriminate between the six configurations at
all: 7 were solved by none of them and 5 by all of them. What cpp adds instead is a build-and-link
toolchain that none of go, java, ts or rust exercises -- the dataset carries eight languages and the
pin had been silent about half of them (c, cpp, js, cs).

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
LANGS = ["go", "java", "ts", "rust", "cpp"]
VERSION = 7
PER_LANG = 5
# Languages whose target differs from PER_LANG, with the reason it does.
#
# cpp is 3, not 5, and that asymmetry is a FINDING rather than a compromise. Nine cpp candidates were
# gold-evaluated: three cost 29-111s, four cost 590-951s, and two were gold-invalid. Evaluation runs
# once per configuration benchmarked, forever, so the four expensive ones would have added ~54-74% to
# the whole pin's evaluation cost for two of its instances. Holding the pin's own cost bar (444s, its
# worst kept instance) simply leaves cpp with three affordable instances, and that is the honest shape
# of this language in this dataset -- go/java/ts/rust each had five at a median of ~79s.
#
# The cost: a cpp rate moves in steps of 33 points instead of 20. The page says so, and an uneven pin
# that states its unevenness beats an even one that had to spend a third of the evaluation budget on
# one language to get there.
# EMPTY as of v7: cpp is back to the common 5. The override and its reasoning are kept above as the
# history of the decision -- the four expensive cpp repos remain excluded in EXCLUDE_REPOS, so v7
# fills the two restored slots from the rest of the pool and pays whatever they cost.
PER_LANG_OVERRIDE = {}


def target_for(lang):
    """How many instances this language should contribute."""
    return PER_LANG_OVERRIDE.get(lang, PER_LANG)


SEED = 20260916

# The pin to carry forward (see the selection loop). Prefer this version's own file so that
# re-running an already-built version reproduces it; fall back to the previous version's file, which
# is the state when a bump is being built for the first time. The seed is deliberately NOT bumped
# with the version: the shuffle order has to stay fixed, or "carry v1 forward and fill the gaps"
# would fill them from a differently-ordered candidate list and the extension would not be
# reproducible from the previous pin.
_HERE = Path(__file__).parent


def _usable(path):
    """A candidate PRIOR that actually parses and carries instances.

    Existence is not enough, because the documented invocation is
    `build-subset.py > subset-v{VERSION}.json` and the SHELL CREATES THAT FILE, EMPTY, BEFORE python
    starts. A plain exists() check then resolves PRIOR to the empty output file rather than falling
    back to the previous version, and the run dies on a JSONDecodeError pointing at the file it was
    about to write. Treating an empty or unparseable candidate as absent makes the documented usage
    work; a HALF-WRITTEN prior from an interrupted run is caught the same way.
    """
    try:
        return bool(json.loads(path.read_text()).get("instances")) if path.exists() else False
    except (json.JSONDecodeError, OSError):
        return False


PRIOR = next(
    (p for p in (_HERE / f"subset-v{VERSION}.json", _HERE / f"subset-v{VERSION - 1}.json") if _usable(p)),
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
    # The v6 cpp draw, on cost (2026-09-18, user decision). Both PASSED gold and both sit under the
    # ~20-minute bar that excluded gwt and ghostfolio -- they are excluded on the AGGREGATE instead.
    # Together they cost 1703s, which would have taken the pin's evaluation total from 2572s to
    # 4470s (+74%) for two of twenty-five instances, i.e. ~2.8h of extra evaluation per six-config
    # sweep, forever.
    #
    # The working bar for this round is the pin's own worst KEPT instance, antvis__G2-7076 at 444s:
    # anything materially above what the pin already tolerates is out of line by the pin's own
    # standard, which is a defensible threshold rather than an invented one. In C++ the BUILD is the
    # cost, so this is a repository exclusion -- swapping one instance for another from the same repo
    # would buy nothing.
    "WasmEdge/WasmEdge": "evaluation cost: 752s for WasmEdge-4772 (2026-09-18 v6 cpp gold pass); gold-valid, excluded on cost",
    "kvcache-ai/Mooncake": "evaluation cost: 951s for Mooncake-2892 (2026-09-18 v6 cpp gold pass); gold-valid, excluded on cost",
    # The second cost round, and the one that settled the question (2026-09-18, user decision). Both
    # passed gold and came in cheaper than WasmEdge/Mooncake, but still 590-609s against the pin's
    # worst kept instance at 444s. By then NINE cpp candidates had been evaluated and the
    # distribution was plainly bimodal: three at 29-111s, four at 590-951s, two gold-invalid. In C++
    # the BUILD is the cost, so a cheap instance means a repository whose image ships usable
    # artifacts and an expensive one means a repository that recompiles -- which is a property of the
    # repository, not of the issue, and no amount of redrawing within a repo changes it.
    #
    # Rather than keep probing a 1-in-3 hit rate, cpp was capped at its three affordable instances
    # (see PER_LANG_OVERRIDE). That is the honest shape of this language in this dataset.
    "duckdb/ducklake": "evaluation cost: 609s for ducklake-1340 (2026-09-18 v6 cpp gold pass); gold-valid, excluded on cost",
    "stephenberry/glaze": "evaluation cost: 590s for glaze-2611 (2026-09-18 v6 cpp gold pass); gold-valid, excluded on cost",
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
    #
    # The v6 cpp draw failed gold on TWO of its five (2026-09-18), against zero for the go/java/ts/rust
    # draws before it. Both are cheap to evaluate, so this is not a cost exclusion: the reference patch
    # simply does not make the tests pass on this machine, which means no model can resolve them and
    # every model would spend a full rollout earning a guaranteed zero. Instance-scoped, not
    # repo-scoped -- another instance from either repo may be perfectly fine.
    "actor-framework__actor-framework-2300": "gold-invalid (2026-09-18 v6 cpp pass; 29s, resolved=False with the reference patch)",
    "OpenRCT2__OpenRCT2-26315": "gold-invalid (2026-09-18 v6 cpp pass; 67s, resolved=False with the reference patch)",
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
    want = target_for(lang)
    carried = [i for i in kept if i["language"] == lang][:want]
    picked, seen_repos = [], set(kept_repos)
    for r in rows:
        if len(carried) + len(picked) >= want:
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
    # A MAP, not a scalar, since v6: cpp contributes 3 where the others contribute 5. Consumers
    # must handle both shapes -- v1-v5 emitted a bare int and those files stay checked in.
    "per_language": {lang: target_for(lang) for lang in LANGS},
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
