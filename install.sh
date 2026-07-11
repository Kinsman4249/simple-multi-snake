#!/usr/bin/env bash
#
# install.sh - one-command installer for simple-multi-snake
# Target: Debian with Apache already installed and running.
#
# One-liner (run from anywhere, as root):
#   curl -fsSL https://raw.githubusercontent.com/Kinsman4249/simple-multi-snake/main/install.sh | sudo bash
#
# Or, if you have already cloned the repo, run it from inside the checkout:
#   sudo ./install.sh
#
# Re-running is safe. It updates the app in place and preserves highscores.json.

set -euo pipefail

# ---------------------------------------------------------------------------
# Configuration. Override any value by exporting it before running, e.g.
#   sudo DOMAIN=snek.example.com ./install.sh
# ---------------------------------------------------------------------------
REPO_URL="${REPO_URL:-https://github.com/Kinsman4249/simple-multi-snake.git}"
REPO_BRANCH="${REPO_BRANCH:-main}"
APP_DIR="${APP_DIR:-/opt/multisnake}"        # where the app is installed
SERVICE_USER="${SERVICE_USER:-multisnake}"   # unprivileged account the service runs as
NODE_MAJOR="${NODE_MAJOR:-22}"               # Node.js LTS major version to install
DOMAIN="${DOMAIN:-snek.ethanantonio.com}"    # vhost ServerName and .conf file name
VHOST_FILE="${DOMAIN}.conf"                  # apache sites-available file name

# ---------------------------------------------------------------------------
# Must run as root: it writes to /opt, /etc/systemd, and /etc/apache2.
# ---------------------------------------------------------------------------
if [ "$(id -u)" -ne 0 ]; then
  echo "ERROR: run this as root (use sudo)." >&2
  exit 1
fi

echo "== simple-multi-snake installer =="

# ---------------------------------------------------------------------------
# 1. Base tools. curl and git are needed to fetch Node and the repo.
# ---------------------------------------------------------------------------
echo "[1/8] Installing base packages (curl, git, ca-certificates)..."
apt-get update -y
apt-get install -y curl git ca-certificates

# ---------------------------------------------------------------------------
# 2. Node.js. Install the requested LTS only if a good-enough node is missing,
#    so we do not clobber an existing newer install.
# ---------------------------------------------------------------------------
NEED_NODE=1
if command -v node >/dev/null 2>&1; then
  CURRENT_MAJOR="$(node -v | sed 's/^v\([0-9]*\).*/\1/')"
  if [ "$CURRENT_MAJOR" -ge "$NODE_MAJOR" ]; then
    NEED_NODE=0
    echo "[2/8] Node $(node -v) already present, skipping install."
  fi
fi
if [ "$NEED_NODE" -eq 1 ]; then
  echo "[2/8] Installing Node.js ${NODE_MAJOR}.x from NodeSource..."
  curl -fsSL "https://deb.nodesource.com/setup_${NODE_MAJOR}.x" | bash -
  apt-get install -y nodejs
fi
node --version

# ---------------------------------------------------------------------------
# 3. Get the source. If run from inside a checkout, use it. Otherwise clone
#    to a temp dir. The curl | bash one-liner always takes the clone path.
# ---------------------------------------------------------------------------
CLEANUP_SRC=0
if [ -f "./server.js" ] && [ -f "./deploy/multisnake.service" ]; then
  SRC="$(pwd)"
  echo "[3/8] Using local checkout at ${SRC}."
else
  SRC="$(mktemp -d)"
  CLEANUP_SRC=1
  echo "[3/8] Cloning ${REPO_URL} (branch ${REPO_BRANCH})..."
  git clone --depth 1 --branch "${REPO_BRANCH}" "${REPO_URL}" "${SRC}"
fi

# ---------------------------------------------------------------------------
# 4. Lay the app down in APP_DIR. An existing highscores.json is left in place.
# ---------------------------------------------------------------------------
echo "[4/8] Installing app files to ${APP_DIR}..."
mkdir -p "${APP_DIR}/public"
install -m 0644 "${SRC}/server.js"         "${APP_DIR}/server.js"
install -m 0644 "${SRC}/config.json"       "${APP_DIR}/config.json"
install -m 0644 "${SRC}/package.json"      "${APP_DIR}/package.json"
install -m 0644 "${SRC}/public/index.html" "${APP_DIR}/public/index.html"

# ---------------------------------------------------------------------------
# 5. Install production npm deps (ws) inside APP_DIR.
# ---------------------------------------------------------------------------
echo "[5/8] Installing npm dependencies..."
( cd "${APP_DIR}" && npm install --omit=dev --no-audit --no-fund )

# ---------------------------------------------------------------------------
# 6. Service account and ownership. System user, no login shell, no home.
# ---------------------------------------------------------------------------
echo "[6/8] Creating service user '${SERVICE_USER}' and setting ownership..."
if ! id "${SERVICE_USER}" >/dev/null 2>&1; then
  useradd --system --no-create-home --shell /usr/sbin/nologin "${SERVICE_USER}"
fi
chown -R "${SERVICE_USER}:${SERVICE_USER}" "${APP_DIR}"

# ---------------------------------------------------------------------------
# 7. systemd service. Copy unit, reload, enable on boot, (re)start now.
# ---------------------------------------------------------------------------
echo "[7/8] Installing and starting the systemd service..."
install -m 0644 "${SRC}/deploy/multisnake.service" /etc/systemd/system/multisnake.service
systemctl daemon-reload
systemctl enable multisnake
systemctl restart multisnake

# ---------------------------------------------------------------------------
# 8. Apache reverse proxy. Enable modules, drop in the vhost, test, reload.
#    This ADDS a new vhost only. Existing sites are not touched.
# ---------------------------------------------------------------------------
echo "[8/8] Configuring Apache reverse proxy for ${DOMAIN}..."
a2enmod proxy proxy_http proxy_wstunnel >/dev/null
install -m 0644 "${SRC}/deploy/${VHOST_FILE}" "/etc/apache2/sites-available/${VHOST_FILE}"
a2ensite "${VHOST_FILE}" >/dev/null
apache2ctl configtest
systemctl reload apache2

# ---------------------------------------------------------------------------
# Remove the temp clone if we created one.
# ---------------------------------------------------------------------------
if [ "${CLEANUP_SRC}" -eq 1 ]; then
  rm -rf "${SRC}"
fi

echo
echo "== Done =="
echo "Service status:  systemctl status multisnake"
echo "The app listens on 127.0.0.1:8080 and Apache proxies ${DOMAIN} to it."
echo
echo "Manual step still required:"
echo "In Cloudflare, add an A record for the host part of ${DOMAIN} pointing"
echo "to this server public IP, Proxied (orange cloud). Then open:"
echo "  https://${DOMAIN}"
