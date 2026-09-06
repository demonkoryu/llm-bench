#!/usr/bin/env bash
# Report VRAM used in MiB. Prints a single integer to stdout.
#
# With --device N it reports ONE card; without it, the host-wide sum (the historical
# behaviour, kept so an un-scoped caller reads exactly what it always did). Scoping matters
# whenever both V100s are serving at once: a host-wide sum would attribute the peer model's
# resident weights to whichever model is being measured, silently inflating every vram_mib
# and KV-footprint row. Same reasoning as scripts/llm2/ninfer/vram.sh, which is per-device
# unconditionally because that engine is never host-wide.
# Usage: vram.sh [--device N]
# Exits non-zero if nvidia-smi is not available or fails.

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

if [ -z "$used_mib" ] || [ "$used_mib" = "0" ]; then
   echo "0"
   exit 1
fi
echo "$used_mib"
