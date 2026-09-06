#!/usr/bin/env bash
# Aggressive cleanup: kill llama-server container, release lockfile.
# Usage: kill-all.sh [--port <N>] [--device <N>]
port=8090
device=0

while [[ $# -gt 0 ]]; do
   case "$1" in
      --port)   port="$2";   shift 2 ;;
      --device) device="$2"; shift 2 ;;
      *) shift ;;
   esac
done

CONTAINER="${LLAMA_CONTAINER:-llama-server-d${device}}"
LOCKFILE="/tmp/llama-server-d${device}.lock"

docker kill "$CONTAINER" 2>/dev/null || true
docker rm -f "$CONTAINER" 2>/dev/null || true
fuser -k "$port/tcp" 2>/dev/null || true
rm -f "$LOCKFILE"

echo "  [kill-all] done" >&2
