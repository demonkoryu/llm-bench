#!/usr/bin/env bash
# Tail the server log and check for crash indicators.
# Usage:  log-tail.sh [--lines <N>]
# Exits:  0 = no crash detected, 2 = crash pattern found

lines=30
while [[ $# -gt 0 ]]; do
   case "$1" in
      --lines) lines="$2"; shift 2 ;;
      *) shift ;;
   esac
done

LOG=/tmp/llamasrv.log
if [ ! -f "$LOG" ]; then exit 0; fi

tail -n "$lines" "$LOG"

# Check for crash/OOM patterns
if grep -qiE 'out of memory|GGML_ASSERT|HIP error|vulkan.*error|failed to load|segmentation fault|Segmentation fault|killed|SIGABRT' "$LOG" 2>/dev/null; then
   echo "  [log-tail] CRASH PATTERN detected" >&2
   exit 2
fi
exit 0
