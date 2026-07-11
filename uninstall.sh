#!/usr/bin/env bash
#
# uninstall.sh - removes what install.sh set up for simple-multi-snake.
#
# One-liner (as root):
#   curl -fsSL https://raw.githubusercontent.com/Kinsman4249/simple-multi-snake/main/uninstall.sh | sudo bash
#
# To also remove the service account:
#   curl -fsSL .../uninstall.sh | sudo bash -s -- --purge
#
# From a local checkout:
#   sudo ./uninstall.sh            # remove app, service, vhost, cert; keep the service user
#   sudo ./uninstall.sh --purge    # also remove the service user
#
# The hostname is read from the installer state file so this works no matter
# which domain was chosen. High scores are backed up to /root before removal.
# The Let's Encrypt cert for this hostname and its Cloudflare credentials file
# are deleted, but the global certbot renewal timer and any other certs are
# left untouched. Set REMOVE_CERT=no to keep the certificate and credentials.

set -euo pipefail

APP_DIR="${APP_DIR:-/opt/multisnake}"
SERVICE_USER="${SERVICE_USER:-multisnake}"
STATE_DIR="${STATE_DIR:-/etc/multisnake}"
STATE_FILE="${STATE_DIR}/last-domain"
REMOVE_CERT="${REMOVE_CERT:-yes}"
PURGE=0
[ "${1:-}" = "--purge" ] && PURGE=1

if [ "$(id -u)" -ne 0 ]; then
  echo "ERROR: run this as root (use sudo)." >&2
  exit 1
fi

echo "== simple-multi-snake uninstaller =="

# Determine which hostname was installed. DOMAIN overrides; otherwise use the
# saved state file. If neither is available we can still remove the app and
# service, but we cannot know which vhost/cert to remove.
DOMAIN_TO_REMOVE="${DOMAIN:-}"
if [ -z "$DOMAIN_TO_REMOVE" ] && [ -r "$STATE_FILE" ]; then
  DOMAIN_TO_REMOVE="$(cat "$STATE_FILE" 2>/dev/null || true)"
fi

# 1. Stop and remove the systemd service.
echo "[1/6] Stopping and removing the systemd service..."
if systemctl list-unit-files | grep -q '^multisnake.service'; then
  systemctl disable --now multisnake || true
fi
rm -f /etc/systemd/system/multisnake.service
systemctl daemon-reload

# 2. Remove the Apache vhost(s). The Apache installer creates a second file
#    with the -le-ssl suffix for the :443 vhost, so remove both. Proxy modules
#    are left enabled since other sites on this server may rely on them.
echo "[2/6] Removing the Apache vhost..."
if [ -n "$DOMAIN_TO_REMOVE" ]; then
  for conf in "${DOMAIN_TO_REMOVE}.conf" "${DOMAIN_TO_REMOVE}-le-ssl.conf"; do
    if [ -f "/etc/apache2/sites-enabled/${conf}" ]; then
      a2dissite "${conf}" >/dev/null || true
    fi
    rm -f "/etc/apache2/sites-available/${conf}"
  done
  apache2ctl configtest && systemctl reload apache2 || true
else
  echo "  No hostname found in ${STATE_FILE} and DOMAIN not set; skipping vhost removal."
fi

# 3. Remove the Let's Encrypt certificate and Cloudflare credentials for this
#    hostname only. This does not affect other certs or the shared renewal
#    timer.
echo "[3/6] Removing the TLS certificate and credentials for this hostname..."
if [ "$REMOVE_CERT" = "yes" ] && [ -n "$DOMAIN_TO_REMOVE" ]; then
  if command -v certbot >/dev/null 2>&1 && [ -d "/etc/letsencrypt/live/${DOMAIN_TO_REMOVE}" ]; then
    certbot delete --cert-name "${DOMAIN_TO_REMOVE}" --non-interactive || true
    echo "  Deleted certificate ${DOMAIN_TO_REMOVE}."
  else
    echo "  No certificate found for ${DOMAIN_TO_REMOVE}, nothing to delete."
  fi
  rm -f "/etc/letsencrypt/cloudflare-${DOMAIN_TO_REMOVE}.ini"
else
  echo "  Skipping certificate removal (REMOVE_CERT=${REMOVE_CERT})."
fi

# 4. Back up the high score file if it exists.
echo "[4/6] Backing up high scores if present..."
if [ -f "${APP_DIR}/highscores.json" ]; then
  BACKUP="/root/multisnake-highscores-$(date +%Y%m%d-%H%M%S).json"
  cp "${APP_DIR}/highscores.json" "${BACKUP}"
  echo "  Saved ${BACKUP}"
fi

# 5. Remove the app directory and the installer state.
echo "[5/6] Removing application files and installer state..."
rm -rf "${APP_DIR}"
rm -rf "${STATE_DIR}"

# 6. Optionally remove the service user.
echo "[6/6] Service user cleanup..."
if [ "${PURGE}" -eq 1 ]; then
  if id "${SERVICE_USER}" >/dev/null 2>&1; then
    userdel "${SERVICE_USER}" || true
    echo "  Removed service user ${SERVICE_USER}."
  fi
else
  echo "  Kept service user '${SERVICE_USER}'. Re-run with --purge to remove it."
fi

echo
echo "== Done =="
echo "Node.js, Apache modules, and the certbot renewal timer were left in place;"
echo "other services may depend on them."
