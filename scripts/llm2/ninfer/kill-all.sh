#!/usr/bin/env bash
# Force-remove one GPU's ninfer container and free its port. Usage: kill-all.sh --device N [--port P]
set -u
device=0
port=""
while [[ $# -gt 0 ]]; do
   case "$1" in
      --device) device="$2"; shift 2 ;;
      --port)   port="$2";   shift 2 ;;
      *) shift ;;
   esac
done
[ -n "$port" ] || port=$((8100 + device))
docker kill "ninfer-d${device}" >/dev/null 2>&1 || true
docker rm -f "ninfer-d${device}" >/dev/null 2>&1 || true
fuser -k "${port}/tcp" >/dev/null 2>&1 || true
rm -f "/tmp/ninfer-d${device}.lock"
echo "killed ninfer-d${device}"
