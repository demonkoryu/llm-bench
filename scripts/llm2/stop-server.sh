#!/usr/bin/env bash
# Stop the tracked llama-server and clean up.
# Usage: stop-server.sh [--port <N>]
set -e

PIDFILE=/tmp/llama-server.pid
port=8090

while [[ $# -gt 0 ]]; do
   case "$1" in
      --port) port="$2"; shift 2 ;;
      *) shift ;;
   esac
done

if [ -f "$PIDFILE" ]; then
   pid=$(cat "$PIDFILE" 2>/dev/null || echo "")
   if [ -n "$pid" ]; then
      echo "  [stop-server] killing PID $pid" >&2
      kill "$pid" 2>/dev/null || true
      sleep 1
      kill -9 "$pid" 2>/dev/null || true
   fi
   rm -f "$PIDFILE"
fi

fuser -k "$port/tcp" 2>/dev/null || true
pkill -TERM -f llama-server 2>/dev/null || true
sleep 2
pkill -9 -f llama-server 2>/dev/null || true

echo "  [stop-server] done" >&2
