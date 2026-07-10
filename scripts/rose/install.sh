#!/usr/bin/env bash
# Install the rose-native llm-bench systemd --user units:
#   - llm-benchrun.service     the resumable benchmark run (local exec)
#   - llm-benchpublish.timer   exports + pushes the dashboard every 15 min
#
# Enables linger so both survive logout AND rose reboots (the run resumes via --resume).
# Run ON rose from the repo root:  bash scripts/rose/install.sh
set -euo pipefail
REPO="${LLM_BENCH_DIR:-$HOME/llm-bench}"
UNIT_DIR="$HOME/.config/systemd/user"
mkdir -p "$UNIT_DIR"

for u in llm-benchrun.service llm-benchpublish.service llm-benchpublish.timer; do
   cp "$REPO/scripts/rose/$u" "$UNIT_DIR/$u"
done

# Survive logout + reboot (user services run without an active login session).
loginctl enable-linger "$USER" 2>/dev/null || sudo -n loginctl enable-linger "$USER" || true

systemctl --user daemon-reload
systemctl --user enable llm-benchrun.service        # start on boot (reboot-resume); started manually the first time
systemctl --user enable --now llm-benchpublish.timer

cat <<EOF

Installed. Next steps:
  Start the run:    systemctl --user start llm-benchrun.service
  Watch progress:   journalctl --user -u llm-benchrun -f
  Publish now:      systemctl --user start llm-benchpublish.service
  Timer status:     systemctl --user list-timers llm-benchpublish.timer
EOF
