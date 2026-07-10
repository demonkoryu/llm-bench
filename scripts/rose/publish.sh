#!/usr/bin/env bash
# Export the dashboard from the tidy store and, if it changed, commit + push to main.
# The push (touching results/dashboard.html) triggers .forgejo/workflows/pages.yml, which
# redeploys https://pages.xor0.de/llm-bench/. Safe to run on a timer: a flock guard prevents
# overlap with the previous tick, and it no-ops when the dashboard is unchanged.
#
# Env: LLM_BENCH_DIR (default ~/llm-bench). Requires a git push credential on rose (see
# scripts/rose/README.md); a missing credential is non-fatal — the commit is kept locally
# and the next cycle pushes the backlog once the credential is in place.
set -euo pipefail
REPO="${LLM_BENCH_DIR:-$HOME/llm-bench}"
cd "$REPO"

exec 9>"$REPO/.publish.lock"
if ! flock -n 9; then
   echo "[publish] another publish is in progress — skipping this tick"
   exit 0
fi

echo "[publish] exporting dashboard from tidy store…"
node analysis/export-dashboard.mjs

git add -A results
if git diff --cached --quiet; then
   echo "[publish] no changes since last publish — nothing to push"
   exit 0
fi

ts="$(date -u +%Y-%m-%dT%H:%M:%SZ)"
git commit -q -m "data: rose autopublish $ts"
if git push -q origin main; then
   echo "[publish] pushed autopublish $ts → pages workflow will deploy"
else
   echo "[publish] push FAILED (credential not set up yet?) — commit retained locally, will retry next tick"
fi
