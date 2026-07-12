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
#   curl -fsSL .../install.sh | sudo DOMAIN=snek.example.com CF_API_TOKEN=xxxx bash
#
# Port: the app binds a loopback TCP port that Apache proxies to. The default
# is 8080, but if that port is already in use (common on a host that already
# runs other services) the installer automatically selects the next free port
# and points server.js and the vhosts at it. Force a specific port with PORT.
# The chosen port is saved and reused on later runs. A previous install that
# crash-looped on a port clash is detected and offered an automatic fix.
#
# TLS: by default the installer obtains a Let's Encrypt certificate using the
# DNS-01 challenge via the Cloudflare API, then lets the Apache plugin install
# the certificate and serve the game on 443. DNS-01 needs no inbound port 80,
# so the DNS record can stay proxied through Cloudflare (orange cloud). It
# requires a Cloudflare API token with Zone:DNS:Edit on the zone. Provide it as
# CF_API_TOKEN, or the installer prompts for it. Set ENABLE_TLS=no to skip TLS
# entirely (for example if you use a Cloudflare Origin Certificate instead).
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
PORT_FILE="${STATE_DIR}/last-port"           # the port used on the last run
EMAIL_FILE="${STATE_DIR}/last-email"         # the Let's Encrypt notice email used on the last run
PREFERRED_PORT="${PORT:-}"                   # optional explicit port override
DEFAULT_PORT=8080                            # starting point for the free-port scan
TEMPLATE_NAME="fillmeout.example.com.conf"   # placeholder vhost shipped in deploy/
TEMPLATE_HOST="fillmeout.example.com"        # placeholder string replaced at install
TEMPLATE_PORT="8080"                         # placeholder port in the vhost template
ENABLE_TLS="${ENABLE_TLS:-yes}"              # set to "no" to skip certbot / 443
CERTBOT_EMAIL="${CERTBOT_EMAIL:-}"           # optional; blank registers without email
CF_API_TOKEN="${CF_API_TOKEN:-}"             # Cloudflare token, Zone:DNS:Edit scope
CF_PROPAGATION="${CF_PROPAGATION:-30}"       # seconds to wait for DNS propagation

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
LAST_EMAIL=""
if [ -r "$EMAIL_FILE" ]; then
  LAST_EMAIL="$(cat "$EMAIL_FILE" 2>/dev/null || true)"
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
LE_SSL_FILE="/etc/apache2/sites-available/${CHOSEN_DOMAIN}-le-ssl.conf"
CF_CREDS_FILE="/etc/letsencrypt/cloudflare-${CHOSEN_DOMAIN}.ini"
echo "Using hostname: ${CHOSEN_DOMAIN}"

# ---------------------------------------------------------------------------
# Old-install / alt-port-config check.
#
# The "retire the previous hostname's vhost" step further down only knows
# about ONE previous hostname (whatever is in last-domain), so it misses
# vhosts that predate the installer being used at all, or that were left
# behind by hand-editing outside of it. This scans every enabled Apache site
# for the distinctive "/ws" WebSocket ProxyPass line our own template writes,
# which is specific enough that an unrelated vhost is very unlikely to match
# it, and reports any such vhost that is not the one we are about to manage
# for CHOSEN_DOMAIN. This is where a stale hostname pointed at a now-dead
# port would show up (an "alt port config"), since nothing is listening
# there once the app has moved to a different port.
# ---------------------------------------------------------------------------
detect_stale_vhosts() {
  local sites_dir="/etc/apache2/sites-available"
  [ -d "$sites_dir" ] || return 0

  local found=0
  local f host port listening
  for f in "$sites_dir"/*.conf; do
    [ -f "$f" ] || continue
    case "$(basename "$f")" in
      "$VHOST_FILE"|"${CHOSEN_DOMAIN}-le-ssl.conf") continue ;;
    esac
    # Our template's signature line, tolerant of the port having been edited.
    port="$(grep -oE 'ProxyPass[[:space:]]+/ws[[:space:]]+ws://127\.0\.0\.1:[0-9]+/ws' "$f" \
      | grep -oE '[0-9]+' | head -n1 || true)"
    [ -n "$port" ] || continue
    host="$(grep -oE 'ServerName[[:space:]]+\S+' "$f" | awk '{print $2}' | head -n1 || true)"
    if [ "$found" -eq 0 ]; then
      echo
      echo "NOTICE: found other multisnake-managed Apache site(s):"
      found=1
    fi
    if port_is_free "$port"; then
      listening="nothing listening on ${port}, this vhost is dead"
    else
      listening="something is listening on ${port}"
    fi
    echo "  ${f} -> host ${host:-unknown}, port ${port} (${listening})"
  done
  [ "$found" -eq 1 ] || return 0

  echo "These are left alone by default since they may be a separate,"
  echo "intentionally-running instance on another hostname/port."
  if [ -r /dev/tty ]; then
    printf "Disable and remove the dead ones listed above? [y/N]: " > /dev/tty
    local ans
    read -r ans < /dev/tty || ans=""
    case "$ans" in
      [Yy]*)
        for f in "$sites_dir"/*.conf; do
          [ -f "$f" ] || continue
          case "$(basename "$f")" in
            "$VHOST_FILE"|"${CHOSEN_DOMAIN}-le-ssl.conf") continue ;;
          esac
          port="$(grep -oE 'ProxyPass[[:space:]]+/ws[[:space:]]+ws://127\.0\.0\.1:[0-9]+/ws' "$f" \
            | grep -oE '[0-9]+' | head -n1 || true)"
          [ -n "$port" ] || continue
          if port_is_free "$port"; then
            local base; base="$(basename "$f")"
            [ -f "/etc/apache2/sites-enabled/${base}" ] && a2dissite "${base}" >/dev/null || true
            rm -f "$f"
            echo "  Removed ${f}."
          fi
        done
        systemctl reload apache2 || true
        ;;
    esac
  fi
}

# ---------------------------------------------------------------------------
# Port helpers and selection.
#
# port_is_free: true when nothing is listening on the given TCP port. It looks
# at every listening socket regardless of bind address, which is deliberately
# conservative: if any process holds the port on any interface, we avoid it.
#
# detect_prior_failure (recovery catch): if an earlier install left the service
# crash-looping (classically EADDRINUSE from a port already in use), this makes
# that visible and, when interactive, asks before applying the fix. It is
# distinct from the proactive selection below, whose whole job is to prevent
# the clash in the first place. This path exists because a prior run may have
# already written a bad port into server.js and the vhosts, then reported
# success while the service quietly failed, producing a confusing 404.
#
# resolve_port (initial catch): stop our own service so it releases any port it
# holds, then choose a port: the PORT override, else the last saved port, else
# the default, scanning upward until a free port is found.
# ---------------------------------------------------------------------------
port_is_free() {
  local p="$1"
  if ss -ltnH 2>/dev/null | awk '{print $4}' | sed 's/.*://' | grep -qx "$p"; then
    return 1
  fi
  return 0
}

detect_prior_failure() {
  # Only relevant if a prior install exists on this host.
  [ -f /etc/systemd/system/multisnake.service ] || return 0

  local failed=0
  if systemctl is-failed --quiet multisnake 2>/dev/null; then
    failed=1
  elif journalctl -u multisnake -n 50 --no-pager 2>/dev/null | grep -q 'EADDRINUSE'; then
    failed=1
  fi
  [ "$failed" -eq 1 ] || return 0

  # Work out which port the failed install was trying to use.
  local prior_port=""
  if [ -r "${APP_DIR}/server.js" ]; then
    prior_port="$(grep -oE 'const PORT = [0-9]+' "${APP_DIR}/server.js" | grep -oE '[0-9]+' | head -n1 || true)"
  fi
  if [ -z "$prior_port" ] && [ -r "$PORT_FILE" ]; then
    prior_port="$(cat "$PORT_FILE" 2>/dev/null || true)"
  fi

  echo
  echo "NOTICE: a previous multisnake install is present but its service is failing."
  if [ -n "$prior_port" ]; then
    local holder
    holder="$(ss -ltnpH 2>/dev/null | awk -v pat=":${prior_port}\$" '$4 ~ pat {print $NF}' | head -n1)"
    echo "Port ${prior_port} appears to have been in use already (EADDRINUSE), so the"
    echo "game never came up. Requests then return 404 from whatever else owns that"
    echo "port. This is almost certainly why the site shows 404 after the cert step."
    if [ -n "$holder" ]; then
      echo "Current listener on port ${prior_port}: ${holder}"
    fi
  fi
  echo "This run will select a free port and re-point the app and the Apache vhosts"
  echo "(including the certbot SSL vhost) to fix it."

  if [ -r /dev/tty ]; then
    printf "Proceed with the automatic port fix? [Y/n]: " > /dev/tty
    local ans
    read -r ans < /dev/tty || ans=""
    case "$ans" in
      [Nn]*)
        echo "Stopping at your request. No changes were made this run." >&2
        exit 1
        ;;
    esac
  fi
}

resolve_port() {
  # Release our own port first so a re-run does not treat it as a conflict.
  systemctl stop multisnake >/dev/null 2>&1 || true

  local preferred=""
  if [ -n "$PREFERRED_PORT" ]; then
    preferred="$PREFERRED_PORT"
  elif [ -r "$PORT_FILE" ]; then
    preferred="$(cat "$PORT_FILE" 2>/dev/null || true)"
  fi
  case "$preferred" in
    ''|*[!0-9]*) preferred="$DEFAULT_PORT" ;;
  esac
  if [ "$preferred" -lt 1 ] || [ "$preferred" -gt 65535 ]; then
    preferred="$DEFAULT_PORT"
  fi

  local p="$preferred" tries=0
  while ! port_is_free "$p"; do
    p=$((p + 1))
    tries=$((tries + 1))
    if [ "$p" -gt 65535 ]; then p=1025; fi
    if [ "$tries" -gt 500 ]; then
      echo "ERROR: could not find a free TCP port to bind to." >&2
      exit 1
    fi
  done
  CHOSEN_PORT="$p"
  if [ "$CHOSEN_PORT" != "$preferred" ]; then
    echo "Port ${preferred} is in use; the app will use ${CHOSEN_PORT} instead."
  else
    echo "Using port ${CHOSEN_PORT} for the app."
  fi
}

detect_stale_vhosts
detect_prior_failure
resolve_port

# ---------------------------------------------------------------------------
# TLS inputs (only when ENABLE_TLS=yes).
#   Email: CERTBOT_EMAIL wins; else optional prompt; blank registers without.
#   Cloudflare token: CF_API_TOKEN wins; else reuse an existing creds file if
#   one is already on disk from a previous run; else prompt (hidden). Without a
#   token and without an existing creds file, DNS-01 cannot proceed.
# ---------------------------------------------------------------------------
resolve_tls_inputs() {
  if [ "$ENABLE_TLS" != "yes" ]; then
    return
  fi

  # Email. Reused across runs the same way the hostname is: an explicit
  # CERTBOT_EMAIL always wins, otherwise the prompt offers the last saved
  # address as its default and an empty reply reuses it. This is the email
  # Let's Encrypt (and, if you provide one, Cloudflare renewal-related mail)
  # sends certificate expiry / renewal notices to, so it is worth persisting
  # rather than re-typing on every re-run.
  if [ -z "$CERTBOT_EMAIL" ] && [ -r /dev/tty ]; then
    if [ -n "$LAST_EMAIL" ]; then
      printf "Email for Let's Encrypt renewal notices [%s]: " "$LAST_EMAIL" > /dev/tty
    else
      printf "Email for Let's Encrypt renewal notices (blank to skip): " > /dev/tty
    fi
    read -r CERTBOT_EMAIL < /dev/tty || CERTBOT_EMAIL=""
    if [ -z "$CERTBOT_EMAIL" ] && [ -n "$LAST_EMAIL" ]; then
      CERTBOT_EMAIL="$LAST_EMAIL"
    fi
  fi

  # Cloudflare token
  if [ -n "$CF_API_TOKEN" ]; then
    return
  fi
  if [ -r "$CF_CREDS_FILE" ]; then
    echo "  Reusing existing Cloudflare credentials at ${CF_CREDS_FILE}."
    return
  fi
  if [ -r /dev/tty ]; then
    printf "Cloudflare API token (Zone:DNS:Edit), input hidden: " > /dev/tty
    read -rs CF_API_TOKEN < /dev/tty || CF_API_TOKEN=""
    printf "\n" > /dev/tty
  fi
  if [ -z "$CF_API_TOKEN" ]; then
    echo "ERROR: TLS is enabled but no Cloudflare API token was provided and no" >&2
    echo "existing credentials file was found at ${CF_CREDS_FILE}." >&2
    echo "Provide CF_API_TOKEN, or set ENABLE_TLS=no to skip TLS." >&2
    exit 1
  fi
}
resolve_tls_inputs

# ---------------------------------------------------------------------------
# 1. Base tools. curl and git are needed to fetch Node and the repo.
# ---------------------------------------------------------------------------
echo "[1/9] Installing base packages (curl, git, ca-certificates)..."
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
    echo "[2/9] Node $(node -v) already present, skipping install."
  fi
fi
if [ "$NEED_NODE" -eq 1 ]; then
  echo "[2/9] Installing Node.js ${NODE_MAJOR}.x from NodeSource..."
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
  echo "[3/9] Using local checkout at ${SRC}."
else
  SRC="$(mktemp -d)"
  CLEANUP_SRC=1
  echo "[3/9] Cloning ${REPO_URL} (branch ${REPO_BRANCH})..."
  git clone --depth 1 --branch "${REPO_BRANCH}" "${REPO_URL}" "${SRC}"
fi

# ---------------------------------------------------------------------------
# 4. Lay the app down in APP_DIR, then patch the port into server.js. An
#    existing highscores.json is left in place.
# ---------------------------------------------------------------------------
echo "[4/9] Installing app files to ${APP_DIR}..."
mkdir -p "${APP_DIR}/public"
install -m 0644 "${SRC}/server.js"    "${APP_DIR}/server.js"
install -m 0644 "${SRC}/config.json"  "${APP_DIR}/config.json"
install -m 0644 "${SRC}/package.json" "${APP_DIR}/package.json"

# Every file under public/ (index.html, public/js/*.js, and anything added
# later) is synced by walking the tree rather than naming files one at a
# time. Naming them individually is exactly how public/js/*.js ended up
# missing from a real deploy: the client was split into net.js, predict.js,
# render.js, ui.js, and main.js, and this step was never updated to know
# about the new directory, so the server 404'd on all of them. Walking the
# tree means a future new client file deploys automatically.
find "${SRC}/public" -type f -print0 | while IFS= read -r -d '' f; do
  rel="${f#"${SRC}"/public/}"
  dest="${APP_DIR}/public/${rel}"
  mkdir -p "$(dirname "$dest")"
  install -m 0644 "$f" "$dest"
done

# Remove anything under APP_DIR/public that no longer exists in the source
# tree, so a renamed or deleted client file does not linger as dead weight
# (or, worse, a stale version of itself) after an update.
find "${APP_DIR}/public" -type f -print0 2>/dev/null | while IFS= read -r -d '' f; do
  rel="${f#"${APP_DIR}"/public/}"
  [ -f "${SRC}/public/${rel}" ] || { rm -f "$f"; echo "  Removed stale ${rel} (no longer shipped)."; }
done

# server.js ships with a default of 8080; set it to the chosen port.
sed -i "s/const PORT = [0-9]\+;/const PORT = ${CHOSEN_PORT};/" "${APP_DIR}/server.js"

# ---------------------------------------------------------------------------
# 5. Install production npm deps (ws) inside APP_DIR.
# ---------------------------------------------------------------------------
echo "[5/9] Installing npm dependencies..."
( cd "${APP_DIR}" && npm install --omit=dev --no-audit --no-fund )

# ---------------------------------------------------------------------------
# 6. Service account and ownership. System user, no login shell, no home.
# ---------------------------------------------------------------------------
echo "[6/9] Creating service user '${SERVICE_USER}' and setting ownership..."
if ! id "${SERVICE_USER}" >/dev/null 2>&1; then
  useradd --system --no-create-home --shell /usr/sbin/nologin "${SERVICE_USER}"
fi
chown -R "${SERVICE_USER}:${SERVICE_USER}" "${APP_DIR}"

# ---------------------------------------------------------------------------
# 7. systemd service. Copy unit, reload, enable on boot, start now, then verify
#    the app actually answers on its port. The verification is the catch: with
#    Type=simple systemd reports the unit started the moment it forks, so a
#    crash right after (for example a port clash) would otherwise go unnoticed
#    and later show up only as a 404 through Apache. Failing here is loud and
#    early, with the relevant logs.
# ---------------------------------------------------------------------------
echo "[7/9] Installing and starting the systemd service..."
install -m 0644 "${SRC}/deploy/multisnake.service" /etc/systemd/system/multisnake.service
systemctl daemon-reload
systemctl enable multisnake
systemctl restart multisnake

sleep 1
if ! curl -fsS "http://127.0.0.1:${CHOSEN_PORT}/" -o /dev/null 2>/dev/null; then
  echo "ERROR: multisnake did not come up on 127.0.0.1:${CHOSEN_PORT}." >&2
  echo "This usually means the port is held by another process or the app" >&2
  echo "failed to start. Recent service logs:" >&2
  journalctl -u multisnake -n 20 --no-pager >&2 || true
  exit 1
fi
echo "  App is responding on 127.0.0.1:${CHOSEN_PORT}."

# index.html alone answering 200 does not prove the client's JS modules made
# it onto disk (this is exactly how the public/js/*.js 404s happened: the
# process was up and / worked fine, so the old check here passed while the
# game was still broken in every browser). Check every static file the
# shipped index.html actually references, straight out of that file, so this
# check stays correct even as more client files get added in later phases.
echo "  Verifying static client assets referenced by index.html..."
ASSET_FAIL=0
while IFS= read -r asset; do
  [ -n "$asset" ] || continue
  if ! curl -fsS "http://127.0.0.1:${CHOSEN_PORT}/${asset}" -o /dev/null 2>/dev/null; then
    echo "ERROR: ${asset} did not load (404 or connection error)." >&2
    ASSET_FAIL=1
  fi
done < <(grep -oE '(src|href)="[^"]+\.(js|css)"' "${APP_DIR}/public/index.html" \
           | sed -E 's/^(src|href)="//; s/"$//')
if [ "$ASSET_FAIL" -eq 1 ]; then
  echo "ERROR: one or more static assets referenced by index.html are missing" >&2
  echo "on disk under ${APP_DIR}/public/. The service process is up, but the" >&2
  echo "site would be broken in a browser. Check that the source checkout" >&2
  echo "actually contains those files under public/." >&2
  exit 1
fi
echo "  All static client assets present and served correctly."

# ---------------------------------------------------------------------------
# 8. Apache reverse proxy. Enable modules, generate the vhost from the
#    template by substituting the chosen hostname and port, test, reload. This
#    ADDS a new vhost only. Existing sites are not touched.
# ---------------------------------------------------------------------------
echo "[8/9] Configuring Apache reverse proxy for ${CHOSEN_DOMAIN}..."
a2enmod proxy proxy_http proxy_wstunnel >/dev/null

# If a previous run used a different hostname, retire that vhost so we do not
# leave an orphaned site enabled alongside the new one.
if [ -n "$LAST_DOMAIN" ] && [ "$LAST_DOMAIN" != "$CHOSEN_DOMAIN" ]; then
  for old in "${LAST_DOMAIN}.conf" "${LAST_DOMAIN}-le-ssl.conf"; do
    if [ -f "/etc/apache2/sites-enabled/${old}" ]; then
      a2dissite "${old}" >/dev/null || true
    fi
    rm -f "/etc/apache2/sites-available/${old}"
  done
  echo "  Retired previous vhost for ${LAST_DOMAIN}."
fi

# Generate the real vhost from the placeholder template, substituting both the
# hostname and the port. Neither contains a slash, so sed with # delimiters is
# safe.
sed -e "s#${TEMPLATE_HOST}#${CHOSEN_DOMAIN}#g" \
    -e "s#127\.0\.0\.1:${TEMPLATE_PORT}#127.0.0.1:${CHOSEN_PORT}#g" \
    "${SRC}/deploy/${TEMPLATE_NAME}" > "/etc/apache2/sites-available/${VHOST_FILE}"
chmod 0644 "/etc/apache2/sites-available/${VHOST_FILE}"
a2ensite "${VHOST_FILE}" >/dev/null

# On a re-run the certbot SSL vhost already exists and certbot will not rewrite
# it when the certificate is reused, so re-point its proxy port here as well.
if [ -f "$LE_SSL_FILE" ]; then
  sed -i "s#127\.0\.0\.1:[0-9]\+#127.0.0.1:${CHOSEN_PORT}#g" "$LE_SSL_FILE"
  echo "  Re-pointed existing SSL vhost to port ${CHOSEN_PORT}."
fi

apache2ctl configtest
systemctl reload apache2

# ---------------------------------------------------------------------------
# 9. TLS via certbot using the DNS-01 challenge (Cloudflare), with the Apache
#    installer writing the :443 vhost and the 80->443 redirect.
#    Guardrails:
#      - certbot and the two plugins are installed only if certbot is not
#        already present, so an existing certbot and its renewal schedule are
#        left alone. We never edit certbot.timer or /etc/cron.d/certbot;
#        installing the Debian package already provides a twice-daily renewal
#        timer covering every cert in /etc/letsencrypt/renewal/, including this
#        one. Renewal reuses the saved DNS-01 method, so no port 80 is needed.
#      - If a certificate for this hostname already exists,
#        --keep-until-expiring reuses it instead of requesting a new one.
#      - DNS-01 needs no inbound port 80, so the record can stay proxied
#        through Cloudflare (orange cloud).
#    Skip this whole step with ENABLE_TLS=no.
# ---------------------------------------------------------------------------
if [ "$ENABLE_TLS" = "yes" ]; then
  echo "[9/9] Setting up TLS for ${CHOSEN_DOMAIN} (Let's Encrypt, DNS-01 via Cloudflare)..."

  if ! command -v certbot >/dev/null 2>&1; then
    echo "  Installing certbot, the Apache installer, and the Cloudflare DNS plugin..."
    apt-get install -y certbot python3-certbot-apache python3-certbot-dns-cloudflare
  else
    echo "  certbot already present ($(certbot --version 2>/dev/null || echo unknown)); reusing it."
    # Ensure the plugins we rely on are present without reinstalling certbot.
    apt-get install -y python3-certbot-apache python3-certbot-dns-cloudflare || true
  fi

  # Make sure the renewal timer is active without altering its schedule. This
  # is a no-op if it is already enabled, and it does not touch any override.
  if systemctl list-unit-files 2>/dev/null | grep -q '^certbot.timer'; then
    systemctl enable --now certbot.timer >/dev/null 2>&1 || true
  fi

  # Write the Cloudflare credentials file if we were given a token. If we are
  # reusing an existing file, leave it as-is. Certbot records this path for
  # renewal but does not copy the contents, so the file must persist.
  if [ -n "$CF_API_TOKEN" ]; then
    mkdir -p /etc/letsencrypt
    umask 077
    printf "# Cloudflare API token used by Certbot for DNS-01\ndns_cloudflare_api_token = %s\n" \
      "$CF_API_TOKEN" > "$CF_CREDS_FILE"
    chmod 600 "$CF_CREDS_FILE"
  fi

  # Build the email argument: a real address if provided, otherwise register
  # without one (certbot requires an explicit choice in non-interactive mode).
  if [ -n "$CERTBOT_EMAIL" ]; then
    EMAIL_ARG=( -m "$CERTBOT_EMAIL" )
  else
    EMAIL_ARG=( --register-unsafely-without-email )
  fi

  # DNS-01 authenticator with the Apache installer. The authenticator creates
  # the _acme-challenge TXT record via the Cloudflare API; the installer writes
  # the :443 vhost and redirect. --key-type ecdsa keeps modern defaults.
  certbot --authenticator dns-cloudflare --installer apache \
    --dns-cloudflare-credentials "$CF_CREDS_FILE" \
    --dns-cloudflare-propagation-seconds "$CF_PROPAGATION" \
    -d "$CHOSEN_DOMAIN" \
    --non-interactive --agree-tos \
    --keep-until-expiring \
    --redirect \
    --key-type ecdsa \
    "${EMAIL_ARG[@]}"

  # certbot may have (re)written the SSL vhost; make sure its proxy port is
  # correct, then test and reload.
  if [ -f "$LE_SSL_FILE" ]; then
    sed -i "s#127\.0\.0\.1:[0-9]\+#127.0.0.1:${CHOSEN_PORT}#g" "$LE_SSL_FILE"
  fi
  apache2ctl configtest
  systemctl reload apache2
  echo "  TLS is configured. The game is served on https://${CHOSEN_DOMAIN}"
else
  echo "[9/9] ENABLE_TLS=no, skipping certbot. Serving plain HTTP on port 80."
fi

# Remember the hostname, port, and (if TLS is on) the renewal-notice email so
# the next run can offer/reuse them. The email file is 0600 since an email
# address is mildly sensitive; the domain and port files stay world-readable
# as before.
mkdir -p "${STATE_DIR}"
printf "%s\n" "${CHOSEN_DOMAIN}" > "${STATE_FILE}"
printf "%s\n" "${CHOSEN_PORT}" > "${PORT_FILE}"
chmod 0644 "${STATE_FILE}" "${PORT_FILE}"
if [ "$ENABLE_TLS" = "yes" ] && [ -n "$CERTBOT_EMAIL" ]; then
  umask 077
  printf "%s\n" "${CERTBOT_EMAIL}" > "${EMAIL_FILE}"
  chmod 0600 "${EMAIL_FILE}"
fi

# ---------------------------------------------------------------------------
# Remove the temp clone if we created one.
# ---------------------------------------------------------------------------
if [ "${CLEANUP_SRC}" -eq 1 ]; then
  rm -rf "${SRC}"
fi

echo
echo "== Done =="
echo "Service status:  systemctl status multisnake"
echo "The app listens on 127.0.0.1:${CHOSEN_PORT} and Apache proxies ${CHOSEN_DOMAIN} to it."
echo
echo "DNS / Cloudflare notes:"
echo "- Point an A record for ${CHOSEN_DOMAIN} at this server public IP."
if [ "$ENABLE_TLS" = "yes" ]; then
  echo "- TLS uses the DNS-01 challenge over the Cloudflare API, so no inbound"
  echo "  port 80 is needed. The record can stay Proxied (orange cloud)."
  echo "- Port 443 must be reachable for players to connect."
  echo "- The Cloudflare token is stored at ${CF_CREDS_FILE} (chmod 600) and is"
  echo "  reused automatically at each renewal."
  if [ -n "$CERTBOT_EMAIL" ]; then
    echo "- Renewal notices go to ${CERTBOT_EMAIL} (saved at ${EMAIL_FILE},"
    echo "  chmod 600, offered as the default on future runs)."
  fi
  echo "- Open: https://${CHOSEN_DOMAIN}"
else
  echo "- TLS was skipped. If fronting with Cloudflare, terminate TLS there and"
  echo "  keep the record Proxied (orange cloud)."
  echo "- Open: http://${CHOSEN_DOMAIN}"
fi
