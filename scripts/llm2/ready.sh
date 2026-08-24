#!/usr/bin/env bash
# Verify that the llm2 host is ready to run benchmarks.
# Checks: Docker image exists, nvidia-smi works, GPUs visible, port is free.
# Exits 0 on success, 1 on any failure (with error to stderr).
set -e

IMAGE="${LLAMA_IMAGE:-llama-server-cuda}"
PORT="${LLAMA_PORT:-8090}"

ok=0
fail=0

check() {
   local label="$1"; shift
   if "$@" &>/dev/null; then
      echo "  OK  $label"
      ok=$((ok+1))
   else
      echo "FAIL  $label"
      fail=$((fail+1))
   fi
}

echo "=== llm2 readiness check ==="

check "nvidia-smi accessible" nvidia-smi -L
check "Docker image $IMAGE" docker image inspect "$IMAGE"
check "nvidia-container-runtime" docker run --rm --gpus all "$IMAGE" --version

# Port is not currently in use
if fuser "$PORT/tcp" &>/dev/null; then
   echo "WARN  port $PORT is already in use — run kill-all.sh first"
fi

# HF cache directory exists (models should be pre-downloaded)
check "HF cache present" test -d "$HOME/.cache/huggingface/hub"

echo ""
echo "ok=$ok  fail=$fail"
[ "$fail" -eq 0 ]
