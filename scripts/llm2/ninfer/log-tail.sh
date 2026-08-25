#!/usr/bin/env bash
# Tail one ninfer instance's container log; exit 2 if it looks crashed.
# Usage: log-tail.sh --device N [--lines K]
set -u
device=0
lines=40
while [[ $# -gt 0 ]]; do
   case "$1" in
      --device) device="$2"; shift 2 ;;
      --lines)  lines="$2";  shift 2 ;;
      *) shift ;;
   esac
done
CONTAINER="ninfer-d${device}"
out=$(docker logs --tail "$lines" "$CONTAINER" 2>&1 || true)
echo "$out"
# Exit 2 signals "crashed" to the runner's hasCrashed(). A container that has exited is the
# strongest signal; the string patterns cover a process still up but wedged after a fatal alloc.
running=$(docker inspect -f '{{.State.Running}}' "$CONTAINER" 2>/dev/null || echo "false")
if [ "$running" != "true" ]; then
   exit 2
fi
if echo "$out" | grep -qiE 'CUDA error|out of memory|cudaError|terminate called|Aborted|std::bad_alloc'; then
   exit 2
fi
exit 0
