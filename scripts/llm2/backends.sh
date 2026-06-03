#!/usr/bin/env bash
# List available llama.cpp backends on this host.
# Prints one line per available backend: "vulkan <path>" or "rocm <path>".
# Used by the orchestrator to auto-detect which backend to use.

ROCM_BIN="${ROCM_BIN:-$HOME/llama.cpp/build-rocm/bin/llama-server}"
VK_BIN="${VK_BIN:-$HOME/llama.cpp/build-vulkan/bin/llama-server}"

[ -f "$VK_BIN"   ] && echo "vulkan $VK_BIN"
[ -f "$ROCM_BIN" ] && echo "rocm   $ROCM_BIN"

# Exit non-zero if neither exists
[ -f "$VK_BIN" ] || [ -f "$ROCM_BIN" ]
