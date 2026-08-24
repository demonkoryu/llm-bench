#!/usr/bin/env bash
# Report GPU memory as two integers on one line: "<VRAM_MiB> <spill_MiB>".
# VRAM = total used across all GPUs; spill = 0 (NVIDIA does not transparently
# spill to system RAM the way amdgpu/GTT does — OOM is a hard failure).
# Keeping the two-field format so the runner's snapshotMem() interface is unchanged.

used_mib=$(nvidia-smi --query-gpu=memory.used --format=csv,noheader,nounits 2>/dev/null \
   | awk '{s+=$1} END {print int(s)}')

echo "${used_mib:-0} 0"
