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

ssh -o BatchMode=yes -o ConnectTimeout=10 "$HOST" \
   "cd $REMOTE_DIR && git fetch && git pull --ff-only && chmod +x scripts/llm2/*.sh"

echo "Deploy complete."
echo "Run readiness check with: ssh $HOST '$REMOTE_DIR/scripts/llm2/ready.sh'"
