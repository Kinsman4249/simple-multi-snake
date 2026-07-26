#!/usr/bin/env bash
#
# install-lib/service.sh - admin token management and the graceful
# warn-then-restart used in place of a bare `systemctl restart multisnake`.
#
# The server exposes POST /api/admin/notify-shutdown (server-rust/src/
# routes.rs), gated on a shared secret (ADMIN_TOKEN env var, read by
# config/mod.rs) because Apache proxies "/" straight through to the app --
# that route is internet-reachable, not loopback-only. The secret lives in
# ADMIN_ENV_FILE, sourced into the service by deploy/multisnake.service's
# `EnvironmentFile=-${ADMIN_ENV_FILE}` line (the leading "-" makes a missing
# file non-fatal, matching a from-source binary that predates this feature).

ADMIN_ENV_FILE="${ADMIN_ENV_FILE:-${STATE_DIR}/admin.env}"

# resolve_admin_token: reuse the token already on disk (so a restart mid-
# warning-period from a *second* install run still authenticates), or
# generate a fresh 32-byte hex token on first run. Sets ADMIN_TOKEN.
resolve_admin_token() {
  if [ -r "$ADMIN_ENV_FILE" ]; then
    ADMIN_TOKEN="$(sed -n 's/^ADMIN_TOKEN=//p' "$ADMIN_ENV_FILE" | head -n1)"
  fi
  if [ -z "${ADMIN_TOKEN:-}" ]; then
    ADMIN_TOKEN="$(openssl rand -hex 32 2>/dev/null || head -c32 /dev/urandom | od -An -tx1 | tr -d ' \n')"
  fi
  mkdir -p "$(dirname "$ADMIN_ENV_FILE")"
  umask 077
  printf 'ADMIN_TOKEN=%s\n' "$ADMIN_TOKEN" > "$ADMIN_ENV_FILE"
  chmod 0600 "$ADMIN_ENV_FILE"
}

# restart_multisnake_with_warning <port>: if an old multisnake is already
# running and has connected players, broadcast a 30s maintenance warning
# (so a player mid-run can bail out and bank their high score) and wait out
# the warning before restarting. Skips the wait entirely -- restarts right
# away, same as before this feature existed -- when the service was not
# already running, when nobody is connected, or when the notify call fails
# for any reason (old binary predating this route, token mismatch, etc):
# never let a broken warning path block an update.
restart_multisnake_with_warning() {
  local port="$1"
  local connected=0
  if systemctl is-active --quiet multisnake; then
    local resp
    resp="$(curl -fsS -m 5 -X POST "http://127.0.0.1:${port}/api/admin/notify-shutdown" \
      -H "X-Admin-Token: ${ADMIN_TOKEN}" \
      -d '{"text":"Server restarting for maintenance in 30s -- finish your run to save your high score!"}' \
      2>/dev/null || true)"
    if [ -n "$resp" ]; then
      # Response is always the flat {"connected": N} shape from our own
      # route (routes.rs api_admin_notify_shutdown) -- no JSON parser needed.
      connected="$(printf '%s' "$resp" | grep -o '"connected"[[:space:]]*:[[:space:]]*[0-9]\+' | grep -o '[0-9]\+$')"
      case "$connected" in ''|*[!0-9]*) connected=0 ;; esac
    fi
  fi
  if [ "$connected" -gt 0 ]; then
    echo "  ${connected} player(s) connected; warned them and waiting 30s before restarting..."
    sleep 30
  fi
  systemctl restart multisnake
}
