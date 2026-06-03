#!/usr/bin/env bash
# 503-aware llama-server readiness probe.
# Sends a minimal completion request and waits until the response is NOT 503.
# (llama-server returns 503 while the model is still loading.)
#
# Usage:  health.sh [--url <url>] [--timeout <seconds>]
# Exits:  0 = ready, 1 = timed out or fatal error

url="${LLAMA_URL:-http://127.0.0.1:8090}"
timeout_s=300

while [[ $# -gt 0 ]]; do
   case "$1" in
      --url)     url="$2";     shift 2 ;;
      --timeout) timeout_s="$2"; shift 2 ;;
      *) shift ;;
   esac
done

probe='{"messages":[{"role":"user","content":"hi"}],"max_tokens":1,"stream":false}'
deadline=$((SECONDS + timeout_s))
last_log=0

while [ $SECONDS -lt $deadline ]; do
   http_code=$(curl -s -o /dev/null -w "%{http_code}" \
      -X POST "$url/v1/chat/completions" \
      -H "Content-Type: application/json" \
      -d "$probe" \
      --max-time 5 2>/dev/null || echo "000")

   if [ "$http_code" != "503" ] && [ "$http_code" != "000" ]; then
      echo "  [health] ready (HTTP $http_code)" >&2
      exit 0
   fi

   now=$SECONDS
   if [ $((now - last_log)) -ge 10 ]; then
      elapsed=$((now - (deadline - timeout_s)))
      echo "  [health] waiting for model load... ${elapsed}s (HTTP $http_code)" >&2
      last_log=$now
   fi
   sleep 2
done

echo "  [health] timed out after ${timeout_s}s" >&2
exit 1
