#!/usr/bin/env bash
set -euo pipefail

DIR="${SERA_DIR:-/opt/sera}"
case "$DIR" in
  /*) ;;
  *) echo "SERA_DIR must be an absolute path" >&2; exit 1 ;;
esac
case "$DIR" in
  *'#'*|*'&'*|*$'\n'*) echo "SERA_DIR contains unsupported characters" >&2; exit 1 ;;
esac
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
