#!/usr/bin/env bash
# Stop the ninfer-serve container for one GPU. Idempotent; never fails the caller.
# Usage: stop-server.sh --device N
set -u
device=0
while [[ $# -gt 0 ]]; do
   case "$1" in
      --device) device="$2"; shift 2 ;;
      *) shift ;;
   esac
done
CONTAINER="ninfer-d${device}"
docker stop -t 10 "$CONTAINER" >/dev/null 2>&1 || true
docker rm -f "$CONTAINER" >/dev/null 2>&1 || true
rm -f "/tmp/ninfer-d${device}.lock"
echo "stopped ${CONTAINER}"
