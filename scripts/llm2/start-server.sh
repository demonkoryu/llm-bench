#!/usr/bin/env bash
# Start one llama-server instance.
# Acquires a lockfile, kills any orphans, waits for VRAM to clear, then launches.
#
# Usage:
#   start-server.sh --backend <vulkan|rocm> --ctx <N> \
#                   [--hf-repo <repo> --hf-file <file> | --model <path>] \
#                   [--port <N>] [--ngl <N>] [extra flags...]
#
# Prints the PID to stdout on success.
# Sets LLAMA_SERVER_PID env file at /tmp/llama-server.pid.
# Exits 1 on failure (with reason to stderr).
set -e

ROCM_BIN="${ROCM_BIN:-$HOME/llama.cpp/build-rocm/bin/llama-server}"
VK_BIN="${VK_BIN:-$HOME/llama.cpp/build-vulkan/bin/llama-server}"
LOCKFILE=/tmp/llama-server.lock
PIDFILE=/tmp/llama-server.pid
LOG=/tmp/llamasrv.log
VRAM_CLEAR_TIMEOUT=60  # seconds to wait for VRAM to drop below threshold after kill

backend=vulkan
ctx=8192
port=8090
ngl=99
hf_repo=""
hf_file=""
model_path=""
extra_flags=""

while [[ $# -gt 0 ]]; do
   case "$1" in
      --backend) backend="$2"; shift 2 ;;
      --ctx)     ctx="$2";     shift 2 ;;
      --port)    port="$2";    shift 2 ;;
      --ngl)     ngl="$2";     shift 2 ;;
      --hf-repo) hf_repo="$2"; shift 2 ;;
      --hf-file) hf_file="$2"; shift 2 ;;
      --model)   model_path="$2"; shift 2 ;;
      *)         extra_flags="$extra_flags $1"; shift ;;
   esac
done

# Select binary
case "$backend" in
   rocm)   BIN="$ROCM_BIN"  ;;
   vulkan) BIN="$VK_BIN"    ;;
   *)      echo "ERROR: unknown backend '$backend'" >&2; exit 1 ;;
esac
if [ ! -f "$BIN" ]; then
   echo "ERROR: backend binary not found: $BIN" >&2
   exit 1
fi

# Acquire lockfile (prevents parallel starts)
if ! ( set -C; echo $$ > "$LOCKFILE" ) 2>/dev/null; then
   existing=$(cat "$LOCKFILE" 2>/dev/null || echo "?")
   echo "ERROR: lockfile held by PID $existing — another benchmark is running" >&2
   exit 1
fi
trap 'rm -f "$LOCKFILE"' EXIT

# Kill any existing llama-server processes + wait for VRAM to clear
echo "  [start-server] killing any existing llama-server..." >&2
if [ -f "$PIDFILE" ]; then
   old_pid=$(cat "$PIDFILE" 2>/dev/null || echo "")
   if [ -n "$old_pid" ]; then
      kill "$old_pid" 2>/dev/null || true
      sleep 1
      kill -9 "$old_pid" 2>/dev/null || true
   fi
fi
fuser -k "$port/tcp" 2>/dev/null || true
pkill -9 -f llama-server 2>/dev/null || true
rm -f "$PIDFILE"

# Wait for VRAM to clear (prevents OOM from leftover allocations)
echo "  [start-server] waiting for VRAM to clear..." >&2
deadline=$((SECONDS + VRAM_CLEAR_TIMEOUT))
while [ $SECONDS -lt $deadline ]; do
   used=$(rocm-smi --showmeminfo vram --json 2>/dev/null | \
      python3 -c "import sys,json; d=json.load(sys.stdin); print(list(d.values())[0].get('VRAM Total Used Memory (B)','0'))" 2>/dev/null || echo "0")
   used_mib=$(( used / 1048576 ))
   if [ "$used_mib" -lt 512 ]; then
      echo "  [start-server] VRAM clear (${used_mib} MiB)" >&2
      break
   fi
   echo "  [start-server] VRAM ${used_mib} MiB — waiting..." >&2
   sleep 2
done

# Build model source args
if [ -n "$model_path" ]; then
   model_args="--model $model_path"
elif [ -n "$hf_repo" ] && [ -n "$hf_file" ]; then
   model_args="--hf-repo '$hf_repo' --hf-file '$hf_file'"
else
   echo "ERROR: must supply --hf-repo + --hf-file or --model <path>" >&2
   exit 1
fi

# Default reasoning-format is 'auto' (parses <think>, Gemma channel markers, [THINK]),
# but a model may override it via extra_flags (e.g. Nemotron Nano v2 needs 'none' —
# 'auto' can't parse its <SPECIAL_NN> delimiters and 500s). Only inject the default
# when the model hasn't supplied its own, since llama.cpp honors the first occurrence.
rf_flag="--reasoning-format auto"
if [[ "$extra_flags" == *"--reasoning-format"* ]]; then
   rf_flag=""
fi

# Launch llama-server
cmd="nohup $BIN $model_args \
   -c $ctx \
   -ngl $ngl \
   --cache-type-k q8_0 --cache-type-v q8_0 \
   -fa on \
   -np 1 \
   -b 2048 -ub 2048 \
   --jinja \
   $rf_flag \
   --host 0.0.0.0 --port $port \
   $extra_flags \
   > $LOG 2>&1 & echo \$!"

echo "  [start-server] launching $backend ctx=$ctx port=$port" >&2
PID=$(eval "$cmd")
echo "$PID" > "$PIDFILE"
# Release lockfile (server is running; main lock released, PID file is the new guard)
rm -f "$LOCKFILE"
trap - EXIT

echo "$PID"
