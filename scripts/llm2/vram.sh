#!/usr/bin/env bash
# Report VRAM used in MiB. Prints a single integer to stdout.
# Works for AMD GPUs regardless of inference backend (ROCm or Vulkan).
# Exits non-zero if rocm-smi is not available or fails.

used_bytes=$(rocm-smi --showmeminfo vram --json 2>/dev/null | \
   python3 -c "
import sys, json
d = json.load(sys.stdin)
card = list(d.values())[0]
print(card.get('VRAM Total Used Memory (B)', '0'))
" 2>/dev/null)

if [ -z "$used_bytes" ] || [ "$used_bytes" = "0" ]; then
   # Fallback: try rocm-smi text output
   used_bytes=$(rocm-smi --showmemuse 2>/dev/null | \
      grep -oP 'GPU\[0\].*?(\d+)\s*MiB' | grep -oP '\d+' | tail -1)
   if [ -z "$used_bytes" ]; then
      echo "0"
      exit 1
   fi
   echo "$used_bytes"
else
   echo $(( used_bytes / 1048576 ))
fi
