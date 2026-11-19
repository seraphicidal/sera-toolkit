#!/usr/bin/env bash
set -euo pipefail

DIR="${SERA_DIR:-/opt/sera}"

if ! grep -q '^SERA_ADMIN_TOKEN=.' "$DIR/.env"; then
  echo "[reports] SERA_ADMIN_TOKEN is not set in $DIR/.env" >&2
  exit 2
fi

api=$(/usr/local/bin/sera ps -q api)
if [ -z "$api" ]; then
  echo "[reports] the API container is not running" >&2
  exit 1
fi

exec docker exec "$api" node apps/api/dist/reports-cli.js "$@"
