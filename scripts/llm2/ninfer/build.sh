#!/usr/bin/env bash
# Build the NInfer V100 (sm_70) image on the GPU host.
#
# Clones/updates the ninfer-v100 checkout, then builds Dockerfile.v100 against it.
# The upstream repo's own Dockerfile targets Blackwell/CUDA 13.1 and cannot produce an
# sm_70 binary -- see the header of Dockerfile.v100. Idempotent: re-running fast-forwards
# the checkout and rebuilds only what changed.
#
# Usage: build.sh [--ref <git-ref>] [--src <dir>] [--tag <image>] [--no-pull]
set -euo pipefail

REPO_URL="https://github.com/geoffwatts/ninfer-v100.git"
REF="master"
SRC="${HOME}/src/ninfer-v100"
TAG="ninfer-v100"
PULL=1

while [[ $# -gt 0 ]]; do
   case "$1" in
      --ref)     REF="$2"; shift 2 ;;
      --src)     SRC="$2"; shift 2 ;;
      --tag)     TAG="$2"; shift 2 ;;
      --no-pull) PULL=0; shift ;;
      *) echo "unknown arg: $1" >&2; exit 2 ;;
   esac
done

HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"

if [[ ! -d "$SRC/.git" ]]; then
   echo "[ninfer-build] cloning $REPO_URL -> $SRC"
   mkdir -p "$(dirname "$SRC")"
   git clone "$REPO_URL" "$SRC"
fi

if [[ "$PULL" == 1 ]]; then
   echo "[ninfer-build] fetching $REF"
   git -C "$SRC" fetch --tags origin
fi
git -C "$SRC" checkout "$REF"
git -C "$SRC" submodule update --init --recursive

SRC_COMMIT="$(git -C "$SRC" rev-parse --short HEAD)"
echo "[ninfer-build] source at ${REF} (${SRC_COMMIT})"

# Dockerfile lives in llm-bench, source lives in the ninfer checkout -> -f out-of-tree.
echo "[ninfer-build] building image ${TAG} (sm_70, CUDA 12.8) -- this takes a while"
docker build \
   -f "${HERE}/Dockerfile.v100" \
   -t "${TAG}:${SRC_COMMIT}" \
   -t "${TAG}:latest" \
   --label "ninfer.source.commit=${SRC_COMMIT}" \
   --label "ninfer.source.ref=${REF}" \
   --label "ninfer.cuda.arch=70" \
   "$SRC"

echo "[ninfer-build] done: ${TAG}:${SRC_COMMIT} (also tagged :latest)"
docker run --rm "${TAG}:latest" ninfer-serve --help 2>&1 | head -5 || true
