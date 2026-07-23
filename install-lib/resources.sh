#!/usr/bin/env bash
#
# install-lib/resources.sh - everything specific to low-RAM hosts. All of
# this is optional in the sense that on a normal-sized host none of it does
# anything: detect_low_resource just sets IS_LOW_RESOURCE=0, maybe_add_swap
# returns immediately, and fetch_prebuilt_binary is only ever called after a
# source build has already failed (or USE_PREBUILT was requested outright).
# Requires falsy (common.sh), and LOW_RAM_THRESHOLD_MB/SWAP_FILE/
# SWAP_SIZE_MB/GITHUB_API_REPO/APP_DIR from install.sh's config section.

# Sets IS_LOW_RESOURCE (0/1) and TOTAL_RAM_MB. Below LOW_RAM_THRESHOLD_MB the
# Rust compiler is prone to being OOM-killed on a single-core/1GB box, so the
# build switches to a single cargo job with LTO off (see install.sh's build
# step) and maybe_add_swap below is offered. Override with LOW_RESOURCE=yes/no.
detect_low_resource() {
  TOTAL_RAM_MB="$(awk '/MemTotal/{printf "%d", $2/1024}' /proc/meminfo 2>/dev/null || echo 0)"
  if [ -n "${LOW_RESOURCE:-}" ]; then
    if truthy "$LOW_RESOURCE"; then IS_LOW_RESOURCE=1; else IS_LOW_RESOURCE=0; fi
  elif [ "$TOTAL_RAM_MB" -gt 0 ] && [ "$TOTAL_RAM_MB" -lt "$LOW_RAM_THRESHOLD_MB" ]; then
    IS_LOW_RESOURCE=1
  else
    IS_LOW_RESOURCE=0
  fi
  if [ "$IS_LOW_RESOURCE" -eq 1 ]; then
    echo "Detected ${TOTAL_RAM_MB}MiB RAM (< ${LOW_RAM_THRESHOLD_MB}MiB): using low-resource build settings."
  fi
}

# Swap file (low-resource hosts only). Compiling Rust dependencies can peak
# well above 1GB of RAM even with the low-resource build settings; on a box
# with no swap that means the OOM killer takes out rustc instead of the
# build just running slower. Skipped entirely on hosts above the RAM
# threshold, and left alone if swap is already configured. Override with
# CREATE_SWAP=yes/no; the interactive prompt defaults to yes.
maybe_add_swap() {
  [ "$IS_LOW_RESOURCE" -eq 1 ] || return 0

  if swapon --show 2>/dev/null | grep -q .; then
    echo "Swap is already configured; leaving it as-is."
    return 0
  fi

  local do_swap="${CREATE_SWAP:-}"
  if [ -z "$do_swap" ] && [ -r /dev/tty ]; then
    printf "Low memory detected and no swap is configured. Create a %sMB swap file\nat %s to avoid the Rust compiler being OOM-killed? [Y/n]: " \
      "$SWAP_SIZE_MB" "$SWAP_FILE" > /dev/tty
    local ans
    read -r ans < /dev/tty || ans=""
    case "$ans" in
      [Nn]*) do_swap=no ;;
      *) do_swap=yes ;;
    esac
  fi
  [ -z "$do_swap" ] && do_swap=yes

  if falsy "$do_swap"; then
    echo "Skipping swap file (CREATE_SWAP=no); the build may be slower or fail on low RAM."
    return 0
  fi

  echo "Creating a ${SWAP_SIZE_MB}MB swap file at ${SWAP_FILE}..."
  if [ -e "$SWAP_FILE" ]; then
    echo "  ${SWAP_FILE} already exists; reusing it."
  else
    if ! fallocate -l "${SWAP_SIZE_MB}M" "$SWAP_FILE" 2>/dev/null; then
      dd if=/dev/zero of="$SWAP_FILE" bs=1M count="$SWAP_SIZE_MB" status=none
    fi
    chmod 600 "$SWAP_FILE"
    mkswap "$SWAP_FILE" >/dev/null
  fi
  swapon "$SWAP_FILE"
  if ! grep -qsF "$SWAP_FILE " /etc/fstab; then
    printf "%s none swap sw 0 0\n" "$SWAP_FILE" >> /etc/fstab
  fi
  echo "  Swap enabled ($(free -h | awk '/Swap:/{print $2}') total)."
}

# Last resort when compiling from source fails (or when USE_PREBUILT=yes
# skips the attempt entirely). Downloads the architecture-matching server
# binary attached to the latest GitHub Release (published by
# .github/workflows/release.yml) instead of building one. Returns 1 (without
# exiting) if no matching asset is found or the download fails, so the
# caller can report a clear final error.
fetch_prebuilt_binary() {
  local use_prebuilt="${USE_PREBUILT:-}"
  if [ -z "$use_prebuilt" ] && [ -r /dev/tty ]; then
    printf "Download a prebuilt server binary from GitHub Releases instead? [Y/n]: " > /dev/tty
    local ans
    read -r ans < /dev/tty || ans=""
    case "$ans" in
      [Nn]*) use_prebuilt=no ;;
      *) use_prebuilt=yes ;;
    esac
  fi
  [ -z "$use_prebuilt" ] && use_prebuilt=yes
  if falsy "$use_prebuilt"; then
    return 1
  fi

  local arch asset_name api_url dl_url tmp_bin
  arch="$(uname -m)"
  case "$arch" in
    x86_64|amd64) asset_name="multisnake-server-linux-x86_64" ;;
    *)
      echo "  No prebuilt binary is published for architecture '${arch}'." >&2
      return 1
      ;;
  esac

  echo "  Looking up the '${asset_name}' asset on the latest GitHub Release..."
  api_url="https://api.github.com/repos/${GITHUB_API_REPO}/releases/latest"
  dl_url="$(curl -fsSL "$api_url" 2>/dev/null \
    | grep -oE '"browser_download_url"[[:space:]]*:[[:space:]]*"[^"]*'"${asset_name}"'"' \
    | sed -E 's/.*"(https:[^"]+)"$/\1/' | head -n1 || true)"
  if [ -z "$dl_url" ]; then
    echo "  Could not find a '${asset_name}' asset in the latest release." >&2
    return 1
  fi

  tmp_bin="$(mktemp)"
  echo "  Downloading ${dl_url}..."
  if ! curl -fsSL "$dl_url" -o "$tmp_bin"; then
    echo "  Download failed." >&2
    rm -f "$tmp_bin"
    return 1
  fi
  install -m 0755 "$tmp_bin" "${APP_DIR}/multisnake-server"
  rm -f "$tmp_bin"
  echo "  Installed prebuilt ${APP_DIR}/multisnake-server."
  return 0
}
