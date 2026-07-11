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
# The installer asks which hostname to serve the game on. On a repeat run it
# offers the previously used hostname as the default. To run non-interactively
# (for example under the curl pipe), set DOMAIN:
#   curl -fsSL .../install.sh | sudo DOMAIN=snek.example.com bash
#
# Re-running is safe. It updates the app in place and preserves highscores.json.

set -euo pipefail

# ---------------------------------------------------------------------------
# Configuration. Override any value by exporting it before running.
# Note: there is deliberately no default hostname. See resolve_domain below.
# ---------------------------------------------------------------------------
REPO_URL="${REPO_URL:-https://github.com/Kinsman4249/simple-multi-snake.git}"
REPO_BRANCH="${REPO_BRANCH:-main}"
APP_DIR="${APP_DIR:-/opt/multisnake}"        # where the app is installed
SERVICE_USER="${SERVICE_USER:-multisnake}"   # unprivileged account the service runs as
NODE_MAJOR="${NODE_MAJOR:-22}"               # Node.js LTS major version to install
STATE_DIR="${STATE_DIR:-/etc/multisnake}"    # holds installer state between runs
STATE_FILE="${STATE_DIR}/last-domain"        # the hostname used on the last run
TEMPLATE_NAME="fillmeout.example.com.conf"   # placeholder vhost shipped in deploy/
TEMPLATE_HOST="fillmeout.example.com"        # placeholder string replaced at install

# ---------------------------------------------------------------------------
# Must run as root: it writes to /opt, /etc/systemd, and /etc/apache2.
# ---------------------------------------------------------------------------
if [ "$(id -u)" -ne 0 ]; then
  echo "ERROR: run this as root (use sudo)." >&2
  exit 1
fi

echo "== simple-multi-snake installer =="

# ---------------------------------------------------------------------------
# Hostname resolution. Order of precedence:
#   1. DOMAIN environment variable, if set (non-interactive path).
#   2. Interactive prompt on the terminal, defaulting to the last used
#      hostname if this installer has been run before.
#   3. If there is no terminal, no DOMAIN, and no saved hostname, stop.
# The chosen hostname is validated and saved for next time near the end.
# ---------------------------------------------------------------------------
LAST_DOMAIN=""
if [ -r "$STATE_FILE" ]; then
  LAST_DOMAIN="$(cat "$STATE_FILE" 2>/dev/null || true)"
fi

valid_hostname() {
  # Letters, digits, dots, and hyphens, must contain at least one dot, and
  # must not start or end with a dot or hyphen.
  printf "%s" "$1" | grep -Eq '^[A-Za-z0-9]([A-Za-z0-9.-]*[A-Za-z0-9])?$' \
    && printf "%s" "$1" | grep -q '\.'
}

resolve_domain() {
  # 1. Explicit DOMAIN wins.
  if [ -n "${DOMAIN:-}" ]; then
    if ! valid_hostname "$DOMAIN"; then
      echo "ERROR: DOMAIN='${DOMAIN}' is not a valid hostname." >&2
      exit 1
    fi
    CHOSEN_DOMAIN="$DOMAIN"
    return
  fi

  # 2. Interactive prompt, if a terminal is attached.
  if [ -r /dev/tty ]; then
    local prompt reply
    if [ -n "$LAST_DOMAIN" ]; then
      prompt="Hostname to serve the game on [${LAST_DOMAIN}]: "
    else
      prompt="Hostname to serve the game on (e.g. snek.example.com): "
    fi
    while :; do
      printf "%s" "$prompt" > /dev/tty
      read -r reply < /dev/tty || reply=""
      # Empty input reuses the saved hostname, when there is one.
      if [ -z "$reply" ] && [ -n "$LAST_DOMAIN" ]; then
        reply="$LAST_DOMAIN"
      fi
      if valid_hostname "$reply"; then
        CHOSEN_DOMAIN="$reply"
        return
      fi
      printf "Please enter a valid hostname (letters, digits, dots, hyphens).\n" > /dev/tty
    done
  fi

  # 3. Nothing to go on.
  echo "ERROR: no hostname provided and no saved hostname to reuse." >&2
  echo "Re-run with DOMAIN set, e.g. sudo DOMAIN=snek.example.com bash install.sh" >&2
  exit 1
}
resolve_domain
VHOST_FILE="${CHOSEN_DOMAIN}.conf"
echo "Using hostname: ${CHOSEN_DOMAIN}"

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
# 8. Apache reverse proxy. Enable modules, generate the vhost from the
#    template by substituting the chosen hostname, test, reload. This ADDS a
#    new vhost only. Existing sites are not touched.
# ---------------------------------------------------------------------------
echo "[8/8] Configuring Apache reverse proxy for ${CHOSEN_DOMAIN}..."
a2enmod proxy proxy_http proxy_wstunnel >/dev/null

# If a previous run used a different hostname, retire that vhost so we do not
# leave an orphaned site enabled alongside the new one.
if [ -n "$LAST_DOMAIN" ] && [ "$LAST_DOMAIN" != "$CHOSEN_DOMAIN" ]; then
  if [ -f "/etc/apache2/sites-enabled/${LAST_DOMAIN}.conf" ]; then
    a2dissite "${LAST_DOMAIN}.conf" >/dev/null || true
  fi
  rm -f "/etc/apache2/sites-available/${LAST_DOMAIN}.conf"
  echo "  Retired previous vhost for ${LAST_DOMAIN}."
fi

# Generate the real vhost from the placeholder template. A hostname cannot
# contain a slash, so a plain sed with / delimiters is safe here.
sed "s/${TEMPLATE_HOST}/${CHOSEN_DOMAIN}/g" "${SRC}/deploy/${TEMPLATE_NAME}" \
  > "/etc/apache2/sites-available/${VHOST_FILE}"
chmod 0644 "/etc/apache2/sites-available/${VHOST_FILE}"
a2ensite "${VHOST_FILE}" >/dev/null
apache2ctl configtest
systemctl reload apache2

# Remember the hostname so the next run can offer it as the default.
mkdir -p "${STATE_DIR}"
printf "%s\n" "${CHOSEN_DOMAIN}" > "${STATE_FILE}"
chmod 0644 "${STATE_FILE}"

# ---------------------------------------------------------------------------
# Remove the temp clone if we created one.
# ---------------------------------------------------------------------------
if [ "${CLEANUP_SRC}" -eq 1 ]; then
  rm -rf "${SRC}"
fi

echo
echo "== Done =="
echo "Service status:  systemctl status multisnake"
echo "The app listens on 127.0.0.1:8080 and Apache proxies ${CHOSEN_DOMAIN} to it."
echo
echo "Manual step still required:"
echo "In Cloudflare, add an A record for the host part of ${CHOSEN_DOMAIN} pointing"
echo "to this server public IP, Proxied (orange cloud). Then open:"
echo "  https://${CHOSEN_DOMAIN}"
