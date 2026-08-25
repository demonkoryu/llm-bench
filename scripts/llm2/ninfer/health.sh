#!/usr/bin/env bash
# Poll GET /health on a ninfer-serve instance until ready. Prints "ready" or "timeout".
# Usage: health.sh --url http://host:port --timeout <seconds>
set -u
url="http://127.0.0.1:8100"
timeout=300
while [[ $# -gt 0 ]]; do
   case "$1" in
      --url)     url="$2";     shift 2 ;;
      --timeout) timeout="$2"; shift 2 ;;
      *) shift ;;
   esac
done
deadline=$((SECONDS + timeout))
while [ $SECONDS -lt $deadline ]; do
   if curl -fsS --max-time 5 "${url}/health" >/dev/null 2>&1; then
      echo "ready"; exit 0
   fi
   sleep 2
done
echo "timeout"; exit 1
