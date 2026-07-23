#!/usr/bin/env bash
#
# install-lib/prompts.sh - the interactive/env-driven config prompts:
# hostname, simHz, maxPlayers, enableDebug. Each resolve_* function reads its
# env override, otherwise prompts (defaulting to the last saved value) if a
# terminal is attached, otherwise falls back to the last saved value or a
# built-in default. Requires the *_FILE / DEFAULT_* / LAST_* variables and
# truthy/falsy from common.sh to already be set by install.sh.

valid_hostname() {
  # Letters, digits, dots, and hyphens, must contain at least one dot, and
  # must not start or end with a dot or hyphen.
  printf "%s" "$1" | grep -Eq '^[A-Za-z0-9]([A-Za-z0-9.-]*[A-Za-z0-9])?$' \
    && printf "%s" "$1" | grep -q '\.'
}

# Hostname resolution. Order of precedence:
#   1. DOMAIN environment variable, if set (non-interactive path).
#   2. Interactive prompt on the terminal, defaulting to the last used
#      hostname if this installer has been run before.
#   3. If there is no terminal, no DOMAIN, and no saved hostname, stop.
resolve_domain() {
  if [ -n "${DOMAIN:-}" ]; then
    if ! valid_hostname "$DOMAIN"; then
      echo "ERROR: DOMAIN='${DOMAIN}' is not a valid hostname." >&2
      exit 1
    fi
    CHOSEN_DOMAIN="$DOMAIN"
    return
  fi

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

  echo "ERROR: no hostname provided and no saved hostname to reuse." >&2
  echo "Re-run with DOMAIN set, e.g. sudo DOMAIN=snek.example.com bash install.sh" >&2
  exit 1
}

# Simulation rate resolution. Same precedence pattern as resolve_domain,
# via SIM_HZ / LAST_SIMHZ / DEFAULT_SIMHZ. Validated (positive integer,
# 1..1000). Higher = finer input sampling; it does NOT change snake speed.
resolve_simhz() {
  local def="${SIM_HZ:-${LAST_SIMHZ:-$DEFAULT_SIMHZ}}"
  if [ -n "${SIM_HZ:-}" ]; then
    CHOSEN_SIMHZ="$SIM_HZ"
  elif [ -r /dev/tty ]; then
    printf "Server simulation rate in Hz [%s]: " "$def" > /dev/tty
    local reply
    read -r reply < /dev/tty || reply=""
    [ -z "$reply" ] && reply="$def"
    CHOSEN_SIMHZ="$reply"
  else
    CHOSEN_SIMHZ="$def"
  fi
  case "$CHOSEN_SIMHZ" in
    ''|*[!0-9]*)
      echo "ERROR: simHz must be a positive integer." >&2
      exit 1
      ;;
  esac
  if [ "$CHOSEN_SIMHZ" -lt 1 ] || [ "$CHOSEN_SIMHZ" -gt 1000 ]; then
    echo "ERROR: simHz out of range (1-1000)." >&2
    exit 1
  fi
}

# Max player count resolution (board capacity). Same precedence pattern, via
# MAX_PLAYERS / LAST_MAXPLAYERS / DEFAULT_MAXPLAYERS. Validated (positive
# integer, 1..64) -- ~16 is the realistic ceiling on a Google Cloud e2-micro
# free-tier instance, above which network fan-out (each client receives
# state scaling with every player's segments) and the 0.25 vCPU sustained
# baseline become the limit, not RAM.
resolve_maxplayers() {
  local def="${MAX_PLAYERS:-${LAST_MAXPLAYERS:-$DEFAULT_MAXPLAYERS}}"
  if [ -n "${MAX_PLAYERS:-}" ]; then
    CHOSEN_MAXPLAYERS="$MAX_PLAYERS"
  elif [ -r /dev/tty ]; then
    printf "Max simultaneous players on the board [%s]: " "$def" > /dev/tty
    local reply
    read -r reply < /dev/tty || reply=""
    [ -z "$reply" ] && reply="$def"
    CHOSEN_MAXPLAYERS="$reply"
  else
    CHOSEN_MAXPLAYERS="$def"
  fi
  case "$CHOSEN_MAXPLAYERS" in
    ''|*[!0-9]*)
      echo "ERROR: maxPlayers must be a positive integer." >&2
      exit 1
      ;;
  esac
  if [ "$CHOSEN_MAXPLAYERS" -lt 1 ] || [ "$CHOSEN_MAXPLAYERS" -gt 64 ]; then
    echo "ERROR: maxPlayers out of range (1-64; ~16 is the e2-micro free-tier ceiling)." >&2
    exit 1
  fi
}

# Debug switch resolution (config.json "enableDebug"). Same precedence
# pattern, via ENABLE_DEBUG / LAST_DEBUG / DEFAULT_DEBUG. When on, the client
# renders the DEBUG panel and an on-page build/version stamp (bottom-right)
# so an operator can confirm which build a browser has actually loaded --
# invaluable for spotting a stale cached deploy. When off, none of that is
# constructed (zero-resource gate, see server-rust/src/config.rs) and players never
# see it.
resolve_debug() {
  local def="${ENABLE_DEBUG:-${LAST_DEBUG:-$DEFAULT_DEBUG}}"
  local raw
  if [ -n "${ENABLE_DEBUG:-}" ]; then
    raw="$ENABLE_DEBUG"
  elif [ -r /dev/tty ]; then
    printf "Enable the debug panel + on-page version stamp? (yes/no) [%s]: " "$def" > /dev/tty
    local reply
    read -r reply < /dev/tty || reply=""
    [ -z "$reply" ] && reply="$def"
    raw="$reply"
  else
    raw="$def"
  fi
  if truthy "$raw"; then
    CHOSEN_DEBUG=true
  elif falsy "$raw"; then
    CHOSEN_DEBUG=false
  else
    echo "ERROR: enableDebug must be yes/no (got '${raw}')." >&2
    exit 1
  fi
}
