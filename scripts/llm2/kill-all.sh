#!/usr/bin/env bash
# Aggressive cleanup: kill all llama-server processes, release lockfile, clear PID.
# Usage: kill-all.sh [--port <N>]
PIDFILE=/tmp/llama-server.pid
LOCKFILE=/tmp/llama-server.lock
port=8090

while [[ $# -gt 0 ]]; do
   case "$1" in
      --port) port="$2"; shift 2 ;;
      *) shift ;;
   esac
done

[ -f "$PIDFILE" ] && { pid=$(cat "$PIDFILE"); kill -9 "$pid" 2>/dev/null || true; rm -f "$PIDFILE"; }
fuser -k "$port/tcp" 2>/dev/null || true
pkill -9 -f llama-server 2>/dev/null || true
rm -f "$LOCKFILE"

echo "  [kill-all] done" >&2
