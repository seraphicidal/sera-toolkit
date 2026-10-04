#!/usr/bin/env bash
# SERA.toolkit — keeps the Oracle deployment on the latest published images.
#
# Run by sera-update.timer (deploy/systemd/), every 15 minutes. It does what an operator
# would do by hand — bring the checkout up to main, `sera pull`, `sera up -d` — but only
# when something actually changed, and it checks the result: if the site is not healthy
# within three minutes it puts back the images and the checkout it started from.
#
#   sudo /opt/sera/deploy/auto-update.sh          # one run, by hand
#   sudo systemctl start sera-update.service      # the same, through systemd
#   journalctl -u sera-update.service             # what it did
#
# To pause it: `sudo touch /opt/sera/.auto-update-paused` (delete the file to resume), or
# `sudo systemctl disable --now sera-update.timer`.
#
# It leaves a one-line state in /var/lib/sera/auto-update.status — `ok …`, `failed …` or
# `paused` — which the alert check (deploy/alert-check.sh) reads.
set -euo pipefail

DIR="${SERA_DIR:-/opt/sera}"
STATE_DIR=/var/lib/sera
STATUS="$STATE_DIR/auto-update.status"
# The image set that failed its health check last time, so a broken release is rolled back
# once and then left alone, rather than redeployed and rolled back every 15 minutes.
REFUSED="$STATE_DIR/auto-update.refused"
HEALTH_TIMEOUT_SECONDS=180

mkdir -p "$STATE_DIR"
cd "$DIR"

log() { echo "[auto-update] $*"; }
status() { echo "$* $(date -u +%Y-%m-%dT%H:%M:%SZ)" >"$STATUS"; }
sera() { /usr/local/bin/sera "$@"; }

if [ -e "$DIR/.auto-update-paused" ]; then
  log "paused ($DIR/.auto-update-paused exists)"
  status paused
  exit 0
fi

domain=$(sed -n 's/^SERA_DOMAIN=//p' "$DIR/.env" | tail -n 1 | tr -d '"'"'"' ')
if [ -z "$domain" ]; then
  log "SERA_DOMAIN is not set in $DIR/.env"
  status failed no-domain
  exit 1
fi

# Healthy means the whole path a visitor takes answers — Caddy, the web proxy, the API —
# and every check is ok apart from the extraction nodes, which are somebody's laptop and
# not something a deploy can break or fix. Asked on this host, so no hairpin through the
# public address is needed.
healthy() {
  local body
  body=$(curl -fsS --max-time 10 --resolve "$domain:443:127.0.0.1" "https://$domain/health") || return 1
  echo "$body" | jq -e '[.checks[] | select(.name != "extraction-nodes") | .status == "ok"] | all' >/dev/null || return 1
  curl -fsS --max-time 10 --resolve "$domain:443:127.0.0.1" -o /dev/null "https://$domain/ready" || return 1
  curl -fsS --max-time 10 --resolve "$domain:443:127.0.0.1" -o /dev/null "https://$domain/" || return 1
}

wait_healthy() {
  local deadline=$((SECONDS + HEALTH_TIMEOUT_SECONDS))
  while [ "$SECONDS" -lt "$deadline" ]; do
    healthy && return 0
    sleep 5
  done
  return 1
}

image_ids() {
  local image
  for image in $(sera config --images | sort -u); do
    echo "$image $(docker image inspect -f '{{.Id}}' "$image" 2>/dev/null || echo none)"
  done
}

# 1. The checkout. The compose file and these scripts come from it, so a release that
# changes them has to arrive with its images. Fast-forward only, and only when nobody has
# edited it here; an edited checkout is an operator's, and is left alone.
old_rev=$(git rev-parse HEAD)
git fetch -q origin main
if [ "$(git rev-parse origin/main)" != "$old_rev" ]; then
  if git diff --quiet && git diff --cached --quiet; then
    git merge -q --ff-only origin/main
    log "checkout ${old_rev:0:7} → $(git rev-parse --short HEAD)"
  else
    log "checkout has local changes; leaving it at ${old_rev:0:7}"
  fi
fi
new_rev=$(git rev-parse HEAD)

# 2. The images. What is running now is tagged :sera-rollback before anything is pulled.
before=$(image_ids)
while read -r image id; do
  [ "$id" = none ] || docker tag "$id" "${image%:*}:sera-rollback"
done <<<"$before"

sera pull -q
after=$(image_ids)

restore() {
  git reset -q --keep "$old_rev"
  while read -r image id; do
    [ "$id" = none ] || docker tag "${image%:*}:sera-rollback" "$image"
  done <<<"$before"
}

if [ "$before" = "$after" ] && [ "$old_rev" = "$new_rev" ]; then
  # Nothing new. A previous failure stays reported until a new release replaces it.
  if [ ! -e "$REFUSED" ] && ! grep -q '^ok' "$STATUS" 2>/dev/null; then status ok unchanged; fi
  exit 0
fi

if [ -e "$REFUSED" ] && [ "$(cat "$REFUSED")" = "$new_rev $after" ]; then
  # Put the tags and the checkout back too, so a `sera up` by hand does not quietly
  # deploy the release that was just refused.
  restore
  log "this release failed its health check before; not deploying it again"
  exit 1
fi

# 3. Deploy and check.
log "deploying $(git rev-parse --short HEAD)"
sera up -d --remove-orphans
if wait_healthy; then
  rm -f "$REFUSED"
  docker image prune -f >/dev/null
  log "healthy"
  status ok "$(git rev-parse --short HEAD) $(docker exec "$(sera ps -q api)" yt-dlp --version 2>/dev/null || true)"
  exit 0
fi

# 4. Roll back: the checkout first (the compose file may have changed), then the images.
log "not healthy within ${HEALTH_TIMEOUT_SECONDS}s; rolling back to ${old_rev:0:7}"
echo "$new_rev $after" >"$REFUSED"
restore
sera up -d --remove-orphans
if wait_healthy; then
  log "rolled back; healthy again"
  status failed "rolled-back $(git -C "$DIR" rev-parse --short "$new_rev")"
else
  log "rolled back, and still not healthy"
  status failed "rollback-unhealthy"
fi
exit 1
