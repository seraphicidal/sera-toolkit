#!/usr/bin/env bash
# SERA.toolkit — usage counts for the last days, as a table.
#
#   sudo sera stats              # the last 7 days
#   sudo sera stats --days=30    # up to 90, which is as long as counts are kept
#   sudo sera stats --json       # the admin endpoint's answer, unformatted
#
# Per source and day: resolves and downloads, failures by error code, and bytes delivered.
# Nothing about who: see "Usage counts" in deploy/ORACLE.md. Reads the API's admin
# endpoint from inside its container, so it needs SERA_ADMIN_TOKEN in /opt/sera/.env.
# Run through `bash` by the sera command, so it needs no executable bit in the checkout.
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
