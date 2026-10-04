#!/usr/bin/env bash
# SERA.toolkit — push notifications when the deployment changes state.
#
# Run by sera-alert.timer every 5 minutes. Each condition below is either "up" or "down",
# and a notification goes to ntfy.sh only when one changes — once when it breaks, once when
# it recovers — never on every check. A condition has to be seen twice in a row before it
# counts as changed, so a ten-second restart during a deploy, or a laptop node reconnecting,
# does not page anyone.
#
#   API           /health answers through Caddy
#   nodes         at least one extraction node is live (YouTube depends on it)
#   checks        every other /health check is ok (yt-dlp, ffmpeg, storage, queue)
#   auto-update   the server's own auto-update (deploy/auto-update.sh) last succeeded
#   ytdlp-update  GitHub's daily yt-dlp update workflow last succeeded
#   canary-<id>   one per source: the daily canary (deploy/canary.sh) could download from it.
#                 It counts as down only after two failed canary runs in a row, so one
#                 flaky night does not page anyone.
#
# The topic comes from SERA_ALERT_NTFY_TOPIC in /opt/sera/.env. Without one this does
# nothing. Subscribe to the same topic in the ntfy app. It is the only secret here: anyone
# who knows it can read the alerts, so it is random and long.
#
#   sudo /opt/sera/deploy/alert-check.sh             # one check, by hand
#   sudo /opt/sera/deploy/alert-check.sh --test      # send a test notification
#   journalctl -u sera-alert.service
set -euo pipefail

DIR="${SERA_DIR:-/opt/sera}"
STATE_DIR=/var/lib/sera/alerts
CANARY=/var/lib/sera/canary.json
REPO="${SERA_ALERT_REPO:-seraphicidal/sera-toolkit}"
mkdir -p "$STATE_DIR"

env_value() { sed -n "s/^$1=//p" "$DIR/.env" | tail -n 1 | tr -d '"'"'"' '; }
topic=$(env_value SERA_ALERT_NTFY_TOPIC)
domain=$(env_value SERA_DOMAIN)
if [ -z "$topic" ]; then
  echo "[alert] SERA_ALERT_NTFY_TOPIC is not set; nothing to do"
  exit 0
fi

notify() { # title, message, priority, tags
  curl -fsS --max-time 15 -o /dev/null \
    -H "Title: $1" -H "Priority: $3" -H "Tags: $4" \
    -H "Click: https://$domain/health" \
    -d "$2" "https://ntfy.sh/$topic" ||
    echo "[alert] could not reach ntfy.sh"
}

if [ "${1:-}" = --test ]; then
  notify "SERA: test" "Alerts from $domain reach this device." default white_check_mark
  exit 0
fi

label() {
  case "$1" in
    api) echo 'The API' ;;
    nodes) echo 'Extraction nodes' ;;
    checks) echo 'Health checks' ;;
    auto-update) echo "The server's auto-update" ;;
    ytdlp-update) echo 'The daily yt-dlp update' ;;
  esac
}

# observe <name> <up|down> <what is wrong> [<what recovered>]
# Records an observation; notifies when a state has held for two checks and differs from
# the last state notified. Unknown (first run) counts as up, so a fresh install is quiet.
observe() {
  local name=$1 seen=$2 detail=$3 recovered=${4:-}
  local file="$STATE_DIR/$name"
  local notified=up pending='' count=0
  # shellcheck disable=SC1090
  [ -f "$file" ] && . "$file"
  if [ "$seen" = "$notified" ]; then
    pending='' count=0
  elif [ "$seen" = "$pending" ]; then
    count=$((count + 1))
  else
    pending=$seen count=1
  fi
  if [ "$count" -ge 2 ]; then
    if [ "$seen" = down ]; then
      notify "SERA: $detail" "$detail on $domain." high rotating_light
    else
      if [ -n "$recovered" ]; then
        notify "SERA: $recovered recovered" "$recovered recovered on $domain." default white_check_mark
      else
        notify "SERA: recovered" "$(label "$name") is back to normal on $domain." default white_check_mark
      fi
    fi
    notified=$seen pending='' count=0
  fi
  printf 'notified=%s\npending=%s\ncount=%s\n' "$notified" "$pending" "$count" >"$file"
  echo "[alert] $name: $seen (notified $notified)"
}

# 1–3. The site's own report, asked through Caddy on this host.
body=$(curl -fsS --max-time 15 --resolve "$domain:443:127.0.0.1" "https://$domain/health" || true)
if [ -z "$body" ] || ! echo "$body" | jq -e .checks >/dev/null 2>&1; then
  observe api down "the API is not answering"
  # Nothing else can be judged without the report; leave those states as they were.
else
  observe api up ''
  nodes=$(echo "$body" | jq -r '[.checks[] | select(.name == "extraction-nodes") | .status][0] // "absent"')
  if [ "$nodes" = ok ] || [ "$nodes" = absent ]; then
    observe nodes up ''
  else
    observe nodes down "no extraction node is live (YouTube will fail)"
  fi
  failing=$(echo "$body" | jq -r '[.checks[] | select(.name != "extraction-nodes" and .status != "ok") | .name] | join(", ")')
  if [ -z "$failing" ]; then
    observe checks up ''
  else
    observe checks down "health check failing: $failing"
  fi
fi

# 4. This server's auto-update.
update=$(cut -d' ' -f1 /var/lib/sera/auto-update.status 2>/dev/null || echo ok)
if [ "$update" = failed ]; then
  observe auto-update down "the server's auto-update failed and rolled back"
else
  observe auto-update up ''
fi

# 5. GitHub's yt-dlp update. Public repository, so no token; the last finished run decides.
conclusion=$(curl -fsS --max-time 15 \
  "https://api.github.com/repos/$REPO/actions/workflows/update-ytdlp.yml/runs?status=completed&per_page=1" |
  jq -r '.workflow_runs[0].conclusion // "none"' 2>/dev/null || echo unknown)
case "$conclusion" in
  failure | timed_out) observe ytdlp-update down "the daily yt-dlp update failed on GitHub" ;;
  unknown) echo "[alert] ytdlp-update: GitHub did not answer; unchanged" ;;
  *) observe ytdlp-update up '' ;;
esac

# 6. The canary: a real download per source, once a day. Down after two failed runs in a row.
if [ -f "$CANARY" ]; then
  while IFS=$'	' read -r source source_label failures code; do
    if [ "$failures" -ge 2 ]; then
      observe "canary-$source" down "$source_label downloads failing: $code" "$source_label downloads"
    else
      observe "canary-$source" up '' "$source_label downloads"
    fi
  done < <(jq -r '.[] | [.source, .label, (.consecutiveFailures // 0), (.code // "")] | @tsv' "$CANARY")
fi
