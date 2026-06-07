#!/usr/bin/env bash
# List available llama.cpp backends on this host.
# Prints one line per available backend: "vulkan <path>" or "rocm <path>".
# Used by the orchestrator to auto-detect which backend to use.

VK_BIN="${VK_BIN:-$HOME/llama.cpp/build-vulkan/bin/llama-server}"

[ -f "$VK_BIN" ] && echo "vulkan $VK_BIN"

# ROCm DISABLED 2026-06-07 — Vulkan is the sole production backend. The rocm build
# may still exist on disk but is no longer advertised as a selectable backend. To
# re-enable, restore the ROCM_BIN detection here + the rocm entry in config/hosts.yaml
# + the rocm case in start-server.sh. (ROCm q8_0 KV is +22% at depth for Qwen3.6-35B —
# see results/kv-quant-sweep-rocm.md — if you revisit.)

# Exit non-zero if vulkan is missing
[ -f "$VK_BIN" ]
