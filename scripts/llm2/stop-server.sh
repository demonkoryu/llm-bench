#!/usr/bin/env bash
# Stop the tracked llama-server container and clean up.
# Usage: stop-server.sh [--port <N>]
set -e

CONTAINER="${LLAMA_CONTAINER:-llama-server}"
port=8090

while [[ $# -gt 0 ]]; do
   case "$1" in
      --port) port="$2"; shift 2 ;;
      *) shift ;;
   esac
done

if docker ps -q -f "name=^${CONTAINER}$" 2>/dev/null | grep -q .; then
   echo "  [stop-server] stopping container $CONTAINER" >&2
   docker stop -t 10 "$CONTAINER" 2>/dev/null || true
fi
docker rm -f "$CONTAINER" 2>/dev/null || true
fuser -k "$port/tcp" 2>/dev/null || true

echo "  [stop-server] done" >&2
