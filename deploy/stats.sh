#!/usr/bin/env bash
set -euo pipefail

DIR="${SERA_DIR:-/opt/sera}"

if ! grep -q '^SERA_ADMIN_TOKEN=.' "$DIR/.env"; then
  echo "[stats] SERA_ADMIN_TOKEN is not set in $DIR/.env; see deploy/ORACLE.md" >&2
  exit 2
fi

api=$(/usr/local/bin/sera ps -q api)
if [ -z "$api" ]; then
  echo "[stats] the API container is not running" >&2
  exit 1
fi

exec docker exec "$api" node apps/api/dist/stats-cli.js "$@"
