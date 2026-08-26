#!/usr/bin/env bash
# Deploy the llm-bench repo to the remote host via git pull.
# Usage:  ./scripts/deploy.sh [--host <ssh-host>] [--dir <path>]
#
# Pre-requisites:
#   - Remote has git checkout at $REMOTE_DIR (default: ~/llm-bench)
#   - Remote user has read access to the repo URL
#   - SSH key / agent forwarding configured for $HOST

HOST="${SSH_BENCH_HOST:-llm2}"
REMOTE_DIR="${REMOTE_BENCH_DIR:-~/llm-bench}"

while [[ $# -gt 0 ]]; do
   case "$1" in
      --host) HOST="$2"; shift 2 ;;
      --dir)  REMOTE_DIR="$2"; shift 2 ;;
      *) shift ;;
   esac
done

echo "Deploying llm-bench to $HOST:$REMOTE_DIR ..."

# Pull the tracked branch and mark every host script executable (scripts/llm1/*, scripts/llm2/*, …).
ssh -o BatchMode=yes -o ConnectTimeout=10 "$HOST" \
   "cd $REMOTE_DIR && git fetch && git pull --ff-only && find scripts -name '*.sh' -exec chmod +x {} +"

# Do NOT report success unconditionally. `git pull --ff-only` aborts on a dirty or diverged remote
# working tree (local edits, or untracked files that a new commit also adds), and this script used to
# print "Deploy complete." straight over that failure — so a run would silently execute the OLD host
# scripts. Propagate the remote exit status instead.
rc=$?
if [ $rc -ne 0 ]; then
   echo "Deploy FAILED (ssh/git exit $rc). The remote checkout at $HOST:$REMOTE_DIR did not advance." >&2
   echo "Inspect it before retrying:  ssh $HOST 'cd $REMOTE_DIR && git status --short && git log --oneline -1'" >&2
   echo "A --ff-only abort usually means local edits or untracked files that an incoming commit also adds." >&2
   exit $rc
fi

echo "Deploy complete."
echo "Then, ON $HOST, run the benchmarks from $REMOTE_DIR (e.g. node runners/bench-run.mjs --target <host> …)."
echo "  llama.cpp hosts (rose/llm2): readiness check → ssh $HOST '$REMOTE_DIR/scripts/llm2/ready.sh'"
echo "  OptiQ hosts (m1/llm1):       launch daemon  → ssh $HOST '$REMOTE_DIR/scripts/llm1/serve.sh'"
