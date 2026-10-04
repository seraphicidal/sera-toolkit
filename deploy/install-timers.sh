#!/usr/bin/env bash
# SERA.toolkit — installs the deployment's systemd timers from deploy/systemd/.
#
# Run by provision.sh, and by hand after a release changes them:
#   sudo /opt/sera/deploy/install-timers.sh
#
# Units name /opt/sera; an install elsewhere (SERA_DIR) gets its own path written in.
set -euo pipefail

DIR="${SERA_DIR:-/opt/sera}"
cd "$DIR/deploy/systemd"

timers=()
for unit in *.service *.timer; do
  sed "s#/opt/sera#$DIR#g" "$unit" >"/etc/systemd/system/$unit"
  case "$unit" in *.timer) timers+=("$unit") ;; esac
done
# Only the scripts the units run; marking anything else executable would show up as a
# local edit to the checkout, which auto-update.sh then refuses to move forward.
chmod 755 "$DIR/deploy/auto-update.sh" "$DIR/deploy/alert-check.sh" "$DIR/deploy/canary.sh"

systemctl daemon-reload
systemctl enable --now "${timers[@]}"
systemctl list-timers --no-pager "${timers[@]}"
