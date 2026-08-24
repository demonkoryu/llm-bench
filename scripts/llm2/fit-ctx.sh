#!/usr/bin/env bash
# Probe llama.cpp's NATIVE auto-fit context ceiling for one model.
#
# Runs `llama-fit-params` inside the CUDA container with the model's real serving
# flags (KV quant, batch, flash-attn, full GPU offload) and NO explicit `-c`, so
# llama.cpp computes the largest context that fits VRAM. Prints a single integer:
#
#     the fitted `-c N` value, or 0 when the model fits at its native window.
#
# This is a MEMORY-fit estimate only — no coherence guarantee — computed
# analytically without a full model load.
#
# Usage:
#   fit-ctx.sh --backend cuda \
#              [--hf-repo <repo> --hf-file <file> | --model <path>] \
#              [--ngl <N>] [--fit-ctx <floor>] [extra flags...]
#
# Requires exclusive GPU: kills any running llama-server container + waits for
# VRAM to clear first. Leaves no server running.
set -e

IMAGE="${LLAMA_IMAGE:-llama-server-cuda}"
CONTAINER="${LLAMA_CONTAINER:-llama-server}"
VRAM_CLEAR_TIMEOUT=60

backend=cuda
fit_floor=4096
fit_target=0
hf_repo=""
hf_file=""
model_path=""
extra_flags=""

while [[ $# -gt 0 ]]; do
   case "$1" in
      --backend)     backend="$2";    shift 2 ;;
      --ngl)         shift 2 ;;
      --fit-ctx)     fit_floor="$2";  shift 2 ;;
      --fit-target)  fit_target="$2"; shift 2 ;;
      --hf-repo)  hf_repo="$2";   shift 2 ;;
      --hf-file)  hf_file="$2";   shift 2 ;;
      --model)    model_path="$2"; shift 2 ;;
      *)          extra_flags="$extra_flags $1"; shift ;;
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

# Model source args
if [ -n "$model_path" ]; then
   model_args="--model $model_path"
elif [ -n "$hf_repo" ] && [ -n "$hf_file" ]; then
   model_args="--hf-repo $hf_repo --hf-file $hf_file"
else
   echo "ERROR: must supply --hf-repo + --hf-file or --model <path>" >&2
   exit 1
fi

ctk_flag="--cache-type-k q8_0 --cache-type-v q8_0"
if [[ "$extra_flags" == *"--cache-type-k"* ]]; then
   ctk_flag=""
fi

# Exclusive GPU: kill any running server container and wait for VRAM to clear.
docker kill "$CONTAINER" 2>/dev/null || true
docker rm -f "$CONTAINER" 2>/dev/null || true
fuser -k 8090/tcp 2>/dev/null || true

deadline=$((SECONDS + VRAM_CLEAR_TIMEOUT))
while [ $SECONDS -lt $deadline ]; do
   used_mib=$(nvidia-smi --query-gpu=memory.used --format=csv,noheader,nounits 2>/dev/null \
      | awk '{s+=$1} END {print int(s)}' || echo "0")
   [ "$used_mib" -lt 512 ] && break
   sleep 2
done

# Run llama-fit-params in a one-shot container. Entrypoint is llama-server,
# so override it to llama-fit-params.
err_log=$(mktemp)
out=$(docker run --rm \
   --gpus all \
   --entrypoint llama-fit-params \
   -v "$HOME/.cache/huggingface:/root/.cache/huggingface" \
   "$IMAGE" \
   $model_args -fa on $ctk_flag --fit-ctx "$fit_floor" --fit-target "$fit_target" $extra_flags \
   2>"$err_log") || true

fitted=$(printf '%s\n' "$out" | grep -oP '(?<=-c )\d+' | head -1)
if [ -z "$fitted" ]; then
   echo "ERROR: no fitted -c parsed. stdout=[$out] stderr_tail=[$(tail -3 "$err_log" | tr '\n' ' ')]" >&2
   rm -f "$err_log"
   exit 1
fi
rm -f "$err_log"
echo "$fitted"
