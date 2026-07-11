#!/usr/bin/env bash
#
# uninstall.sh - removes what install.sh set up for simple-multi-snake.
#
# One-liner (as root):
#   curl -fsSL https://raw.githubusercontent.com/Kinsman4249/simple-multi-snake/main/uninstall.sh | sudo bash
#
# To also remove the service account and delete the app directory outright:
#   curl -fsSL https://raw.githubusercontent.com/Kinsman4249/simple-multi-snake/main/uninstall.sh | sudo bash -s -- --purge
#
# From a local checkout:
#   sudo ./uninstall.sh            # remove app, service, vhost; keep a highscores backup
#   sudo ./uninstall.sh --purge    # also remove the service user
#
# High scores are backed up to /root before the app directory is removed.

set -euo pipefail

APP_DIR="${APP_DIR:-/opt/multisnake}"
SERVICE_USER="${SERVICE_USER:-multisnake}"
DOMAIN="${DOMAIN:-snek.ethanantonio.com}"
VHOST_FILE="${DOMAIN}.conf"
PURGE=0
[ "${1:-}" = "--purge" ] && PURGE=1

if [ "$(id -u)" -ne 0 ]; then
  echo "ERROR: run this as root (use sudo)." >&2
  exit 1
fi

echo "== simple-multi-snake uninstaller =="

# 1. Stop and remove the systemd service.
echo "[1/4] Stopping and removing the systemd service..."
if systemctl list-unit-files | grep -q '^multisnake.service'; then
  systemctl disable --now multisnake || true
fi
rm -f /etc/systemd/system/multisnake.service
systemctl daemon-reload

# 2. Remove the Apache vhost. Proxy modules are left enabled since other
#    sites on this server may rely on them.
echo "[2/4] Removing the Apache vhost ${VHOST_FILE}..."
if [ -f "/etc/apache2/sites-enabled/${VHOST_FILE}" ]; then
  a2dissite "${VHOST_FILE}" >/dev/null || true
fi
rm -f "/etc/apache2/sites-available/${VHOST_FILE}"
apache2ctl configtest && systemctl reload apache2 || true

# 3. Back up the high score file if it exists.
echo "[3/4] Backing up high scores if present..."
if [ -f "${APP_DIR}/highscores.json" ]; then
  BACKUP="/root/multisnake-highscores-$(date +%Y%m%d-%H%M%S).json"
  cp "${APP_DIR}/highscores.json" "${BACKUP}"
  echo "  Saved ${BACKUP}"
fi

# 4. Remove the app directory, and optionally the service user.
echo "[4/4] Removing application files..."
rm -rf "${APP_DIR}"
if [ "${PURGE}" -eq 1 ]; then
  if id "${SERVICE_USER}" >/dev/null 2>&1; then
    userdel "${SERVICE_USER}" || true
    echo "  Removed service user ${SERVICE_USER}."
  fi
fi

echo
echo "== Done =="
if [ "${PURGE}" -eq 0 ]; then
  echo "Service user '${SERVICE_USER}' was kept. Re-run with --purge to remove it."
fi
echo "Node.js and Apache modules were left installed; other services may use them."
