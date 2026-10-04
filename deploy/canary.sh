#!/usr/bin/env bash
# SERA.toolkit — the canary: a real download per source, once a day.
#
# /health says the tools are installed and the nodes are connected; it cannot say that a
# source still works. This asks the API, through its normal routes, for one small file from
# each source marked `canary` in scripts/provider-cases.json — YouTube through the extraction
# nodes, like any visitor — and records how it went in /var/lib/sera/canary.json:
#
#   [{ "source": "youtube-shorts", "label": "YouTube", "ok": false, "code": "SOURCE_BLOCKED",
#      "durationMs": 8123, "at": "2026-10-05T04:31:02Z", "consecutiveFailures": 2 }, ...]
#
# alert-check.sh reads that file and alerts once a source has failed two runs in a row.
#
#   sudo systemctl start sera-canary.service                 # run it now, through systemd
#   sudo /opt/sera/deploy/canary.sh                          # the same, in this terminal
#   sudo /opt/sera/deploy/canary.sh --only=youtube-shorts    # one source (others are kept)
#   journalctl -u sera-canary.service
#
# Requests carry SERA_CANARY_TOKEN (in /opt/sera/.env), which exempts them from rate limits
# and abuse strikes and keeps them out of usage counts. Each source has --timeout seconds
# (default 180) for its resolve, job and download together.
set -euo pipefail

DIR="${SERA_DIR:-/opt/sera}"
STATE_DIR=/var/lib/sera
OUT="$STATE_DIR/canary.json"
mkdir -p "$STATE_DIR"

if ! grep -q '^SERA_CANARY_TOKEN=.' "$DIR/.env"; then
  echo "[canary] SERA_CANARY_TOKEN is not set in $DIR/.env; see deploy/ORACLE.md" >&2
  exit 2
fi

api=$(/usr/local/bin/sera ps -q api)
if [ -z "$api" ]; then
  echo "[canary] the API container is not running" >&2
  exit 1
fi

results=$(docker exec "$api" node apps/api/dist/canary-cli.js "$@")
previous=$(cat "$OUT" 2>/dev/null || echo '[]')

# This run's results, each with its run of consecutive failures carried over from the last
# file; sources this run did not check (an --only run) keep their previous entry.
jq -n --argjson now "$results" --argjson prev "$previous" '
  ($now | map(. as $r
    | ([$prev[] | select(.source == $r.source)] | first) as $p
    | $r + { consecutiveFailures: (if $r.ok then 0 else (($p.consecutiveFailures // 0) + 1) end) }))
  + [$prev[] | select(.source as $s | [$now[].source] | index($s) | not)]
' >"$OUT.tmp"
mv "$OUT.tmp" "$OUT"

jq -r '.[] | "[canary] \(.label) (\(.source)): \(if .ok then "ok, \(.bytes) bytes" else "FAILED \(.code)" end) in \(.durationMs) ms"' <<<"$results"
