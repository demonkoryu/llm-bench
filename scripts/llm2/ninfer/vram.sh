#!/usr/bin/env bash
# VRAM used in MiB on ONE GPU (not summed across the host).
#
# Device scoping is the whole point: this host runs an independent ninfer instance per V100,
# so a host-wide sum (as ../vram.sh does) would attribute the peer instance's resident weights
# to whichever model is being measured -- silently inflating every VRAM and KV-footprint row.
# Usage: vram.sh --device N
set -u
device=0
while [[ $# -gt 0 ]]; do
   case "$1" in
      --device) device="$2"; shift 2 ;;
      *) shift ;;
   esac
done
nvidia-smi -i "$device" --query-gpu=memory.used --format=csv,noheader,nounits 2>/dev/null | awk 'NR==1{print int($1)}'
