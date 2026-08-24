#!/usr/bin/env bash
# Aggressive cleanup: kill llama-server container, release lockfile.
# Usage: kill-all.sh [--port <N>]
CONTAINER="${LLAMA_CONTAINER:-llama-server}"
LOCKFILE=/tmp/llama-server.lock
port=8090

while [[ $# -gt 0 ]]; do
   case "$1" in
      --port) port="$2"; shift 2 ;;
      *) shift ;;
   esac
done

docker kill "$CONTAINER" 2>/dev/null || true
docker rm -f "$CONTAINER" 2>/dev/null || true
fuser -k "$port/tcp" 2>/dev/null || true
rm -f "$LOCKFILE"

echo "  [kill-all] done" >&2
