#!/usr/bin/env bash
# Start one llama-server instance inside a Docker container with GPU passthrough.
#
# Usage:
#   start-server.sh --backend cuda --ctx <N> \
#                   [--hf-repo <repo> --hf-file <file> | --model <path>] \
#                   [--port <N>] [--ngl <N>] [extra flags...]
#
# Prints the container ID to stdout on success.
# Exits 1 on failure (with reason to stderr).
set -e

IMAGE="${LLAMA_IMAGE:-llama-server-cuda}"
CONTAINER="${LLAMA_CONTAINER:-llama-server}"
LOCKFILE=/tmp/llama-server.lock
VRAM_CLEAR_TIMEOUT=60

backend=cuda
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

case "$backend" in
   cuda) ;;
   *)    echo "ERROR: unknown backend '$backend' — only cuda is supported" >&2; exit 1 ;;
esac

if ! docker image inspect "$IMAGE" &>/dev/null; then
   echo "ERROR: Docker image not found: $IMAGE" >&2
   exit 1
fi

# Acquire lockfile (prevents parallel starts)
if ! ( set -C; echo $$ > "$LOCKFILE" ) 2>/dev/null; then
   existing=$(cat "$LOCKFILE" 2>/dev/null || echo "?")
   echo "ERROR: lockfile held by PID $existing — another benchmark is running" >&2
   exit 1
fi
trap 'rm -f "$LOCKFILE"' EXIT

# Kill any existing container + wait for VRAM to clear
echo "  [start-server] killing any existing container..." >&2
docker kill "$CONTAINER" 2>/dev/null || true
docker rm -f "$CONTAINER" 2>/dev/null || true
fuser -k "$port/tcp" 2>/dev/null || true

echo "  [start-server] waiting for VRAM to clear..." >&2
deadline=$((SECONDS + VRAM_CLEAR_TIMEOUT))
while [ $SECONDS -lt $deadline ]; do
   used_mib=$(nvidia-smi --query-gpu=memory.used --format=csv,noheader,nounits 2>/dev/null \
      | awk '{s+=$1} END {print int(s)}' || echo "0")
   if [ "$used_mib" -lt 512 ]; then
      echo "  [start-server] VRAM clear (${used_mib} MiB)" >&2
      break
   fi
   echo "  [start-server] VRAM ${used_mib} MiB — waiting..." >&2
   sleep 2
done

# Ensure THP=always for large-page allocs
thp=$(cat /sys/kernel/mm/transparent_hugepage/enabled 2>/dev/null || true)
if [[ "$thp" != *"[always]"* ]]; then
   echo "  [start-server] enabling transparent huge pages..." >&2
   echo always | sudo tee /sys/kernel/mm/transparent_hugepage/enabled >/dev/null 2>&1 || true
fi

# Build model source args
if [ -n "$model_path" ]; then
   model_args="--model $model_path"
elif [ -n "$hf_repo" ] && [ -n "$hf_file" ]; then
   model_args="--hf-repo $hf_repo --hf-file $hf_file"
else
   echo "ERROR: must supply --hf-repo + --hf-file or --model <path>" >&2
   exit 1
fi

rf_flag="--reasoning-format auto"
if [[ "$extra_flags" == *"--reasoning-format"* ]]; then
   rf_flag=""
fi

ctk_flag="--cache-type-k q8_0 --cache-type-v q8_0"
if [[ "$extra_flags" == *"--cache-type-k"* ]]; then
   ctk_flag=""
fi

np_flag="-np 1"
if [[ "$extra_flags" == *"--parallel"* || "$extra_flags" == *"-np "* ]]; then
   np_flag=""
fi

# Launch container
echo "  [start-server] launching cuda ctx=$ctx port=$port" >&2
CID=$(docker run -d \
   --name "$CONTAINER" \
   --gpus all \
   -p "$port:8090" \
   -v "$HOME/.cache/huggingface:/root/.cache/huggingface" \
   -v "$HOME/models:$HOME/models:ro" \
   "$IMAGE" \
   $model_args \
   -c "$ctx" \
   -ngl "$ngl" \
   $ctk_flag \
   -fa on \
   $np_flag \
   --split-mode layer \
   --no-mmap --mlock \
   --prio 2 \
   --jinja \
   $rf_flag \
   --host 0.0.0.0 --port 8090 \
   $extra_flags)

# Release lockfile
rm -f "$LOCKFILE"
trap - EXIT

echo "$CID"
