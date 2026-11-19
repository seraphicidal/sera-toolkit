#!/usr/bin/env bash
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
DIR="${SERA_DIR:-$(cd "$SCRIPT_DIR/.." && pwd)}"
STATE_DIR=/var/lib/sera
OUT="$STATE_DIR/canary.json"
mkdir -p "$STATE_DIR"

canary_token=$(sed -n 's/^SERA_CANARY_TOKEN=//p' "$DIR/.env" 2>/dev/null | tail -n 1 | tr -d '"'"'"' \r' || true)
if [ -z "$canary_token" ]; then
  echo "[canary] SERA_CANARY_TOKEN is not set in $DIR/.env; see deploy/ORACLE.md" >&2
  exit 2
fi

api=$(/usr/local/bin/sera ps -q api)
if [ -z "$api" ]; then
  echo "[canary] the API container is not running" >&2
  exit 1
fi

results=$(docker exec "$api" node apps/api/dist/canary-cli.js "$@")
if [ -s "$OUT" ] && jq -e type "$OUT" >/dev/null 2>&1; then
  previous=$(cat "$OUT")
else
  previous='[]'
fi

jq -n --argjson now "$results" --argjson prev "$previous" '
  ($now | map(. as $r
    | ([$prev[] | select(.source == $r.source)] | first) as $p
    | $r + { consecutiveFailures: (if $r.ok then 0 else (($p.consecutiveFailures // 0) + 1) end) }))
  + [$prev[] | select(.source as $s | [$now[].source] | index($s) | not)]
' >"$OUT.tmp"
mv "$OUT.tmp" "$OUT"

jq -r '.[] | "[canary] \(.label) (\(.source)): \(if .ok then "ok, \(.bytes) bytes" else "FAILED \(.code)" end) in \(.durationMs) ms"' <<<"$results"
