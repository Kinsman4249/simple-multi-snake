#!/usr/bin/env bash
#
# install-lib/common.sh - small helpers shared by more than one part of
# install.sh. Sourced, not executed directly (no shebang effect here).

# truthy/falsy: normalize a yes/no-ish value case-insensitively. Neither
# matching means "unrecognized" -- callers decide what that means (error out,
# fall through to a default, etc). Split in two rather than one tri-state
# function so each call site reads as a plain condition.
truthy() {
  case "$(printf '%s' "${1:-}" | tr '[:upper:]' '[:lower:]')" in
    y|yes|true|1|on) return 0 ;;
    *) return 1 ;;
  esac
}
falsy() {
  case "$(printf '%s' "${1:-}" | tr '[:upper:]' '[:lower:]')" in
    n|no|false|0|off) return 0 ;;
    *) return 1 ;;
  esac
}

# port_is_free: true when nothing is listening on the given TCP port, on any
# interface. Deliberately conservative (any listener anywhere means "not
# free"). Used by both the proactive port picker and the stale-vhost scan in
# network.sh.
port_is_free() {
  local p="$1"
  if ss -ltnH 2>/dev/null | awk '{print $4}' | sed 's/.*://' | grep -qx "$p"; then
    return 1
  fi
  return 0
}
