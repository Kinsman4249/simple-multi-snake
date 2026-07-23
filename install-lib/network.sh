#!/usr/bin/env bash
#
# install-lib/network.sh - port selection plus detection of state left
# behind by a previous install: an old vhost the installer no longer knows
# about, or a prior run whose service is crash-looping. Requires
# CHOSEN_DOMAIN/VHOST_FILE, APP_DIR, PORT_FILE, PREFERRED_PORT,
# DEFAULT_PORT, and port_is_free (common.sh) to already be set.

# Old-install / alt-port-config check.
#
# The "retire the previous hostname's vhost" step in install.sh only knows
# about ONE previous hostname (whatever is in last-domain), so it misses
# vhosts that predate the installer being used at all, or that were left
# behind by hand-editing outside of it. This scans every enabled Apache site
# for the distinctive "/ws" WebSocket ProxyPass line our own template writes,
# which is specific enough that an unrelated vhost is very unlikely to match
# it, and reports any such vhost that is not the one we are about to manage
# for CHOSEN_DOMAIN. This is where a stale hostname pointed at a now-dead
# port would show up (an "alt port config"), since nothing is listening
# there once the app has moved to a different port.
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

# Recovery catch: if an earlier install left the service crash-looping
# (classically EADDRINUSE from a port already in use), this makes that
# visible and, when interactive, asks before applying the fix. It is
# distinct from resolve_port below, whose whole job is to prevent the clash
# in the first place. This path exists because a prior run may have already
# written a bad port into the app config and the vhosts, then reported
# success while the service quietly failed, producing a confusing 404.
detect_prior_failure() {
  # Only relevant if a prior install exists on this host.
  [ -f /etc/systemd/system/multisnake.service ] || return 0

  local failed=0
  if systemctl is-failed --quiet multisnake 2>/dev/null; then
    failed=1
  elif journalctl -u multisnake -n 50 --no-pager 2>/dev/null | grep -qE 'EADDRINUSE|Address already in use'; then
    failed=1
  fi
  [ "$failed" -eq 1 ] || return 0

  # Work out which port the failed install was trying to use.
  local prior_port=""
  # The port lives in config.json ("port") since the Rust rewrite; before
  # that it was a const in server/config.js or server.js. Check all three so
  # upgrades from any shape are diagnosed.
  if [ -r "${APP_DIR}/config.json" ]; then
    prior_port="$(grep -oE '"port"[[:space:]]*:[[:space:]]*[0-9]+' "${APP_DIR}/config.json" | grep -oE '[0-9]+' | head -n1 || true)"
  fi
  local port_file_candidate
  for port_file_candidate in "${APP_DIR}/server/config.js" "${APP_DIR}/server.js"; do
    if [ -z "$prior_port" ] && [ -r "$port_file_candidate" ]; then
      prior_port="$(grep -oE 'const PORT = [0-9]+' "$port_file_candidate" | grep -oE '[0-9]+' | head -n1 || true)"
    fi
  done
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

# Initial catch: stop our own service so it releases any port it holds, then
# choose a port: the PORT override, else the last saved port, else the
# default, scanning upward until a free port is found.
resolve_port() {
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
