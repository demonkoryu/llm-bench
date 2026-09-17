#!/usr/bin/env python3
"""Materialise the local working set a pinned subset needs: subset.jsonl and images.txt.

The EVALUATION harness reads a local dataset file rather than the hub (the agent reads the hub; see
benches/swe_live.mjs for why the two differ), and the Docker images have to be on the box before a
rollout can start. Both are derived entirely from the manifest, so they are regenerated rather than
edited -- which is the point: when the pin grows, this is the one command that brings the machine's
working set back in line with it instead of a hand-written list that drifts.

Additive by design. Existing rows are rewritten from the dataset rather than preserved, so a row
cannot go stale relative to the pin; but nothing pinned is ever dropped, and the image list is
emitted in full so pull-images.sh can skip what is already present.

Usage: materialize.py [--manifest subset-v2.json] [--out /home/demonkoryu/.local/state/swe-live]
"""
import argparse, json
from pathlib import Path

from datasets import load_dataset

ap = argparse.ArgumentParser()
ap.add_argument("--manifest", default=str(Path(__file__).with_name("subset-v2.json")))
ap.add_argument("--out", default="/home/demonkoryu/.local/state/swe-live")
args = ap.parse_args()

manifest = json.loads(Path(args.manifest).read_text())
want = {i["instance_id"]: i["language"] for i in manifest["instances"]}
out = Path(args.out)

ds = load_dataset(manifest["dataset"])
rows = {}
for lang in sorted({v for v in want.values()}):
    for r in ds[lang]:
        if r["instance_id"] in want:
            rows[r["instance_id"]] = r

missing = sorted(set(want) - set(rows))
if missing:
    # Loud rather than a short file: a silently shorter subset.jsonl means the harness scores a
    # model over fewer instances than the manifest claims, which is a wrong denominator, not a
    # smaller run.
    raise SystemExit(f"materialize: {len(missing)} pinned instances are not in the dataset: {missing}")

# Sorted by instance_id so the file is stable across runs and a diff shows only real changes.
with (out / "subset.jsonl").open("w") as fh:
    for iid in sorted(rows):
        fh.write(json.dumps(rows[iid]) + "\n")

with (out / "images.txt").open("w") as fh:
    for i in sorted(manifest["instances"], key=lambda x: x["instance_id"]):
        fh.write(i["docker_image"] + "\n")

print(f"subset.jsonl: {len(rows)} instances")
print(f"images.txt:   {len(manifest['instances'])} images")
