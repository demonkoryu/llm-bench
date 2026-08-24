#!/usr/bin/env bash
# Report VRAM used in MiB (summed across all GPUs). Prints a single integer to stdout.
# Uses nvidia-smi for NVIDIA GPUs (2x Tesla V100 PCIe 32GB).
# Exits non-zero if nvidia-smi is not available or fails.

used_mib=$(nvidia-smi --query-gpu=memory.used --format=csv,noheader,nounits 2>/dev/null \
   | awk '{s+=$1} END {print int(s)}')

if [ -z "$used_mib" ] || [ "$used_mib" = "0" ]; then
   echo "0"
   exit 1
fi
echo "$used_mib"
