#!/usr/bin/env bash
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
DIR="${SERA_DIR:-$(cd "$SCRIPT_DIR/.." && pwd)}"
STATE_DIR=/var/lib/sera
STATUS="$STATE_DIR/auto-update.status"
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

domain=$(sed -n 's/^SERA_DOMAIN=//p' "$DIR/.env" | tail -n 1 | tr -d '"'"'"' \r')
if [ -z "$domain" ]; then
  log "SERA_DOMAIN is not set in $DIR/.env"
  status failed no-domain
  exit 1
fi

escape_curl_cfg() {
  local v="$1"
  v="${v//$'\r'/}"
  v="${v//$'\n'/}"
  v="${v//\\/\\\\}"
  v="${v//\"/\\\"}"
  printf '%s' "$v"
}

healthy() {
  local admin_token canary_token auth_cfg=''
  admin_token=$(sed -n 's/^SERA_ADMIN_TOKEN=//p' "$DIR/.env" | tail -n 1 | tr -d '"'"'"' \r')
  canary_token=$(sed -n 's/^SERA_CANARY_TOKEN=//p' "$DIR/.env" | tail -n 1 | tr -d '"'"'"' \r')
  if [ -n "$admin_token" ]; then
    auth_cfg=$(printf 'header = "Authorization: Bearer %s"\n' "$(escape_curl_cfg "$admin_token")")
  elif [ -n "$canary_token" ]; then
    auth_cfg=$(printf 'header = "x-sera-canary: %s"\n' "$(escape_curl_cfg "$canary_token")")
  fi

  local body
  if [ -n "$auth_cfg" ]; then
    body=$(curl -fsS --max-time 10 --resolve "$domain:443:127.0.0.1" -K - "https://$domain/health" <<<"$auth_cfg") || return 1
  else
    body=$(curl -fsS --max-time 10 --resolve "$domain:443:127.0.0.1" "https://$domain/health") || return 1
  fi
  echo "$body" | jq -e '[.checks[] | select(.name != "extraction-nodes") | .status == "ok"] | all' >/dev/null || return 1
  if [ -n "$auth_cfg" ]; then
    curl -fsS --max-time 10 --resolve "$domain:443:127.0.0.1" -K - -o /dev/null "https://$domain/ready" <<<"$auth_cfg" || return 1
  else
    curl -fsS --max-time 10 --resolve "$domain:443:127.0.0.1" -o /dev/null "https://$domain/ready" || return 1
  fi
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

published() {
  local rev=$1 image repo pinned latest
  for image in $(sera config --images | sort -u); do
    case "$image" in */sera-*:latest) ;; *) continue ;; esac
    repo=${image%:*}
    pinned=$(docker buildx imagetools inspect "$repo:$rev" --format '{{.Manifest.Digest}}' 2>/dev/null) || return 1
    latest=$(docker buildx imagetools inspect "$repo:latest" --format '{{.Manifest.Digest}}' 2>/dev/null) || return 1
    [ -n "$pinned" ] && [ "$pinned" = "$latest" ] || return 1
  done
}

old_rev=$(git rev-parse HEAD)
git fetch -q origin main
target=$(git rev-parse origin/main)
if [ "$target" != "$old_rev" ] && ! published "$target"; then
  log "images for ${target:0:7} are not published yet; trying again next run"
  exit 0
elif [ "$target" != "$old_rev" ]; then
  if git -c core.fileMode=false diff --quiet && git -c core.fileMode=false diff --cached --quiet; then
    git merge -q --ff-only origin/main || git reset -q --hard origin/main
    log "checkout ${old_rev:0:7} → $(git rev-parse --short HEAD)"
  else
    log "checkout has local changes; leaving it at ${old_rev:0:7}"
  fi
fi
new_rev=$(git rev-parse HEAD)

remote_digests() {
  local image repo tag digest
  for image in $(sera config --images | sort -u); do
    local ref="${image%%@*}"
    local last="${ref##*/}"
    if [[ "$last" == *:* ]]; then
      repo="${ref%:*}"
      tag="${last##*:}"
    else
      repo="$ref"
      tag="latest"
    fi
    digest=$(docker buildx imagetools inspect "$repo:$tag" --format '{{.Manifest.Digest}}' 2>/dev/null || echo unknown)
    echo "$image $digest"
  done
}

rollback_tag() {
  local ref="${1%%@*}"
  local last="${ref##*/}"
  if [[ "$last" == *:* ]]; then
    local repo="${ref%:*}"
    local tag="${last##*:}"
    local safe_tag="${tag//[^a-zA-Z0-9._-]/_}"
    printf '%s:sera-rollback-%s\n' "$repo" "$safe_tag"
  else
    printf '%s:sera-rollback\n' "$ref"
  fi
}

pending_digests=$(remote_digests)
if [ -e "$REFUSED" ] && [ "$(cat "$REFUSED")" = "$new_rev $pending_digests" ]; then
  if [ "$old_rev" != "$new_rev" ]; then
    git reset -q --keep "$old_rev"
  fi
  log "this release failed its health check before; not pulling or deploying it again"
  exit 1
fi

before=$(image_ids)
while read -r image id; do
  [ "$id" = none ] || docker tag "$id" "$(rollback_tag "$image")"
done <<<"$before"

sera pull -q
after=$(image_ids)

restore() {
  git reset -q --keep "$old_rev"
  while read -r image id; do
    [ "$id" = none ] || docker tag "$(rollback_tag "$image")" "${image%%@*}"
  done <<<"$before"
}

if [ "$before" = "$after" ] && [ "$old_rev" = "$new_rev" ]; then
  if [ ! -e "$REFUSED" ] && ! grep -q '^ok' "$STATUS" 2>/dev/null; then status ok unchanged; fi
  exit 0
fi

log "deploying $(git rev-parse --short HEAD)"
sera up -d --remove-orphans
if wait_healthy; then
  rm -f "$REFUSED"
  docker image prune -f >/dev/null
  log "healthy"
  status ok "$(git rev-parse --short HEAD) $(docker exec "$(sera ps -q api)" yt-dlp --version 2>/dev/null || true)"
  exit 0
fi

log "not healthy within ${HEALTH_TIMEOUT_SECONDS}s; rolling back to ${old_rev:0:7}"
echo "$new_rev $pending_digests" >"$REFUSED"
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
