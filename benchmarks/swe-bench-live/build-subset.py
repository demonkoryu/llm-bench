#!/usr/bin/env python3
"""Build the PINNED SWE-bench-Live subset. Run once; the output is committed and never regenerated.

Comparability is the whole point of this file. Every model must attempt the identical instance list,
so the selection is fully deterministic (fixed seed, sorted inputs) and the result is checked in --
re-running this must reproduce subset-v1.json byte-for-byte, and if the upstream dataset changes it
will not, which is exactly the signal we want.

Selection rules, in order:
  * four languages (go, java, ts, rust), three instances each = 12
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
from datasets import load_dataset
from huggingface_hub import dataset_info

DATASET = "SWE-bench-Live/MultiLang"
LANGS = ["go", "java", "ts", "rust"]
PER_LANG = 3
SEED = 20260916
MIN_PS, MAX_PS = 200, 8000
MAX_F2P = 50      # resolution requires ALL of them to pass
MAX_P2P = 2000    # bounds how long one evaluation takes

rev = dataset_info(DATASET).sha
ds = load_dataset(DATASET)
out, stats = [], {}
for lang in LANGS:
    rows = [
        r for r in ds[lang]
        if MIN_PS <= len(r.get("problem_statement") or "") <= MAX_PS
        and 1 <= len(r["FAIL_TO_PASS"]) <= MAX_F2P
        and len(r["PASS_TO_PASS"]) <= MAX_P2P
    ]
    rows.sort(key=lambda r: r["instance_id"])          # deterministic base order
    random.Random(f"{SEED}:{lang}").shuffle(rows)      # seeded, per-language
    picked, seen_repos = [], set()
    for r in rows:
        if r["repo"] in seen_repos:
            continue
        seen_repos.add(r["repo"])
        picked.append(r)
        if len(picked) == PER_LANG:
            break
    stats[lang] = {"eligible": len(rows), "picked": len(picked)}
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
    "version": 1,
    "dataset": DATASET,
    "dataset_revision": rev,
    "seed": SEED,
    "languages": LANGS,
    "per_language": PER_LANG,
    "filters": {"problem_statement_chars": [MIN_PS, MAX_PS], "fail_to_pass_max": MAX_F2P,
                "pass_to_pass_max": MAX_P2P, "max_one_instance_per_repo": True},
    # Pinned RUN parameters: these bound the measurement as much as the instance list does, so a
    # later run with a different cap is not comparable and must not silently look like one.
    "run_params": {
        # 12 x 5min = 60min of rollout, leaving the rest of the ~120min/model budget for Docker
        # evaluation, which is NOT free: every patch has to be tested, and host RAM (16 GB per
        # instance against 47 GB available, minus what the model server pins) allows only ONE eval
        # worker per lane. Sizing the rollout cap without that half is how the first plan reached
        # ~14h against an 8h budget.
        "rollout_timeout_s": 300,
        "step_limit": 30,
        "ctx": 32768,
        "agent": "mini-swe-agent==2.4.6",
    },
    "instance_count": len(out),
    "language_stats": stats,
    "instances": out,
}
body = json.dumps(manifest, indent=2, sort_keys=True) + "\n"
manifest["content_sha256"] = hashlib.sha256(body.encode()).hexdigest()
sys.stdout.write(json.dumps(manifest, indent=2, sort_keys=True) + "\n")
