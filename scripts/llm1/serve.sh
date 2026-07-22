#!/usr/bin/env bash
# Start the OptiQ (mlx-optiq) daemon on the M1 Mac (llm1) for the llm-bench harness.
#
# The harness treats OptiQ as a persistent, no-lifecycle daemon: runners/optiq-server.mjs never
# launches or kills it — it only health-checks and selects the served model via GET /v1/models.
# So THIS script is the launcher, invoked manually at phase boundaries.
#
# Usage:
#   scripts/llm1/serve.sh                          # primary: uniform 4-bit KV, 1 client, no-auth
#   KV_CONFIG=path/kv.json scripts/llm1/serve.sh   # mixed-precision KV A/B (overrides --kv-bits)
#   scripts/llm1/serve.sh --mtp                    # extra flags pass through to `optiq serve`
#
# Env overrides: MODEL, HOST, PORT, KV_BITS, KV_CONFIG, MAX_CONCURRENT, MAX_CONTEXT,
#                WIRED_MIN_MB, OPTIQ, LOG. Prints the daemon PID on success; exits 1 on failure.
#
# OptiQ notes (why the flags are what they are):
#   --no-auth  MANDATORY. Auth is ON by default (Bearer sk-optiq-… on POST). The OpenAI SDK sends
#              `Bearer EMPTY`, which OptiQ REJECTS as malformed — only a MISSING header is tolerated.
#              So the harness client can only talk to a --no-auth daemon over loopback.
#   --max-concurrent 1   single client (agent_ctx MAX_CODERS=0; priority: max ctx > perf > quality).
#   --kv-bits 4          uniform 4-bit KV (primary). OptiQ has NO cloud fallback — all local.
#   single-model mode (default): the request `model` field is just a label; any value serves --model.
set -euo pipefail

MODEL="${MODEL:-mlx-community/Qwen3.6-27B-OptiQ-4bit}"
HOST="${HOST:-127.0.0.1}"                 # loopback: bench-run runs ON llm1; no LAN/auth surface
PORT="${PORT:-8080}"
KV_BITS="${KV_BITS:-4}"                    # uniform 4-bit KV (primary). Ignored if KV_CONFIG is set.
KV_CONFIG="${KV_CONFIG:-}"                 # OptiQ per-layer mixed-precision KV json; overrides --kv-bits
MAX_CONCURRENT="${MAX_CONCURRENT:-1}"      # single client
MAX_CONTEXT="${MAX_CONTEXT:-auto}"         # 'auto' caps only if native ctx won't fit RAM
WIRED_MIN_MB="${WIRED_MIN_MB:-28672}"      # Metal wired-memory floor (assert only — user manages it)
OPTIQ="${OPTIQ:-optiq}"
LOG="${LOG:-/tmp/optiq.log}"
PIDFILE=/tmp/optiq.pid

export PATH="$HOME/.local/bin:$PATH"       # pipx installs the `optiq` entrypoint here

# KV mode: uniform --kv-bits (primary) OR --kv-config mixed-precision (A/B). KV_CONFIG wins.
if [[ -n "$KV_CONFIG" ]]; then
   KV_ARGS=(--kv-config "$KV_CONFIG"); KV_DESC="kv-config=$KV_CONFIG"
else
   KV_ARGS=(--kv-bits "$KV_BITS");     KV_DESC="kv-bits=$KV_BITS"
fi

# ── Assert Metal wired-memory limit (assert only — do NOT set; the user manages this) ──
wired="$(sysctl -n iogpu.wired_limit_mb 2>/dev/null || echo 0)"; wired="${wired:-0}"
if [[ "$wired" -lt "$WIRED_MIN_MB" ]]; then
   echo "WARN: iogpu.wired_limit_mb=${wired} MiB < expected ${WIRED_MIN_MB} MiB — raise via: sudo sysctl iogpu.wired_limit_mb=${WIRED_MIN_MB}" >&2
else
   echo "iogpu.wired_limit_mb=${wired} MiB (>= ${WIRED_MIN_MB}) OK"
fi

# ── Kill any existing daemon ──
if [[ -f "$PIDFILE" ]] && kill -0 "$(cat "$PIDFILE")" 2>/dev/null; then
   echo "Stopping existing OptiQ daemon (PID $(cat "$PIDFILE"))..."
   kill "$(cat "$PIDFILE")" 2>/dev/null || true; sleep 2
fi
pkill -f "optiq serve" 2>/dev/null || true
sleep 1

# ── Launch ──
echo "Launching: optiq serve $MODEL ($KV_DESC max-concurrent=$MAX_CONCURRENT no-auth) → $HOST:$PORT"
nohup "$OPTIQ" serve \
   --model "$MODEL" \
   --host "$HOST" --port "$PORT" \
   "${KV_ARGS[@]}" \
   --max-concurrent "$MAX_CONCURRENT" \
   --max-context "$MAX_CONTEXT" \
   --no-auth \
   "$@" \
   >"$LOG" 2>&1 &
pid=$!
echo "$pid" >"$PIDFILE"

# ── Health check (first launch may download weights ~15 GB → up to 20 min) ──
echo "Waiting for OptiQ to become healthy (PID $pid)..."
for _ in $(seq 1 300); do
   if ! kill -0 "$pid" 2>/dev/null; then
      echo "ERROR: daemon exited early — see $LOG" >&2; tail -20 "$LOG" >&2 || true; exit 1
   fi
   if curl -fsS "http://127.0.0.1:${PORT}/v1/models" >/dev/null 2>&1; then
      echo "OptiQ healthy on port ${PORT} (PID $pid). Model: ${MODEL}"
      curl -fsS "http://127.0.0.1:${PORT}/v1/models" 2>/dev/null || true; echo
      exit 0
   fi
   sleep 4
done
echo "ERROR: OptiQ did not become healthy in time — see $LOG" >&2; tail -20 "$LOG" >&2 || true; exit 1
