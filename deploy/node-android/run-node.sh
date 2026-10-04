#!/data/data/com.termux/files/usr/bin/bash
# SERA.toolkit — keeps an extraction node running on an Android phone (Termux).
#
# A supervisor, checking every 30 seconds:
#   - runs the node, and starts it again 15 seconds after it exits;
#   - stops it while the phone is off Wi-Fi or unplugged, if ~/.sera-node/node.conf says so
#     (ONLY_ON_WIFI, ONLY_WHILE_CHARGING; read through the Termux:API app), and starts it
#     again when they hold;
#   - refreshes yt-dlp to the version pinned on main at start and every 24 hours, unless
#     ~/.sera-node/ytdlp-updates.paused exists.
# It holds a Termux wake lock so Android does not suspend it with the screen off.
#
# Started at boot by ~/.termux/boot/sera-node (setup.sh installs it), or by hand:
#   ~/sera-toolkit/deploy/node-android/run-node.sh &
# Logs: ~/.sera-node/node.log (the node), supervisor.log, ytdlp-update.log.
set -u

DIR="${SERA_NODE_DIR:-$HOME/sera-toolkit}"
STATE="$HOME/.sera-node"
LOG="$STATE/node.log"
PIDFILE="$STATE/supervisor.pid"
CHECK_SECONDS="${SERA_NODE_CHECK_SECONDS:-30}"
REFRESH_SECONDS=86400

mkdir -p "$STATE"

say() { echo "[$(date '+%Y-%m-%d %H:%M:%S')] $*"; }

# One supervisor at a time: Termux:Boot and a hand start would otherwise run two nodes.
if [ -f "$PIDFILE" ] && kill -0 "$(cat "$PIDFILE")" 2>/dev/null; then
  say "already running as $(cat "$PIDFILE")"
  exit 0
fi
echo $$ >"$PIDFILE"

ONLY_ON_WIFI=0
ONLY_WHILE_CHARGING=0
# shellcheck disable=SC1091
[ -f "$STATE/node.conf" ] && . "$STATE/node.conf"

child=''
reason=''
last_refresh=0

stop_node() {
  if [ -n "$child" ] && kill -0 "$child" 2>/dev/null; then
    kill "$child" 2>/dev/null
    wait "$child" 2>/dev/null
  fi
  child=''
}

shutdown() {
  say "stopping"
  stop_node
  command -v termux-wake-unlock >/dev/null && termux-wake-unlock
  rm -f "$PIDFILE"
  exit 0
}
trap shutdown TERM INT HUP

# Termux:API answers through the companion app; without it the commands hang, hence the
# timeout. A condition that cannot be checked counts as not met, so "only on Wi-Fi" never
# quietly becomes "on mobile data too".
api() { timeout 15 "$@" 2>/dev/null; }

conditions_hold() {
  reason=''
  if [ "$ONLY_WHILE_CHARGING" = 1 ]; then
    if ! api termux-battery-status | grep -Eq '"plugged": *"PLUGGED_'; then
      reason='not charging'
      return 1
    fi
  fi
  if [ "$ONLY_ON_WIFI" = 1 ]; then
    if ! api termux-wifi-connectioninfo | grep -Eq '"supplicant_state": *"COMPLETED"'; then
      reason='not on Wi-Fi'
      return 1
    fi
  fi
  return 0
}

refresh_ytdlp() {
  last_refresh=$(date +%s)
  if [ -e "$STATE/ytdlp-updates.paused" ]; then
    say "yt-dlp updates are paused" >>"$STATE/ytdlp-update.log"
    return
  fi
  say "refreshing yt-dlp" >>"$STATE/ytdlp-update.log"
  (cd "$DIR" && npm run -s tools:fetch -- --only=ytdlp --pin-from=main) \
    >>"$STATE/ytdlp-update.log" 2>&1 || say "yt-dlp refresh failed; trying again tomorrow"
}

configured() {
  grep -Eq '^SERA_EXTRACTION_NODE_TOKEN=.+' "$DIR/.env.node.local" 2>/dev/null
}

start_node() {
  say "starting extraction node" >>"$LOG"
  (cd "$DIR" && exec node --env-file=.env.node.local apps/extractor/dist/index.js) >>"$LOG" 2>&1 &
  child=$!
}

command -v termux-wake-lock >/dev/null && termux-wake-lock
# Keep one previous log of each; start fresh so neither grows forever.
for file in "$LOG" "$STATE/ytdlp-update.log"; do
  [ -f "$file" ] && mv -f "$file" "$file.old"
done
say "supervisor started (Wi-Fi only: $ONLY_ON_WIFI, charging only: $ONLY_WHILE_CHARGING)"

# What the log last said the node was doing, so each change is written once, not every check.
state=''
report() {
  [ "$state" = "$1" ] && return
  state=$1
  say "$1"
}

while :; do
  if [ $(($(date +%s) - last_refresh)) -ge "$REFRESH_SECONDS" ]; then
    refresh_ytdlp
  fi

  if ! configured; then
    report "waiting: no SERA_EXTRACTION_NODE_TOKEN in $DIR/.env.node.local"
    stop_node
  elif conditions_hold; then
    report 'running'
    if [ -z "$child" ]; then
      start_node
    elif ! kill -0 "$child" 2>/dev/null; then
      wait "$child"
      say "node exited with code $?; restarting in 15 seconds"
      child=''
      sleep 15
      continue
    fi
  else
    report "paused: $reason"
    stop_node
  fi

  # In the background and waited on, so a TERM is handled now rather than after the sleep.
  sleep "$CHECK_SECONDS" &
  wait $!
done
