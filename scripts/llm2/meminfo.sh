#!/usr/bin/env bash
# Report GPU memory as two integers on one line: "<VRAM_MiB> <spill_MiB>".
# VRAM = used on --device N, or summed across all GPUs when no device is given;
# spill = 0 (NVIDIA does not transparently spill to system RAM the way amdgpu/GTT
# does — OOM is a hard failure). Keeping the two-field format so the runner's
# snapshotMem() interface is unchanged. See vram.sh for why the scoping exists.
# Usage: meminfo.sh [--device N]

device=""
while [[ $# -gt 0 ]]; do
   case "$1" in
      --device) device="$2"; shift 2 ;;
      *) shift ;;
   esac
done

if [ -n "$device" ]; then
   used_mib=$(nvidia-smi -i "$device" --query-gpu=memory.used --format=csv,noheader,nounits 2>/dev/null \
      | awk 'NR==1{print int($1)}')
else
   used_mib=$(nvidia-smi --query-gpu=memory.used --format=csv,noheader,nounits 2>/dev/null \
      | awk '{s+=$1} END {print int(s)}')
fi

echo "${used_mib:-0} 0"
