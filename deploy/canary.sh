#!/usr/bin/env bash
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

jq -n --argjson now "$results" --argjson prev "$previous" '
  ($now | map(. as $r
    | ([$prev[] | select(.source == $r.source)] | first) as $p
    | $r + { consecutiveFailures: (if $r.ok then 0 else (($p.consecutiveFailures // 0) + 1) end) }))
  + [$prev[] | select(.source as $s | [$now[].source] | index($s) | not)]
' >"$OUT.tmp"
mv "$OUT.tmp" "$OUT"

jq -r '.[] | "[canary] \(.label) (\(.source)): \(if .ok then "ok, \(.bytes) bytes" else "FAILED \(.code)" end) in \(.durationMs) ms"' <<<"$results"
