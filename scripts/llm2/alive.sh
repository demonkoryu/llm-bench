#!/usr/bin/env bash
# Is the llama-server container still running?
#
# Exit codes are three-valued on purpose, because "I cannot tell" must not read as "dead":
#   0 = running
#   1 = exited — definitely dead; prints the container's exit code on stdout
#   2 = unknown — no container by that name, or docker/inspect unavailable
#
# Callers use this to stop waiting on a load that has already failed. A load that fails to
# allocate exits in ~2s, but from the outside the HTTP endpoint just stays unreachable, which is
# indistinguishable from a model still loading — so without this signal the orchestrator counts
# all the way to LOAD_TIMEOUT_MS against a process that is gone. Observed 2026-08-26 on
# Nemotron-3-Nano-4B: container OOM'd 1.7s in, health poll was still reporting "waiting for model
# load... 221s". With agent_ctx doing up to MAX_LOADS=9 deliberate load-until-failure attempts,
# that is over an hour of polling corpses per model.
#
# Only the exit code is contractual; alive.sh deliberately does not interpret the log. Use
# log-tail.sh for WHY it died — this answers only whether it still exists.
CONTAINER="${LLAMA_CONTAINER:-llama-server}"

state=$(docker inspect -f '{{.State.Running}} {{.State.ExitCode}}' "$CONTAINER" 2>/dev/null) || exit 2
[ -n "$state" ] || exit 2

read -r running code <<<"$state"
case "$running" in
   true)  exit 0 ;;
   false) echo "$code"; exit 1 ;;
   *)     exit 2 ;;
esac
