#!/usr/bin/env bash
# List available llama.cpp backends on this host.
# Prints one line per available backend: "cuda docker:llama-server-cuda".
# Used by the orchestrator to auto-detect which backend to use.

IMAGE="${LLAMA_IMAGE:-llama-server-cuda}"

if docker image inspect "$IMAGE" &>/dev/null && command -v nvidia-smi &>/dev/null; then
   echo "cuda docker:$IMAGE"
fi

# Exit non-zero if no backend available
docker image inspect "$IMAGE" &>/dev/null && command -v nvidia-smi &>/dev/null
