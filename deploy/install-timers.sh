#!/usr/bin/env bash
set -euo pipefail

DIR="${SERA_DIR:-/opt/sera}"
cd "$DIR/deploy/systemd"

timers=()
for unit in *.service *.timer; do
  sed "s#/opt/sera#$DIR#g" "$unit" >"/etc/systemd/system/$unit"
  case "$unit" in *.timer) timers+=("$unit") ;; esac
done
chmod 755 "$DIR/deploy/auto-update.sh" "$DIR/deploy/alert-check.sh" "$DIR/deploy/canary.sh"

systemctl daemon-reload
systemctl enable --now "${timers[@]}"
systemctl list-timers --no-pager "${timers[@]}"
