#!/data/data/com.termux/files/usr/bin/bash
set -u

DIR="${SERA_NODE_DIR:-$HOME/sera-toolkit}"
STATE="$HOME/.sera-node"
LOG="$STATE/node.log"
PIDFILE="$STATE/supervisor.pid"
CHECK_SECONDS="${SERA_NODE_CHECK_SECONDS:-30}"
REFRESH_SECONDS=86400

mkdir -p "$STATE"

say() { echo "[$(date '+%Y-%m-%d %H:%M:%S')] $*"; }

if [ -f "$PIDFILE" ] && kill -0 "$(cat "$PIDFILE")" 2>/dev/null; then
  say "already running as $(cat "$PIDFILE")"
  exit 0
fi
echo $$ >"$PIDFILE"

ONLY_ON_WIFI=0
ONLY_WHILE_CHARGING=0
[ -f "$STATE/node.conf" ] && . "$STATE/node.conf"

child=''
refresh_pid=''
reason=''
last_refresh=0

trim_log() {
  local f=$1
  if [ -f "$f" ] && [ "$(wc -l <"$f" 2>/dev/null || echo 0)" -gt 2000 ]; then
    tail -n 1000 "$f" >"$f.tmp" && mv -f "$f.tmp" "$f"
  fi
}

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
  if [ -n "$refresh_pid" ] && kill -0 "$refresh_pid" 2>/dev/null; then
    kill "$refresh_pid" 2>/dev/null
    wait "$refresh_pid" 2>/dev/null
  fi
  command -v termux-wake-unlock >/dev/null && termux-wake-unlock
  rm -f "$PIDFILE"
  exit 0
}
trap shutdown TERM INT HUP

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
  if [ -n "$refresh_pid" ] && kill -0 "$refresh_pid" 2>/dev/null; then
    return
  fi
  trim_log "$LOG"
  trim_log "$STATE/ytdlp-update.log"
  if [ -e "$STATE/ytdlp-updates.paused" ]; then
    last_refresh=$(date +%s)
    say "yt-dlp updates are paused" >>"$STATE/ytdlp-update.log"
    return
  fi
  last_refresh=$(date +%s)
  (
    say "refreshing yt-dlp" >>"$STATE/ytdlp-update.log"
    if ! (cd "$DIR" && npm run -s tools:fetch -- --only=ytdlp --pin-from=main) \
      >>"$STATE/ytdlp-update.log" 2>&1; then
      say "yt-dlp refresh failed; will retry on next interval" >>"$STATE/ytdlp-update.log"
    fi
  ) &
  refresh_pid=$!
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
for file in "$LOG" "$STATE/ytdlp-update.log"; do
  [ -f "$file" ] && mv -f "$file" "$file.old"
done
say "supervisor started (Wi-Fi only: $ONLY_ON_WIFI, charging only: $ONLY_WHILE_CHARGING)"

state=''
report() {
  [ "$state" = "$1" ] && return
  state=$1
  say "$1"
}

while :; do
  if ! configured; then
    report "waiting: no SERA_EXTRACTION_NODE_TOKEN in $DIR/.env.node.local"
    stop_node
  elif conditions_hold; then
    if [ $(($(date +%s) - last_refresh)) -ge "$REFRESH_SECONDS" ]; then
      refresh_ytdlp
    fi
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

  sleep "$CHECK_SECONDS" &
  wait $!
done
