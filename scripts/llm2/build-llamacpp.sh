#!/bin/bash
# Build llama.cpp for the benchmark GPU host: ROCm + Vulkan, both optimized.
#
# Targets AMD RX 7900 XT (gfx1100, RDNA3). Produces:
#   $LLAMA_DIR/build-rocm/bin/{llama-server,llama-bench,llama-cli}
#   $LLAMA_DIR/build-vulkan/bin/{llama-server,llama-bench}
#
# WHY THIS SCRIPT EXISTS (the Vulkan int8 glslc trap):
#   llama.cpp's Vulkan int8 dot-product path is gated at BUILD time on a CMake
#   feature-test that compiles a GL_EXT_integer_dot_product shader. The stock Ubuntu
#   24.04 glslc (shaderc 2023.8 / glslang 14) CANNOT compile it, so the path is
#   silently compiled out: the device reports "int dot: 0" with NO error. This script
#   detects that and auto-fetches a modern glslc from the LunarG Vulkan SDK so the
#   feature is at least *available* and can be A/B-tested. NOTE: on this RX 7900 XT +
#   RADV + KHR_coopmat build the feature measured neutral-to-NEGATIVE for decode
#   (0% … −7.4% tg) and is DISABLED at runtime — see results/int-dot-impact.md. Build
#   it anyway (a different GPU/driver may benefit); just don't assume it's a win here.
#   See README.md → "GPU host: building llama.cpp" for the full rationale.
#
# Overridable env: LLAMA_DIR, SDK_DIR, JOBS, GFX, ROCM.
set -euo pipefail

LLAMA_DIR="${LLAMA_DIR:-$HOME/llama.cpp}"
SDK_DIR="${SDK_DIR:-$HOME/vulkan-sdk}"     # modern glslc lands at $SDK_DIR/x86_64/bin/glslc
JOBS="${JOBS:-$(nproc)}"
GFX="${GFX:-gfx1100}"                       # RX 7900 XT (RDNA3)
ROCM="${ROCM:-/opt/rocm}"

# ── source ────────────────────────────────────────────────────────────────────
if [ ! -d "$LLAMA_DIR" ]; then
   git clone https://github.com/ggml-org/llama.cpp "$LLAMA_DIR"
fi
cd "$LLAMA_DIR"
echo "llama.cpp @ $(git rev-parse --short HEAD)"

# ── ROCm build ────────────────────────────────────────────────────────────────
# -DGGML_HIP=ON auto-enables the gfx1100 fast paths (rocWMMA flash-attention, HIP
# graphs, native int8 MMQ) — no extra flags needed; verified below.
echo "=== ROCm configure @ $(date +%H:%M:%S) ==="
export PATH="$ROCM/bin:$PATH"
HIPCXX="$ROCM/bin/amdclang++" cmake -S . -B build-rocm \
   -DGGML_HIP=ON -DAMDGPU_TARGETS="$GFX" -DCMAKE_BUILD_TYPE=Release \
   -DLLAMA_CURL=ON 2>&1 | tail -5
echo "=== ROCm build @ $(date +%H:%M:%S) ==="
cmake --build build-rocm --config Release -j"$JOBS" \
   --target llama-server llama-bench llama-cli 2>&1 | tail -6

# ── modern glslc for Vulkan int-dot ───────────────────────────────────────────
FEATURE_SHADER="ggml/src/ggml-vulkan/vulkan-shaders/feature-tests/integer_dot.comp"
glslc_ok() {  # $1 = glslc path; mirrors the exact invocation llama.cpp's CMake uses
   "$1" -o - -fshader-stage=compute --target-env=vulkan1.3 "$FEATURE_SHADER" >/dev/null 2>&1
}
GLSLC="$(command -v glslc || true)"
if [ -z "$GLSLC" ] || ! glslc_ok "$GLSLC"; then
   echo "=== system glslc lacks GL_EXT_integer_dot_product — using LunarG SDK glslc ==="
   SDK_GLSLC="$SDK_DIR/x86_64/bin/glslc"
   if [ ! -x "$SDK_GLSLC" ]; then
      VER="$(curl -fsSL https://vulkan.lunarg.com/sdk/latest/linux.txt)"
      echo "    fetching Vulkan SDK $VER → $SDK_DIR"
      mkdir -p "$SDK_DIR"
      curl -fsSL -o /tmp/vulkan-sdk.tar.xz \
         "https://sdk.lunarg.com/sdk/download/$VER/linux/vulkansdk-linux-x86_64-$VER.tar.xz"
      tar -xJf /tmp/vulkan-sdk.tar.xz -C "$SDK_DIR" --strip-components=1
      rm -f /tmp/vulkan-sdk.tar.xz
   fi
   GLSLC="$SDK_GLSLC"
   glslc_ok "$GLSLC" || { echo "ERROR: SDK glslc still fails the int-dot feature test" >&2; exit 1; }
fi
echo "Using glslc: $GLSLC ($("$GLSLC" --version 2>&1 | head -1))"

# ── Vulkan build ──────────────────────────────────────────────────────────────
# A clean configure ensures the feature-test re-runs against the chosen glslc.
echo "=== Vulkan configure @ $(date +%H:%M:%S) ==="
rm -rf build-vulkan
cmake -S . -B build-vulkan \
   -DGGML_VULKAN=ON -DGGML_NATIVE=ON -DGGML_LTO=ON -DCMAKE_BUILD_TYPE=Release -DLLAMA_CURL=ON \
   -DVulkan_GLSLC_EXECUTABLE="$GLSLC" 2>&1 | grep -iE "integer_dot|coopmat|glslc support" || true
echo "=== Vulkan build @ $(date +%H:%M:%S) ==="
cmake --build build-vulkan -j"$JOBS" \
   --target llama-server llama-bench 2>&1 | tail -6

# ── verify ────────────────────────────────────────────────────────────────────
echo "=== done @ $(date +%H:%M:%S) ==="
echo "ROCm fast paths (expect all ON):"
grep -E "GGML_HIP_ROCWMMA_FATTN|GGML_HIP_GRAPHS|GGML_HIP_MMQ_MFMA" build-rocm/CMakeCache.txt || true
ls -la build-rocm/bin/llama-server build-vulkan/bin/llama-server
echo
echo "Confirm the Vulkan device line shows BOTH 'int dot: 1' and 'matrix cores: KHR_coopmat':"
echo "  build-vulkan/bin/llama-bench -m <any.gguf> -ngl 99 -p 8 -n 4 -r 1 2>&1 | grep ggml_vulkan"
