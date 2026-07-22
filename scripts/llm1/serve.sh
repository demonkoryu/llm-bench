#!/usr/bin/env bash
# Start the RapidMLX daemon on the M1 Mac (llm1) for the llm-bench harness.
#
# The harness treats RapidMLX as a persistent, no-lifecycle daemon: runners/rapidmlx-server.mjs
# never launches or kills it — it only health-checks and selects the served model. So THIS script
# is the launcher, invoked manually at phase boundaries (primary run, then the --pflash A/B).
#
# Usage:
#   scripts/llm1/serve.sh                 # primary config (kv int4, pflash off, 1 client)
#   PFLASH=always scripts/llm1/serve.sh   # Phase 5 pflash A/B
#   scripts/llm1/serve.sh --enable-mtp    # any extra flags pass through to `rapid-mlx serve`
#
# Env overrides: MODEL, PORT, HOST, PFLASH, KV_DTYPE, WIRED_MIN_MB, RAPID_MLX.
# Prints the daemon PID on success; exits 1 on failure. Logs to /tmp/rapidmlx.log.
set -euo pipefail

MODEL="${MODEL:-qwen3.6-27b-4bit}"
# Loopback bind: bench-run.mjs runs ON this machine (from the ~/llm-bench git checkout) and hits the
# daemon at 127.0.0.1:8000 — no LAN exposure, no auth surface. Override HOST=0.0.0.0 only if you need
# to drive it from another box (RapidMLX warns wildcard bind is LAN-reachable with no auth).
HOST="${HOST:-127.0.0.1}"
PORT="${PORT:-8000}"
PFLASH="${PFLASH:-off}"               # primary=off (honest long ctx); Phase 5 A/B=always
KV_DTYPE="${KV_DTYPE:-int4}"          # plain 4-bit KV (no turboquant) — closest to fleet KV q4_0
WIRED_MIN_MB="${WIRED_MIN_MB:-28672}" # expect ≥28 GB wired; user sets via sysctl (see below)
RAPID_MLX="${RAPID_MLX:-rapid-mlx}"
LOG="${LOG:-/tmp/rapidmlx.log}"
PIDFILE=/tmp/rapidmlx.pid

# ── Cloud fallback: INERT unless --cloud-model is set (verified via `serve --help`, v0.10.12):
#    "When set, large-context requests are routed to the cloud." --cloud-threshold (default 20000)
#    only matters once a cloud model is configured. We never pass --cloud-model, so every token is
#    generated locally — nothing to disable. (Env hook kept empty for belt-and-suspenders.)
CLOUD_DISABLE="${CLOUD_DISABLE:-}"

# Request timeout: server default is 1800s (30 min). Deep-context prefill (64k–128k) on the M1 is
# slow; a long agent_ctx / quality_decay request must not be killed server-side before the client
# gives up. Match the agent_ctx client cap (60 min).
TIMEOUT="${TIMEOUT:-3600}"

# ── Assert Metal wired-memory limit (assert only — do NOT set; the user manages this) ────────────
# Set on the Mac by the user with:  sudo sysctl iogpu.wired_limit_mb=28672   (value in MiB → 28 GB)
# NOTE: the effective key on this macOS (26.x) is `iogpu.wired_limit_mb`, NOT `iogpu.wired_mem_limit`.
# Resets on reboot. We only READ it and warn if it is lower than expected — never write it.
wired="$(sysctl -n iogpu.wired_limit_mb 2>/dev/null || echo 0)"
wired="${wired:-0}"
if [[ "$wired" -lt "$WIRED_MIN_MB" ]]; then
   echo "WARN: iogpu.wired_limit_mb=${wired} MiB < expected ${WIRED_MIN_MB} MiB." >&2
   echo "      Long-context KV may hit the wired ceiling and throttle/abort. To raise it:" >&2
   echo "      sudo sysctl iogpu.wired_limit_mb=${WIRED_MIN_MB}" >&2
else
   echo "iogpu.wired_limit_mb=${wired} MiB (>= ${WIRED_MIN_MB} MiB expected) OK"
fi

# ── Kill any existing daemon ─────────────────────────────────────────────────────────────────────
if [[ -f "$PIDFILE" ]] && kill -0 "$(cat "$PIDFILE")" 2>/dev/null; then
   echo "Stopping existing RapidMLX daemon (PID $(cat "$PIDFILE"))..."
   kill "$(cat "$PIDFILE")" 2>/dev/null || true
   sleep 2
fi
pkill -f "rapid-mlx serve" 2>/dev/null || true
sleep 1

# ── Launch ───────────────────────────────────────────────────────────────────────────────────────
# Constraints (user, priority: max context > performance > quality; ≤1 concurrent client):
#   --kv-cache-dtype int4 --kv-cache-turboquant none  plain 4-bit KV
#   --max-num-seqs 1                                   single client (no coder sub-agents)
#   --pflash off (primary)                             honest long-context retrieval
#   --no-spec-decode                                   clean baseline (MTP A/B is separate, Phase 6)
echo "Launching: $RAPID_MLX serve $MODEL (kv=$KV_DTYPE pflash=$PFLASH 1-seq) → $HOST:$PORT"
nohup "$RAPID_MLX" serve "$MODEL" \
   --host "$HOST" --port "$PORT" \
   --served-model-name "$MODEL" \
   --kv-cache-dtype "$KV_DTYPE" \
   --kv-cache-turboquant=none \
   --pflash "$PFLASH" \
   --max-num-seqs 1 \
   --no-spec-decode \
   --timeout "$TIMEOUT" \
   $CLOUD_DISABLE \
   "$@" \
   >"$LOG" 2>&1 &
pid=$!
echo "$pid" >"$PIDFILE"

# ── Health check ─────────────────────────────────────────────────────────────────────────────────
echo "Waiting for RapidMLX to become healthy (PID $pid)..."
for i in $(seq 1 120); do
   if ! kill -0 "$pid" 2>/dev/null; then
      echo "ERROR: daemon exited early — see $LOG" >&2
      tail -20 "$LOG" >&2 || true
      exit 1
   fi
   if curl -fsS "http://127.0.0.1:${PORT}/v1/models" >/dev/null 2>&1; then
      echo "RapidMLX healthy on port ${PORT} (PID $pid). Model: ${MODEL}"
      curl -fsS "http://127.0.0.1:${PORT}/v1/models" 2>/dev/null || true
      exit 0
   fi
   sleep 2
done
echo "ERROR: RapidMLX did not become healthy within ~240s — see $LOG" >&2
tail -20 "$LOG" >&2 || true
exit 1
