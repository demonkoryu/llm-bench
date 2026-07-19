#!/usr/bin/env bash
# Report GPU memory as two integers on one line: "<VRAM_MiB> <GTT_MiB>".
# VRAM = dedicated card memory; GTT = system RAM the amdgpu driver has mapped for the GPU.
# GTT matters because amdgpu SPILLS allocations that don't fit VRAM into GTT (system RAM)
# transparently instead of failing — so a large GTT figure means the model/KV is running
# partly on slow system RAM, i.e. it does NOT truly fit in VRAM. Prints "0 0" on failure.
read -r vram gtt < <(rocm-smi --showmeminfo vram gtt --json 2>/dev/null | python3 -c "
import sys, json
try:
    d = json.load(sys.stdin)
    card = list(d.values())[0]
    v = int(card.get('VRAM Total Used Memory (B)', 0)) // 1048576
    g = int(card.get('GTT Total Used Memory (B)', 0)) // 1048576
    print(v, g)
except Exception:
    print(0, 0)
" 2>/dev/null)
echo "${vram:-0} ${gtt:-0}"
