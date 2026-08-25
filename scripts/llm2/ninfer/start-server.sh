#!/usr/bin/env bash
# Start one ninfer-serve instance in a container, pinned to a single GPU.
#
# Usage:
#   start-server.sh --device N --artifact <file.ninfer> --ctx <N> [--port P]
#                   [--models-dir D] [--image I] [extra ninfer-serve flags...]
#
# Prints the container ID on stdout. Exits 1 on failure (reason on stderr).
#
# DIFFERENCES FROM ../start-server.sh (llama.cpp), all forced by topology: NInfer is a
# single-GPU engine (`--device N`), so this host runs TWO independent instances -- one per
# V100 -- rather than one process spanning both. Everything that the llama.cpp script scopes
# host-wide is therefore scoped per device here:
#   * the lockfile and container name are suffixed with the device index, so starting the
#     gpu1 instance does not report "another benchmark is running" against gpu0;
#   * the VRAM-clear wait polls ONLY the target GPU (nvidia-smi -i N). Summing both cards,
#     as the llama.cpp script does, would make each instance wait forever on the other's
#     resident weights and then time out into a false start;
#   * the container is given only its own GPU (--gpus device=N), so a stray --device inside
#     cannot reach the peer card. Consequently ninfer-serve always addresses device 0
#     *inside* the container, whatever the host-side index is.
set -e

IMAGE="${NINFER_IMAGE:-ninfer-v100:latest}"
MODELS_DIR="${NINFER_MODELS_DIR:-$HOME/models/ninfer}"
VRAM_CLEAR_TIMEOUT=90

device=0
port=""
ctx=16384
artifact=""
extra_flags=""

while [[ $# -gt 0 ]]; do
   case "$1" in
      --device)     device="$2";     shift 2 ;;
      --port)       port="$2";       shift 2 ;;
      --ctx)        ctx="$2";        shift 2 ;;
      --artifact)   artifact="$2";   shift 2 ;;
      --models-dir) MODELS_DIR="$2"; shift 2 ;;
      --image)      IMAGE="$2";      shift 2 ;;
      *)            extra_flags="$extra_flags $1"; shift ;;
   esac
done

# Default port derives from the device so the two instances never collide by accident.
[ -n "$port" ] || port=$((8100 + device))

CONTAINER="ninfer-d${device}"
LOCKFILE="/tmp/ninfer-d${device}.lock"

if [ -z "$artifact" ]; then
   echo "ERROR: --artifact <file.ninfer> is required" >&2
   exit 1
fi
if [ ! -f "${MODELS_DIR}/${artifact}" ]; then
   echo "ERROR: artifact not found: ${MODELS_DIR}/${artifact}" >&2
   exit 1
fi
if ! docker image inspect "$IMAGE" >/dev/null 2>&1; then
   echo "ERROR: Docker image not found: $IMAGE (build with scripts/llm2/ninfer/build.sh)" >&2
   exit 1
fi
if ! nvidia-smi -i "$device" >/dev/null 2>&1; then
   echo "ERROR: no such CUDA device: $device" >&2
   exit 1
fi

# Per-device lockfile (prevents two starts racing on the SAME gpu; the peer gpu is unaffected).
if ! ( set -C; echo $$ > "$LOCKFILE" ) 2>/dev/null; then
   existing=$(cat "$LOCKFILE" 2>/dev/null || echo "?")
   echo "ERROR: lockfile $LOCKFILE held by PID $existing — another run owns GPU $device" >&2
   exit 1
fi
trap 'rm -f "$LOCKFILE"' EXIT

echo "  [ninfer-start] gpu${device}: removing any existing container ${CONTAINER}..." >&2
docker kill "$CONTAINER" >/dev/null 2>&1 || true
docker rm -f "$CONTAINER" >/dev/null 2>&1 || true
fuser -k "${port}/tcp" >/dev/null 2>&1 || true

echo "  [ninfer-start] gpu${device}: waiting for its VRAM to clear..." >&2
deadline=$((SECONDS + VRAM_CLEAR_TIMEOUT))
while [ $SECONDS -lt $deadline ]; do
   used_mib=$(nvidia-smi -i "$device" --query-gpu=memory.used --format=csv,noheader,nounits 2>/dev/null | awk 'NR==1{print int($1)}' || echo 0)
   if [ "${used_mib:-0}" -lt 512 ]; then
      echo "  [ninfer-start] gpu${device}: VRAM clear (${used_mib} MiB)" >&2
      break
   fi
   echo "  [ninfer-start] gpu${device}: VRAM ${used_mib} MiB — waiting..." >&2
   sleep 2
done

# Defaults the harness relies on, each skipped when the caller already supplied it.
# int8 group-64 KV is the documented choice for large context allocations; a 2048-token
# prefill chunk is the width every published NInfer prefill figure uses; `auto` sizes the
# shared KV pool from whatever memory the weights leave (1 GiB headroom is ninfer's own).
kv_flag="--kv-dtype int8"
[[ "$extra_flags" == *"--kv-dtype"* ]] && kv_flag=""
chunk_flag="--prefill-chunk 2048"
[[ "$extra_flags" == *"--prefill-chunk"* ]] && chunk_flag=""
cap_flag="--kv-capacity auto"
[[ "$extra_flags" == *"--kv-capacity"* ]] && cap_flag=""

echo "  [ninfer-start] gpu${device}: launching ${artifact} ctx=${ctx} port=${port}" >&2
CID=$(docker run -d \
   --name "$CONTAINER" \
   --gpus "device=${device}" \
   -p "${port}:8080" \
   -v "${MODELS_DIR}:/models:ro" \
   "$IMAGE" \
   ninfer-serve "/models/${artifact}" \
   --host 0.0.0.0 --port 8080 \
   --device 0 \
   --max-context "$ctx" \
   $kv_flag \
   $chunk_flag \
   $cap_flag \
   $extra_flags)

rm -f "$LOCKFILE"
trap - EXIT

echo "$CID"
