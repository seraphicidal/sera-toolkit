#!/usr/bin/env bash

set -euo pipefail

REPO="${SERA_REPO:-https://github.com/seraphicidal/sera-toolkit.git}"
INSTALL_DIR="${SERA_DIR:-/opt/sera}"
case "$INSTALL_DIR" in
  /*) ;;
  *) echo "SERA_DIR must be an absolute path" >&2; exit 1 ;;
esac
case "$INSTALL_DIR" in
  *'#'*|*'&'*|*$'\n'*|*' '*|*"'"*|*'"'*) echo "SERA_DIR contains unsupported characters" >&2; exit 1 ;;
esac
COMPOSE_FILE="deploy/docker-compose.oracle.yml"

COMPOSE=(
  docker compose
  --project-directory "$INSTALL_DIR"
  --env-file "$INSTALL_DIR/.env"
  -f "$INSTALL_DIR/$COMPOSE_FILE"
)

log() { printf '\n\033[1;36m==> %s\033[0m\n' "$*"; }
warn() { printf '\033[1;33m !  %s\033[0m\n' "$*"; }
die() { printf '\033[1;31m !! %s\033[0m\n' "$*" >&2; exit 1; }

[ "$(id -u)" -eq 0 ] || die "run with sudo: sudo bash deploy/provision.sh"

if command -v apt-get >/dev/null 2>&1; then
  PKG=apt
elif command -v dnf >/dev/null 2>&1; then
  PKG=dnf
else
  die "unsupported distribution: need apt or dnf"
fi

log "Installing Docker"
if command -v docker >/dev/null 2>&1; then
  echo "Docker already present: $(docker --version)"
elif [ "$PKG" = apt ]; then
  DEBIAN_FRONTEND=noninteractive apt-get update -qq
  DEBIAN_FRONTEND=noninteractive apt-get install -y -qq ca-certificates curl gnupg
  install -m 0755 -d /etc/apt/keyrings
  os_id=""
  os_codename=""
  if [ -r /etc/os-release ]; then
    os_id=$(. /etc/os-release && printf '%s' "${ID:-}")
    os_codename=$(. /etc/os-release && printf '%s' "${UBUNTU_CODENAME:-${VERSION_CODENAME:-}}")
  fi
  case "$os_id" in
    ubuntu | debian) ;;
    *) die "unsupported apt distribution '${os_id:-unknown}'; install Docker manually and re-run" ;;
  esac
  case "$os_codename" in
    '' | *[!a-z0-9-]*) die "unsupported or missing distribution codename '${os_codename:-empty}'" ;;
  esac
  tmp_key=$(mktemp)
  if ! curl -fsSL --retry 5 --retry-all-errors --retry-delay 3 --connect-timeout 20 \
    "https://download.docker.com/linux/${os_id}/gpg" -o "$tmp_key"; then
    rm -f "$tmp_key"
    die "failed to download Docker GPG key"
  fi
  expected_fpr="9DC858229FC7DD38854AE2D88D81803C0EBFCD88"
  actual_fpr=$(gpg --batch --show-keys --with-colons "$tmp_key" 2>/dev/null | awk -F: '$1 == "fpr" { print $10; exit }')
  if [ "$actual_fpr" != "$expected_fpr" ]; then
    rm -f "$tmp_key"
    die "Docker GPG key fingerprint mismatch: expected ${expected_fpr}, got ${actual_fpr:-none}"
  fi
  install -m 0644 "$tmp_key" /etc/apt/keyrings/docker.asc
  rm -f "$tmp_key"
  printf 'deb [arch=%s signed-by=/etc/apt/keyrings/docker.asc] https://download.docker.com/linux/%s %s stable\n' \
    "$(dpkg --print-architecture)" "$os_id" "$os_codename" >/etc/apt/sources.list.d/docker.list
  DEBIAN_FRONTEND=noninteractive apt-get update -qq
  DEBIAN_FRONTEND=noninteractive apt-get install -y -qq docker-ce docker-ce-cli containerd.io docker-buildx-plugin docker-compose-plugin
else
  dnf install -y -q dnf-plugins-core
  dnf config-manager --add-repo https://download.docker.com/linux/centos/docker-ce.repo
  dnf install -y -q docker-ce docker-ce-cli containerd.io docker-buildx-plugin docker-compose-plugin
fi

systemctl enable --now docker

docker compose version >/dev/null 2>&1 || die "the docker compose plugin is missing"

log "Opening ports 80 and 443 on the instance"
if command -v firewall-cmd >/dev/null 2>&1 && systemctl is-active --quiet firewalld; then
  firewall-cmd --permanent --add-service=http
  firewall-cmd --permanent --add-service=https
  firewall-cmd --reload
  echo "firewalld updated"
elif command -v iptables >/dev/null 2>&1; then
  for port in 80 443; do
    if ! iptables -C INPUT -p tcp --dport "$port" -m conntrack --ctstate NEW -j ACCEPT 2>/dev/null; then
      iptables -I INPUT 1 -p tcp --dport "$port" -m conntrack --ctstate NEW -j ACCEPT
      echo "iptables: opened $port"
    fi
  done
  if [ "$PKG" = apt ]; then
    DEBIAN_FRONTEND=noninteractive apt-get install -y -qq iptables-persistent >/dev/null 2>&1 || true
    netfilter-persistent save >/dev/null 2>&1 || warn "could not persist iptables rules"
  fi
else
  warn "no firewall tool found; assuming ports are already open"
fi

log "Fetching SERA.toolkit"
if [ -d "$INSTALL_DIR/.git" ]; then
  git -C "$INSTALL_DIR" pull --ff-only
else
  if ! command -v git >/dev/null 2>&1; then
    if [ "$PKG" = apt ]; then apt-get install -y -qq git; else dnf install -y -q git; fi
  fi
  git clone --depth 1 "$REPO" "$INSTALL_DIR"
fi
for tool in curl jq; do
  if ! command -v "$tool" >/dev/null 2>&1; then
    if [ "$PKG" = apt ]; then apt-get install -y -qq "$tool"; else dnf install -y -q "$tool"; fi
  fi
done
cd "$INSTALL_DIR"

if [ ! -f .env ]; then
  log "Writing .env"

  PUBLIC_IP="${SERA_PUBLIC_IP:-$(curl -fsS --max-time 10 https://api.ipify.org || true)}"
  [ -n "$PUBLIC_IP" ] || die "could not determine the public IP; set SERA_PUBLIC_IP and re-run"
  ip_re='^[0-9]{1,3}(\.[0-9]{1,3}){3}$'
  [[ "$PUBLIC_IP" =~ $ip_re ]] || die "invalid public IP '${PUBLIC_IP}'; set SERA_PUBLIC_IP and re-run"
  DOMAIN="${SERA_DOMAIN:-${PUBLIC_IP//./-}.sslip.io}"

  SECRET="$(openssl rand -hex 32)"
  REDIS_PASSWORD="$(openssl rand -hex 24)"
  WORKER_TOKEN="$(openssl rand -hex 32)"

  CORES="$(nproc 2>/dev/null || echo 1)"
  CONCURRENCY="${SERA_WORKER_CONCURRENCY:-$CORES}"
  [ "$CONCURRENCY" -lt 1 ] && CONCURRENCY=1

  cat > .env <<EOF
SERA_SECRET=${SECRET}
SERA_REDIS_PASSWORD=${REDIS_PASSWORD}
SERA_EXTRACTION_WORKER_TOKEN=${WORKER_TOKEN}
SERA_DOMAIN=${DOMAIN}

SERA_RETENTION_SECONDS=1800
SERA_MAX_FILESIZE_BYTES=2147483648
SERA_MAX_DURATION_SECONDS=10800

SERA_WORKER_CONCURRENCY=${CONCURRENCY}
SERA_WORKER_CPUS=${CORES}
LOG_LEVEL=info
EOF
  chmod 600 .env
  echo "domain: ${DOMAIN}"
else
  echo ".env already exists; leaving it alone"
fi

read_env_var() {
  local key="$1"
  grep -E "^${key}=" .env 2>/dev/null | tail -n 1 | cut -d= -f2- | tr -d '\r' || true
}

SERA_DOMAIN="$(read_env_var SERA_DOMAIN)"
SERA_TLS_EMAIL="$(read_env_var SERA_TLS_EMAIL)"

mkdir -p deploy/caddy.globals
if [ -n "${SERA_TLS_EMAIL:-}" ]; then
  email_re='^[^[:space:]"{};]+@[^[:space:]"{};]+$'
  [[ "$SERA_TLS_EMAIL" =~ $email_re ]] || die "invalid SERA_TLS_EMAIL in .env"
  printf 'email %s\n' "$SERA_TLS_EMAIL" > deploy/caddy.globals/email.caddy
else
  rm -f deploy/caddy.globals/email.caddy
fi

log "Installing the sera command"
cat > /usr/local/bin/sera <<WRAPPER
#!/usr/bin/env bash
export SERA_DIR="$INSTALL_DIR"
if [ "\${1:-}" = stats ]; then shift; exec bash "$INSTALL_DIR/deploy/stats.sh" "\$@"; fi
if [ "\${1:-}" = reports ]; then shift; exec bash "$INSTALL_DIR/deploy/reports.sh" "\$@"; fi
exec docker compose --project-directory "$INSTALL_DIR" --env-file "$INSTALL_DIR/.env" -f "$INSTALL_DIR/$COMPOSE_FILE" "\$@"
WRAPPER
chmod 755 /usr/local/bin/sera

log "Pulling images"
"${COMPOSE[@]}" pull

log "Starting the stack"
"${COMPOSE[@]}" up -d --remove-orphans

log "Waiting for the API to report healthy"
for _ in $(seq 1 60); do
  if "${COMPOSE[@]}" exec -T api \
      node -e "fetch('http://127.0.0.1:4000/health').then(r=>r.json()).then(j=>process.exit(j.status==='ok'?0:1)).catch(()=>process.exit(1))" \
      >/dev/null 2>&1; then
    break
  fi
  sleep 3
done

"${COMPOSE[@]}" ps

log "Installing the update timer"
SERA_DIR="$INSTALL_DIR" bash "$INSTALL_DIR/deploy/install-timers.sh"

cat <<EOF

  SERA.toolkit is starting.

    https://${SERA_DOMAIN}

  Caddy needs a minute to obtain its certificate on the first run. If the site does not
  answer:

    1. Check the cloud firewall. On Oracle this is separate from the instance firewall:
       Networking > Virtual Cloud Networks > your VCN > Security Lists > add ingress
       rules for TCP 80 and 443 from 0.0.0.0/0.
    2. sudo sera logs caddy
    3. sudo sera logs api

  Useful afterwards. The sera command wraps docker compose for this deployment and
  works from any directory:

    sudo sera ps
    sudo sera logs -f worker

  Updates are automatic: sera-update.timer deploys new images within 15 minutes of
  their being published, and rolls back if the site is not healthy afterwards.

    journalctl -u sera-update.service
    sudo touch ${INSTALL_DIR}/.auto-update-paused

  To update by hand instead:

    sudo git -C ${INSTALL_DIR} pull
    sudo sera pull && sudo sera up -d

EOF
