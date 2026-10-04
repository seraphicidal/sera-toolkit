#!/data/data/com.termux/files/usr/bin/bash
# SERA.toolkit — set up an extraction node on an Android phone, in Termux.
#
# Run inside Termux (installed from F-Droid or GitHub, not the Play Store build):
#
#   curl -fsSLo setup.sh https://raw.githubusercontent.com/seraphicidal/sera-toolkit/main/deploy/node-android/setup.sh
#   bash setup.sh
#
# Downloaded first rather than piped into bash: a package upgrade can stop to ask a question,
# and with the script on stdin the answer would be read from the script itself.
#
# Safe to run again: it updates what is there. It installs Node, Python, FFmpeg and git;
# clones (or fast-forwards) the repository into ~/sera-toolkit; builds only the node; fetches
# the yt-dlp pinned on main (checksum-verified); writes ~/sera-toolkit/.env.node.local if
# there is none; and installs a Termux:Boot script so the node starts with the phone.
# deploy/EXTRACTION-NODE-ANDROID.md is the guide.
set -euo pipefail

REPO_URL="${SERA_REPO:-https://github.com/seraphicidal/sera-toolkit.git}"
DIR="${SERA_NODE_DIR:-$HOME/sera-toolkit}"
STATE="$HOME/.sera-node"
ENV_FILE="$DIR/.env.node.local"

log() { printf '\n\033[1m[sera] %s\033[0m\n' "$*"; }

if [ -z "${PREFIX:-}" ] || [ ! -d "$PREFIX" ]; then
  echo "This is meant to run inside Termux on Android." >&2
  exit 1
fi

log "Installing packages"
pkg update -y
# termux-api is the command-line side of the Termux:API app, used only for the optional
# Wi-Fi and charging conditions.
pkg install -y nodejs-lts python ffmpeg git termux-api

node_major=$(node -p 'process.versions.node.split(".")[0]')
if [ "$node_major" -lt 22 ]; then
  echo "Node $(node --version) is too old; SERA needs 22.12 or newer." >&2
  exit 1
fi

log "Fetching the code into $DIR"
if [ -d "$DIR/.git" ]; then
  git -C "$DIR" pull --ff-only
else
  git clone --depth 1 "$REPO_URL" "$DIR"
fi
cd "$DIR"

# Only what the node needs: the contracts, the engine and the extractor, not the web app's
# few hundred megabytes. --ignore-scripts because nothing here needs a native build.
log "Installing dependencies and building the node"
npm ci --ignore-scripts --no-audit --no-fund \
  -w @sera/contracts -w @sera/engine -w @sera/extractor --include-workspace-root
npm run build:node

log "Fetching yt-dlp"
npm run tools:fetch -- --only=ytdlp --pin-from=main
.tools/yt-dlp --version

mkdir -p "$STATE"
if [ ! -f "$STATE/node.conf" ]; then
  cat >"$STATE/node.conf" <<'EOF'
# Conditions for the SERA node on this phone. 1 = on, 0 = off.
# Run only while connected to Wi-Fi (no mobile data spent on downloads):
ONLY_ON_WIFI=1
# Run only while charging:
ONLY_WHILE_CHARGING=0
EOF
fi

if [ ! -f "$ENV_FILE" ]; then
  cat >"$ENV_FILE" <<'EOF'
SERA_API_URL=https://130-61-188-184.sslip.io
SERA_EXTRACTION_NODE_TOKEN=
SERA_NODE_ID=phone
SERA_NODE_PROVIDERS=youtube
SERA_NODE_NETWORK_CLASS=residential
EOF
fi
chmod 600 "$ENV_FILE"

log "Installing the Termux:Boot script"
mkdir -p "$HOME/.termux/boot"
cat >"$HOME/.termux/boot/sera-node" <<EOF
#!/data/data/com.termux/files/usr/bin/sh
# Starts the SERA extraction node when the phone boots. Installed by deploy/node-android/setup.sh.
termux-wake-lock
exec "$DIR/deploy/node-android/run-node.sh" >>"$STATE/supervisor.log" 2>&1
EOF
chmod 700 "$HOME/.termux/boot/sera-node"
chmod 755 "$DIR/deploy/node-android/run-node.sh"

log "Done"
if grep -q '^SERA_EXTRACTION_NODE_TOKEN=$' "$ENV_FILE"; then
  cat <<EOF
One thing left: the token. Open $ENV_FILE
  nano $ENV_FILE
and paste the server's token after SERA_EXTRACTION_NODE_TOKEN= (the same value as on the
laptop). Then start the node:
  $DIR/deploy/node-android/run-node.sh &
EOF
else
  echo "Start the node now with:  $DIR/deploy/node-android/run-node.sh &"
fi
echo "Conditions (Wi-Fi only, charging only): $STATE/node.conf"
