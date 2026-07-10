# Rose-native pipeline

Run the entire benchmark pipeline **on the GPU host (rose)** so it keeps going with the dev
PC off. rose is always on, holds the GPU, and is the Caddy host for pages.xor0.de.

## How it works

- **Local exec:** `runners/bench-run.mjs --local` (or env `BENCH_LOCAL=1`) runs the llm2 host
  scripts and router `systemctl` **locally** instead of over SSH. The inference client already
  targets `192.168.1.120:8090`, which is local on rose. Default behavior (dev-PC-drives-rose
  over SSH) is unchanged — `--local` is purely additive.
- **`llm-benchrun.service`** (systemd --user): the resumable run. Crash/reboot → auto-restart,
  `--resume` continues from the tidy parquet parts already on disk.
- **`llm-benchpublish.timer`** (every 15 min): `analysis/export-dashboard.mjs` → if
  `results/dashboard.html` changed, commit `results/` and `git push origin main`. The push
  triggers `.forgejo/workflows/pages.yml`, which redeploys pages.xor0.de/llm-bench.

## One-time bootstrap (on rose)

```bash
cd ~/llm-bench
git remote set-url origin https://git.xor0.de/demonkoryu/llm-bench.git
git fetch origin && git reset --hard origin/main
npm ci --omit=dev
git config user.name  "demonkoryu"
git config user.email "th.geist@gmail.com"

# Push credential (write-scope Forgejo token). credential.helper store keeps it in
# ~/.git-credentials after the first authenticated push:
git config credential.helper store

bash scripts/rose/install.sh
systemctl --user start llm-benchrun.service      # kick off the run
```

The **first** `git push` (run it once by hand, or let the publish timer do it) will prompt for
username + token; after that it is non-interactive. Until the credential exists, the run still
proceeds and results are committed locally — the publish step just retries the push each tick.

## Watch / operate

```bash
journalctl --user -u llm-benchrun -f                 # live per-bench progress
systemctl --user list-timers llm-benchpublish.timer  # next publish
systemctl --user start llm-benchpublish.service       # publish right now
systemctl --user stop  llm-benchrun.service           # pause the run (resume by starting again)
```
