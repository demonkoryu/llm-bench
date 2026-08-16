#!/usr/bin/env python3
"""Effective bits-per-weight of the SERVED text tower, measured from the safetensors headers.

Logical parameter count cannot be read off the packed uint32 weight shapes, because OptiQ assigns
bits per layer and the packing factor therefore varies tensor by tensor. It IS recoverable from the
`.scales` sibling, which is [out_features, n_groups] regardless of bit width: logical in-features is
n_groups * group_size. Non-quantized tensors (norms, embeddings left in fp) are counted directly.

Bytes are the index total_size, i.e. the sharded model-*.safetensors only. The optiq/ sidecars
(vision tower, MTP drafter) are deliberately excluded: they are on disk but are not served on the
text-only path these benches use.
"""
import json
import os
import struct
import sys
from glob import glob

GROUP_SIZE_FALLBACK = 64


def header(path):
    with open(path, "rb") as fh:
        n = struct.unpack("<Q", fh.read(8))[0]
        return json.loads(fh.read(n))


def measure(snap):
    cfg = json.load(open(os.path.join(snap, "config.json")))
    gs = (cfg.get("quantization") or {}).get("group_size", GROUP_SIZE_FALLBACK)

    tensors = {}
    for shard in sorted(glob(os.path.join(snap, "model-*.safetensors"))):
        for name, meta in header(shard).items():
            if name != "__metadata__":
                tensors[name] = meta["shape"]

    scales = {n[: -len(".scales")]: s for n, s in tensors.items() if n.endswith(".scales")}
    params = 0
    for base, shape in scales.items():
        out, ngroups = shape[0], shape[1]
        params += out * ngroups * gs                      # logical weight, bit-width agnostic
        for suffix in (".scales", ".biases"):             # quantizer metadata, real stored numbers
            if base + suffix in tensors:
                s = tensors[base + suffix]
                params += s[0] * s[1] if len(s) > 1 else s[0]
    for name, shape in tensors.items():
        base = name.rsplit(".", 1)[0]
        if name.endswith((".scales", ".biases")) or base in scales:
            continue
        n = 1
        for d in shape:
            n *= d
        params += n

    total_size = json.load(open(os.path.join(snap, "model.safetensors.index.json")))["metadata"]["total_size"]
    # bpw is quoted against the LOGICAL weight count (what "27B params" means), not against the
    # stored-number count, so the quantizer's own scales/biases show up as overhead in the figure.
    logical = sum(s[0] * s[1] * gs for s in scales.values())
    for name, shape in tensors.items():
        base = name.rsplit(".", 1)[0]
        if name.endswith((".scales", ".biases")) or base in scales:
            continue
        n = 1
        for d in shape:
            n *= d
        logical += n
    return total_size, logical, gs


print(f"{'model':<26}{'MB(text)':>10}{'params':>14}{'bpw':>8}  group")
for m in sys.argv[1:]:
    snaps = glob(os.path.expanduser(f"~/.cache/huggingface/hub/models--mlx-community--{m}/snapshots/*"))
    if not snaps:
        print(f"{m:<26} not cached")
        continue
    size, logical, gs = measure(snaps[0])
    print(f"{m:<26}{size / 1048576:>10.1f}{logical:>14,}{size * 8 / logical:>8.2f}  {gs}")
