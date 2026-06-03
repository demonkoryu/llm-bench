#!/usr/bin/env bash
# Verify that the llm2 host is ready to run benchmarks.
# Checks: llama.cpp binaries exist, GPU is visible, port is free.
# Exits 0 on success, 1 on any failure (with error to stderr).
set -e

ROCM_BIN="${ROCM_BIN:-$HOME/llama.cpp/build-rocm/bin/llama-server}"
VK_BIN="${VK_BIN:-$HOME/llama.cpp/build-vulkan/bin/llama-server}"
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

# At least one backend binary must exist
rocm_ok=false
vk_ok=false
[ -f "$ROCM_BIN" ] && rocm_ok=true && echo "  OK  rocm binary: $ROCM_BIN"
[ -f "$VK_BIN"   ] && vk_ok=true   && echo "  OK  vulkan binary: $VK_BIN"
if ! $rocm_ok && ! $vk_ok; then
   echo "FAIL  no llama-server binary found (rocm=$ROCM_BIN  vulkan=$VK_BIN)"
   fail=$((fail+1))
fi

# GPU visible (rocm-smi works for AMD regardless of inference backend)
check "rocm-smi accessible" rocm-smi --showmemuse

# Port is not currently in use
if fuser "$PORT/tcp" &>/dev/null; then
   echo "WARN  port $PORT is already in use — run kill-all.sh first"
fi

# HF cache directory exists (models should be pre-downloaded)
check "HF cache present" test -d "$HOME/.cache/huggingface/hub"

echo ""
echo "ok=$ok  fail=$fail"
[ "$fail" -eq 0 ]
