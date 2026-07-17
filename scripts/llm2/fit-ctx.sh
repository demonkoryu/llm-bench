#!/usr/bin/env bash
# Probe llama.cpp's NATIVE auto-fit context ceiling for one model.
#
# Runs `llama-fit-params` (the auto-fit helper) with the model's real serving flags
# (KV quant, batch, flash-attn, full GPU offload) and NO explicit `-c`, so llama.cpp
# computes the largest context that fits VRAM. Prints a single integer to stdout:
#
#     the fitted `-c N` value, or 0 when the model fits at its native window
#     (llama-fit-params emits `-c 0` = "no reduction needed").
#
# This is a MEMORY-fit estimate only — no coherence guarantee — and is a fast,
# different lens than the empirical maxctx ladder (start-server.sh + coherence check).
# fit-params computes analytically (sub-second, no full model load).
#
# Usage:
#   fit-ctx.sh --backend vulkan \
#              [--hf-repo <repo> --hf-file <file> | --model <path>] \
#              [--ngl <N>] [--fit-ctx <floor>] [extra flags...]
#
# Requires exclusive GPU: kills any running llama-server + waits for VRAM to clear
# first (the fit depends on FREE VRAM). Leaves no server running.
set -e

VK_BIN="${VK_BIN:-$HOME/llama.cpp/build-vulkan/bin/llama-fit-params}"
VRAM_CLEAR_TIMEOUT=60

backend=vulkan
ngl=99
fit_floor=4096
hf_repo=""
hf_file=""
model_path=""
extra_flags=""

while [[ $# -gt 0 ]]; do
   case "$1" in
      --backend)  backend="$2";   shift 2 ;;
      --ngl)      ngl="$2";       shift 2 ;;
      --fit-ctx)  fit_floor="$2"; shift 2 ;;
      --hf-repo)  hf_repo="$2";   shift 2 ;;
      --hf-file)  hf_file="$2";   shift 2 ;;
      --model)    model_path="$2"; shift 2 ;;
      *)          extra_flags="$extra_flags $1"; shift ;;
   esac
done

# Only Vulkan is live (rocm disabled 2026-06-07; mirrors start-server.sh).
case "$backend" in
   vulkan) : ;;
   rocm)   echo "ERROR: rocm backend is DISABLED — Vulkan only." >&2; exit 1 ;;
   *)      echo "ERROR: unknown backend '$backend'" >&2; exit 1 ;;
esac
if [ ! -f "$VK_BIN" ]; then
   echo "ERROR: llama-fit-params not found: $VK_BIN (rebuild with SKIP_ROCM=1 bash llm/build-llamacpp.sh)" >&2
   exit 1
fi

# Same Vulkan int-dot runtime guard as start-server.sh (neutral-to-negative here).
vk_env=""
if [ "${LLAMA_VK_INT_DOT:-0}" != "1" ]; then
   vk_env="env GGML_VK_DISABLE_INTEGER_DOT_PRODUCT=1 "
fi

# Model source args
if [ -n "$model_path" ]; then
   model_args="--model $model_path"
elif [ -n "$hf_repo" ] && [ -n "$hf_file" ]; then
   model_args="--hf-repo '$hf_repo' --hf-file '$hf_file'"
else
   echo "ERROR: must supply --hf-repo + --hf-file or --model <path>" >&2
   exit 1
fi

# KV cache type defaults to q8_0 (production) unless the model overrides it via
# extra_flags — the fitted ctx depends heavily on KV quant, so this must match the
# variant. Mirrors start-server.sh (llama honors the first occurrence of a flag).
ctk_flag="--cache-type-k q8_0 --cache-type-v q8_0"
if [[ "$extra_flags" == *"--cache-type-k"* ]]; then
   ctk_flag=""
fi

# Exclusive GPU: kill any running server and wait for VRAM to clear.
if [ -f /tmp/llama-server.pid ]; then
   kill "$(cat /tmp/llama-server.pid 2>/dev/null)" 2>/dev/null || true
fi
fuser -k 8090/tcp 2>/dev/null || true
pkill -9 -f llama-server 2>/dev/null || true
deadline=$((SECONDS + VRAM_CLEAR_TIMEOUT))
while [ $SECONDS -lt $deadline ]; do
   used=$(rocm-smi --showmeminfo vram --json 2>/dev/null | \
      python3 -c "import sys,json; d=json.load(sys.stdin); print(list(d.values())[0].get('VRAM Total Used Memory (B)','0'))" 2>/dev/null || echo "0")
   [ $((used / 1048576)) -lt 512 ] && break
   sleep 2
done

# Compute the fit. llama-fit-params prints the fitted CLI args to stdout, e.g.
# "-c 204032 -ngl 99"  (or "-c 0 -ngl 99" when it fits at native). Diagnostics go
# to stderr (captured for error reporting). --fit-ctx sets the minimum ctx the
# fitter may pick. Caller must pass only fit-params-accepted flags (KV quant, batch);
# server-only flags like --no-mmproj / --spec-type make it exit non-zero.
err_log=$(mktemp)
out=$(eval "${vk_env}\"\$VK_BIN\" $model_args -ngl $ngl -fa on $ctk_flag --fit-ctx $fit_floor $extra_flags" 2>"$err_log")

# Extract the fitted -c value.
fitted=$(printf '%s\n' "$out" | grep -oP '(?<=-c )\d+' | head -1)
if [ -z "$fitted" ]; then
   echo "ERROR: no fitted -c parsed. stdout=[$out] stderr_tail=[$(tail -3 "$err_log" | tr '\n' ' ')]" >&2
   rm -f "$err_log"
   exit 1
fi
rm -f "$err_log"
echo "$fitted"
