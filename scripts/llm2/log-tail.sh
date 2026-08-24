#!/usr/bin/env bash
# Tail the server log and check for crash indicators.
# Usage:  log-tail.sh [--lines <N>]
# Exits:  0 = no crash detected, 2 = crash pattern found

CONTAINER="${LLAMA_CONTAINER:-llama-server}"
lines=30

while [[ $# -gt 0 ]]; do
   case "$1" in
      --lines) lines="$2"; shift 2 ;;
      *) shift ;;
   esac
done

if ! docker ps -a -q -f "name=^${CONTAINER}$" 2>/dev/null | grep -q .; then
   exit 0
fi

docker logs --tail "$lines" "$CONTAINER" 2>&1

if docker logs --tail 100 "$CONTAINER" 2>&1 | \
   grep -qiE 'out of memory|GGML_ASSERT|CUDA error|CUBLAS error|failed to load|segmentation fault|Segmentation fault|killed|SIGABRT|cudaMalloc failed'; then
   echo "  [log-tail] CRASH PATTERN detected" >&2
   exit 2
fi
exit 0
