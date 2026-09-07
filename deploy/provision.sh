#!/usr/bin/env bash
#
# Provisions a fresh cloud instance to run SERA.toolkit publicly.
#
# Written against Oracle Cloud's always-free Ampere (arm64) instance but not specific to
# it: it works on any Ubuntu or Oracle Linux host with a public IP. It installs Docker,
# opens the instance firewall, writes a production .env, and starts the stack behind Caddy
# with a real Let's Encrypt certificate.
#
#   curl -fsSL https://raw.githubusercontent.com/seraphicidal/sera-toolkit/main/deploy/provision.sh | bash
#
# or, from a checkout:  sudo bash deploy/provision.sh
#
# Safe to re-run: every step checks before acting.

set -euo pipefail

REPO="${SERA_REPO:-https://github.com/seraphicidal/sera-toolkit.git}"
INSTALL_DIR="${SERA_DIR:-/opt/sera}"
COMPOSE_FILE="deploy/docker-compose.oracle.yml"

# Compose looks for .env beside the compose file, i.e. deploy/.env, which is not where
# provisioning writes it. Naming the file explicitly is what makes every later
# `docker compose` run from /opt/sera work instead of failing on interpolation.
COMPOSE=(docker compose --env-file .env -f "$COMPOSE_FILE")

log() { printf '\n\033[1;36m==> %s\033[0m\n' "$*"; }
warn() { printf '\033[1;33m !  %s\033[0m\n' "$*"; }
die() { printf '\033[1;31m !! %s\033[0m\n' "$*" >&2; exit 1; }

[ "$(id -u)" -eq 0 ] || die "run with sudo: sudo bash deploy/provision.sh"

# ---------------------------------------------------------------------------
# Packages
# ---------------------------------------------------------------------------

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
  # Docker's own convenience script covers Debian and Ubuntu on arm64, and pins to the
  # official repository rather than whatever the distro happens to ship.
  curl -fsSL --retry 5 --retry-all-errors --retry-delay 3 --connect-timeout 20 https://get.docker.com | sh
else
  # Oracle Linux reports itself as `ol`, which get.docker.com does not recognise — it
  # exits with "unsupported distribution" rather than installing anything. The CentOS
  # repository is RHEL-compatible and is what Docker's own documentation points Oracle
  # Linux users at.
  dnf install -y -q dnf-plugins-core
  dnf config-manager --add-repo https://download.docker.com/linux/centos/docker-ce.repo
  dnf install -y -q docker-ce docker-ce-cli containerd.io docker-buildx-plugin docker-compose-plugin
fi

systemctl enable --now docker

docker compose version >/dev/null 2>&1 || die "the docker compose plugin is missing"

# ---------------------------------------------------------------------------
# Instance firewall
# ---------------------------------------------------------------------------
#
# Cloud images ship with everything but SSH closed. This is separate from the cloud
# provider's own network rules — on Oracle you must ALSO add ingress rules for 80 and 443
# to the subnet's security list, or the packets never reach this machine.

log "Opening ports 80 and 443 on the instance"
if command -v firewall-cmd >/dev/null 2>&1 && systemctl is-active --quiet firewalld; then
  firewall-cmd --permanent --add-service=http
  firewall-cmd --permanent --add-service=https
  firewall-cmd --reload
  echo "firewalld updated"
elif command -v iptables >/dev/null 2>&1; then
  for port in 80 443; do
    if ! iptables -C INPUT -p tcp --dport "$port" -j ACCEPT 2>/dev/null; then
      # Inserted at the top: the default rule set ends in a REJECT that would otherwise
      # match first.
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

# ---------------------------------------------------------------------------
# Source
# ---------------------------------------------------------------------------

log "Fetching SERA.toolkit"
if [ -d "$INSTALL_DIR/.git" ]; then
  git -C "$INSTALL_DIR" pull --ff-only
else
  command -v git >/dev/null 2>&1 || { [ "$PKG" = apt ] && apt-get install -y -qq git || dnf install -y -q git; }
  git clone --depth 1 "$REPO" "$INSTALL_DIR"
fi
cd "$INSTALL_DIR"

# ---------------------------------------------------------------------------
# Configuration
# ---------------------------------------------------------------------------

if [ ! -f .env ]; then
  log "Writing .env"

  # The instance's own public address. sslip.io resolves 1-2-3-4.sslip.io to 1.2.3.4
  # with no account and no registration, which is enough for Let's Encrypt to issue —
  # so a public HTTPS deployment needs no domain purchase.
  PUBLIC_IP="${SERA_PUBLIC_IP:-$(curl -fsS --max-time 10 https://api.ipify.org || true)}"
  [ -n "$PUBLIC_IP" ] || die "could not determine the public IP; set SERA_PUBLIC_IP and re-run"
  DOMAIN="${SERA_DOMAIN:-${PUBLIC_IP//./-}.sslip.io}"

  SECRET="$(openssl rand -hex 32)"

  # One concurrent conversion per core. FFmpeg will use everything it is given, so on a
  # single-core instance a hard-coded 2 means two jobs each running at half speed and a
  # machine with nothing left for the API.
  CORES="$(nproc 2>/dev/null || echo 1)"
  CONCURRENCY="${SERA_WORKER_CONCURRENCY:-$CORES}"
  [ "$CONCURRENCY" -lt 1 ] && CONCURRENCY=1

  cat > .env <<EOF
# Generated by deploy/provision.sh — do not commit.
SERA_SECRET=${SECRET}
SERA_DOMAIN=${DOMAIN}
# Optional: where Let's Encrypt sends renewal warnings.
#SERA_TLS_EMAIL=you@example.com

SERA_RETENTION_SECONDS=1800
SERA_MAX_FILESIZE_BYTES=2147483648
SERA_MAX_DURATION_SECONDS=10800

# Sized from the ${CORES} core(s) this instance reported at provisioning time.
SERA_WORKER_CONCURRENCY=${CONCURRENCY}
SERA_WORKER_CPUS=${CORES}
LOG_LEVEL=info
EOF
  chmod 600 .env
  echo "domain: ${DOMAIN}"
else
  echo ".env already exists; leaving it alone"
fi

# shellcheck disable=SC1091
set -a; . ./.env; set +a

# Caddy's ACME contact address, as a file rather than a directive, because the directive
# cannot be made conditional. Rewritten on every run so editing .env is enough to change
# it. See the comment at the top of deploy/Caddyfile.
mkdir -p deploy/caddy.globals
if [ -n "${SERA_TLS_EMAIL:-}" ]; then
  printf 'email %s\n' "$SERA_TLS_EMAIL" > deploy/caddy.globals/email.caddy
else
  rm -f deploy/caddy.globals/email.caddy
fi

# ---------------------------------------------------------------------------
# Launch
# ---------------------------------------------------------------------------

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

cat <<EOF

  SERA.toolkit is starting.

    https://${SERA_DOMAIN}

  Caddy needs a minute to obtain its certificate on the first run. If the site does not
  answer:

    1. Check the cloud firewall. On Oracle this is separate from the instance firewall:
       Networking > Virtual Cloud Networks > your VCN > Security Lists > add ingress
       rules for TCP 80 and 443 from 0.0.0.0/0.
    2. sudo docker compose --env-file .env -f ${COMPOSE_FILE} logs caddy
    3. sudo docker compose --env-file .env -f ${COMPOSE_FILE} logs api

  Useful afterwards:

    cd /opt/sera
    sudo docker compose --env-file .env -f ${COMPOSE_FILE} ps
    sudo docker compose --env-file .env -f ${COMPOSE_FILE} logs -f worker

  To update:

    cd /opt/sera && sudo git pull
    sudo docker compose --env-file .env -f ${COMPOSE_FILE} pull
    sudo docker compose --env-file .env -f ${COMPOSE_FILE} up -d

EOF
