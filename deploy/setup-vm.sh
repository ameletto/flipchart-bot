#!/usr/bin/env bash
#
# Run this ON the VM, once, after cloning flipchart-bot onto it.
# Works on any Debian/Ubuntu box — the same free e2-micro that runs teabot is
# enough, though this one also serves a website.
#
#   git clone https://github.com/ameletto/flipchart-bot.git
#   cd flipchart-bot && cp .env.example .env && nano .env
#   bash deploy/setup-vm.sh
#
# Installs Node 22, adds swap, installs dependencies, builds the whiteboard,
# registers the slash commands, sets the bot up as a systemd service, and
# configures Caddy to terminate TLS in front of it.

set -euo pipefail

APP_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
SERVICE_NAME=flipchart

echo "==> flipchart setup, from ${APP_DIR}"

if [[ ! -f "${APP_DIR}/.env" ]]; then
  echo "ERROR: ${APP_DIR}/.env is missing."
  echo
  echo "Create it on this machine and paste your settings in:"
  echo "    cp .env.example .env && nano .env"
  echo
  echo "You need DISCORD_TOKEN, DISCORD_CLIENT_ID, FLIPCHART_PUBLIC_URL and FLIPCHART_SECRET."
  exit 1
fi

# Pull the domain out of .env so Caddy and the app can't disagree about it.
# \047 and \042 are a single and a double quote, spelled in octal to keep the shell
# quoting here readable.
PUBLIC_URL="$(grep -E '^FLIPCHART_PUBLIC_URL=' "${APP_DIR}/.env" | cut -d= -f2- | tr -d '\047\042 ')"
DOMAIN="$(echo "${PUBLIC_URL}" | sed -E 's#^https?://##; s#/.*$##')"

if [[ -z "${DOMAIN}" ]]; then
  echo "ERROR: FLIPCHART_PUBLIC_URL in .env is empty or malformed."
  echo "It must be the public address people will open, e.g. https://flipchart.example.com"
  exit 1
fi

echo "==> domain: ${DOMAIN}"

# --- swap ------------------------------------------------------------------
# 1 GB of RAM is enough to run this but can OOM while npm builds better-sqlite3's
# native module and while Vite bundles tldraw, which is not a small dependency.
if ! swapon --show | grep -q '/swapfile'; then
  echo "==> creating 2G swapfile"
  sudo fallocate -l 2G /swapfile
  sudo chmod 600 /swapfile
  sudo mkswap /swapfile
  sudo swapon /swapfile
  if ! grep -q '^/swapfile' /etc/fstab; then
    echo '/swapfile none swap sw 0 0' | sudo tee -a /etc/fstab >/dev/null
  fi
else
  echo "==> swapfile already present, skipping"
fi

# --- node ------------------------------------------------------------------
if ! command -v node >/dev/null 2>&1 || [[ "$(node -p 'process.versions.node.split(".")[0]')" -lt 20 ]]; then
  echo "==> installing Node.js 22"
  curl -fsSL https://deb.nodesource.com/setup_22.x | sudo -E bash -
  sudo apt-get install -y nodejs
else
  echo "==> Node $(node -v) already installed, skipping"
fi

# better-sqlite3 ships prebuilt binaries for linux x64 and arm64, but keep a
# toolchain around so it can fall back to compiling if the prebuild misses.
echo "==> ensuring build toolchain (fallback for native modules)"
sudo apt-get install -y --no-install-recommends python3 g++ make

# --- app -------------------------------------------------------------------
# Note: a full `npm ci` here, not `--omit=dev`. The whiteboard front end has to be
# built on this machine, and tldraw, React and Vite are all devDependencies.
echo "==> installing dependencies"
cd "${APP_DIR}"
npm ci

echo "==> building the whiteboard"
npm run build

echo "==> registering slash commands with Discord"
npm run deploy

# --- caddy -----------------------------------------------------------------
# Caddy gets and renews the TLS certificate on its own. Without HTTPS the browser
# refuses the websocket, so the whiteboard simply won't load.
if ! command -v caddy >/dev/null 2>&1; then
  echo "==> installing Caddy"
  sudo apt-get install -y --no-install-recommends debian-keyring debian-archive-keyring apt-transport-https curl
  curl -1sLf 'https://dl.cloudsmith.io/public/caddy/stable/gpg.key' \
    | sudo gpg --batch --yes --dearmor -o /usr/share/keyrings/caddy-stable-archive-keyring.gpg
  curl -1sLf 'https://dl.cloudsmith.io/public/caddy/stable/debian.deb.txt' \
    | sudo tee /etc/apt/sources.list.d/caddy-stable.list >/dev/null
  sudo apt-get update
  sudo apt-get install -y caddy
else
  echo "==> Caddy already installed, skipping"
fi

echo "==> configuring Caddy for ${DOMAIN}"
sed "s|flipchart.example.com|${DOMAIN}|" "${APP_DIR}/deploy/Caddyfile" \
  | sudo tee /etc/caddy/Caddyfile >/dev/null
sudo systemctl restart caddy

# --- service ---------------------------------------------------------------
echo "==> installing systemd service"
sed -e "s|/home/ubuntu/flipchart-bot|${APP_DIR}|g" \
    -e "s|^User=ubuntu$|User=${USER}|" \
    "${APP_DIR}/deploy/flipchart.service" | sudo tee "/etc/systemd/system/${SERVICE_NAME}.service" >/dev/null

sudo systemctl daemon-reload
sudo systemctl enable "${SERVICE_NAME}"
sudo systemctl restart "${SERVICE_NAME}"

sleep 3
echo
echo "==> status"
sudo systemctl --no-pager --full status "${SERVICE_NAME}" || true

cat <<EOF

Done. Two things still have to be true for this to work from the outside:

  1. ${DOMAIN} has an A record pointing at this machine's external IP.
  2. Ports 80 and 443 are open in the cloud firewall. On Google Cloud that is
     VPC network -> Firewall, or tick "Allow HTTP/HTTPS traffic" on the VM.

Check it end to end with:

  curl https://${DOMAIN}/healthz      # should print: ok

Useful commands from here:

  sudo systemctl status flipchart     # is it alive?
  sudo journalctl -u flipchart -f     # follow the logs
  sudo systemctl restart flipchart    # after changing code
  sudo journalctl -u caddy -f         # TLS certificate problems show up here

Back up ${APP_DIR}/data — it holds every flipchart.
EOF
