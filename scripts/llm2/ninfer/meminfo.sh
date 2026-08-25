#!/usr/bin/env bash
# Prints "VRAM_MiB GTT_MiB" for one GPU, matching ../meminfo.sh's contract.
# GTT is always 0 on NVIDIA: there is no transparent spill to host RAM, so a CUDA OOM is a
# hard failure rather than a slow path. Usage: meminfo.sh --device N
set -u
device=0
while [[ $# -gt 0 ]]; do
   case "$1" in
      --device) device="$2"; shift 2 ;;
      *) shift ;;
   esac
done
v=$(nvidia-smi -i "$device" --query-gpu=memory.used --format=csv,noheader,nounits 2>/dev/null | awk 'NR==1{print int($1)}')
echo "${v:-0} 0"
