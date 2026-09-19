#!/usr/bin/env python3
"""Build the PINNED IFEval-FC subset. Run once per version; the output is committed.

Same doctrine as benchmarks/swe-bench-live/build-subset.py: comparability is the point, so the
selection is fully deterministic (fixed seed, sorted inputs) and the result is checked in. Every
configuration must attempt the identical case list, or the numbers are not comparable.

WHY A SUBSET AT ALL. The full benchmark is 750 cases (150 functions x 5 user queries). Across the 12
active configurations and their think states that is 23 generation passes, so 17,250 generations --
15-40 GPU-hours with both cards offline. This pin takes 2 functions per checker instead of 10, which
is 150 cases and 3,450 generations, and keeps the think/no-think contrast that is the interesting
axis for a formatting task.

WHY STRATIFY BY CHECKER. The upstream set is exactly balanced: 15 checkers x 10 functions. Sampling
cases at random would let that balance drift, and a rate computed over an unbalanced mix of
JsonFormatChecker (easy) and SpacesInBetweenChecker (adversarial) is not a number anyone can
interpret. Taking a fixed 2 functions from each checker preserves the property that makes the
aggregate meaningful, and keeps the per-checker breakdown at a usable 10 cases each.

ALL FIVE QUERIES PER FUNCTION ARE KEPT. The five queries of a function share one schema and one
format constraint, so they are repeated trials of the same instruction under different phrasings --
which is exactly the run-to-run variance a single-sample benchmark normally hides. Dropping to one
query per function would buy twice the function count for the same cost and throw that away.

IDENTITY IS THE UPSTREAM FILENAME, NOT THE FUNCTION NAME. Function names are reused: 115 distinct
names across 150 rows, 28 of them appearing more than once with a different parameter or a different
checker. `provide_dietary_advice` is in this pin twice, once under KeywordsPresenceChecker and once
under WordCountChecker, both on the same parameter. Keying carry-forward or exclusions on the name
would therefore move or drop cases nobody asked about, so both key on upstream's `filename`, which is
unique by construction (function + param + checker).

VERIFICATION IS NOT OURS. The graders are upstream's own, vendored under vendor/IFEval_FC at the
commit in vendor/UPSTREAM_COMMIT, and upstream's test suite runs against the vendored copy. Checkers
like SentenceCountChecker and NAllCapitalWordsChecker have semantics ("what is a word", "what is a
sentence") that a reimplementation from the prose descriptions would plausibly get subtly wrong, and
a subtly wrong grader is worse than no grader because it still produces a number.
"""
import hashlib, json, random, sys
from pathlib import Path

from datasets import load_dataset
from huggingface_hub import dataset_info

DATASET = "NikolaiSkripko/IFEval-FC"
VERSION = 1
FUNCTIONS_PER_CHECKER = 2
SEED = 20260918

_HERE = Path(__file__).parent


def _usable(path):
    """A candidate PRIOR that parses and carries cases.

    Existence alone is not enough: the documented invocation redirects stdout to the output file, and
    the shell creates that file EMPTY before python starts. The swe-bench-live builder died on
    exactly this.
    """
    try:
        return bool(json.loads(path.read_text()).get("cases")) if path.exists() else False
    except (json.JSONDecodeError, OSError):
        return False


PRIOR = next(
    (p for p in (_HERE / f"subset-v{VERSION}.json", _HERE / f"subset-v{VERSION - 1}.json") if _usable(p)),
    _HERE / f"subset-v{VERSION}.json",
)

# Cases removed after measurement, keyed by CASE ID (upstream's filename stem), with the reason.
# Empty so far. The analogue of swe-bench-live's gold-invalid exclusions would be a schema the
# serving stack cannot present as a tool, or a checker that errors on every value.
EXCLUDE_CASES = {}

rev = dataset_info(DATASET).sha
ds = load_dataset(DATASET, split="train")

# Carry the prior pin forward and fill only the gaps, so dropping one function costs one replacement
# rather than a whole new subset.
prior_ids = []
if PRIOR.exists():
    try:
        prior_ids = [c["case_id"] for c in json.loads(PRIOR.read_text()).get("cases", [])]
    except (json.JSONDecodeError, KeyError, OSError):
        prior_ids = []
kept_ids = {i for i in prior_ids if i not in EXCLUDE_CASES}

rows = []
for r in ds:
    fmt = r["format"] if isinstance(r["format"], dict) else json.loads(r["format"])
    schema = r["fn_schema"] if isinstance(r["fn_schema"], dict) else json.loads(r["fn_schema"])
    case_id = r["filename"].removesuffix(".json")
    if case_id in EXCLUDE_CASES:
        continue
    rows.append(
        {
            "case_id": case_id,
            "function": schema["name"],
            "checker": fmt["name"],
            "group": fmt["group"],
            "args": fmt["args"] if isinstance(fmt["args"], dict) else json.loads(fmt["args"]),
            "description": fmt["description"],
            "chosen_param": r["chosen_param"],
            "fn_schema": schema,
            "user_queries": list(r["user_queries"]),
        }
    )

by_checker = {}
for r in rows:
    by_checker.setdefault(r["checker"], []).append(r)

out, stats = [], {}
for checker in sorted(by_checker):
    cand = sorted(by_checker[checker], key=lambda r: r["case_id"])   # deterministic base order
    random.Random(f"{SEED}:{checker}").shuffle(cand)                 # seeded, per-checker
    carried = [r for r in cand if r["case_id"] in kept_ids][:FUNCTIONS_PER_CHECKER]
    picked = []
    for r in cand:
        if len(carried) + len(picked) >= FUNCTIONS_PER_CHECKER:
            break
        if r["case_id"] in kept_ids:
            continue
        picked.append(r)
    stats[checker] = {"eligible": len(cand), "carried": len(carried), "new": len(picked)}
    out.extend(carried + picked)

out.sort(key=lambda r: (r["checker"], r["case_id"]))
upstream = _HERE / "vendor" / "UPSTREAM_COMMIT"
manifest = {
    "schema": "llm-bench.ifeval-fc.subset",
    "version": VERSION,
    "dataset": DATASET,
    "dataset_revision": rev,
    "upstream_checkers_commit": upstream.read_text().strip() if upstream.exists() else None,
    "seed": SEED,
    "functions_per_checker": FUNCTIONS_PER_CHECKER,
    "checkers": sorted(by_checker),
    # Pinned RUN parameters: these bound the measurement as much as the case list does, so a later
    # run with a different budget is not comparable and must not silently look like one.
    "run_params": {
        # 4096, not 1024. At 1024 the THINK pass collapsed: Qwen3.6-35B-A3B emitted zero tool calls
        # in think mode while scoring 6/6 in no-think, and every configuration was equal or worse
        # with thinking on. Reasoning consumes the budget before the call is ever emitted, so the
        # number measured the budget rather than the model. This repo already had the lesson written
        # down -- benches/toolcalling.mjs runs 2048 with a comment about exactly this, and
        # struct_output went 256 -> 41.67%, 1024 -> 91.67%, 4096 -> 100% on Muse-Glimmer. A model
        # that stops early costs nothing here; only one that needed the room is affected.
        "max_tokens": 4096,
        # One tool per case, exactly as upstream's evaluate.py binds a single schema.
        "tool_protocol": "single-tool, native tool calling",
        "queries_per_function": 5,
    },
    # entry_count counts (function, param, checker) triples; distinct_functions is lower because
    # upstream reuses function names across entries.
    "entry_count": len(out),
    "distinct_functions": len({r["function"] for r in out}),
    "case_count": sum(len(r["user_queries"]) for r in out),
    "excluded_cases": EXCLUDE_CASES,
    "checker_stats": stats,
    "cases": out,
}
body = json.dumps(manifest, indent=2, sort_keys=True) + "\n"
manifest["content_sha256"] = hashlib.sha256(body.encode()).hexdigest()
sys.stdout.write(json.dumps(manifest, indent=2, sort_keys=True) + "\n")
