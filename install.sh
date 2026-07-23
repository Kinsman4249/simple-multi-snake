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
# and points config.json and the vhosts at it. Force a specific port with PORT.
# The chosen port is saved and reused on later runs. A previous install that
# crash-looped on a port clash is detected and offered an automatic fix.
#
# Sim rate: the server runs a fixed-rate simulation loop, separate from how
# often the snake moves one cell. The default is 60 Hz. A higher rate samples
# input more finely (imperceptibly lower input latency) but does NOT change
# snake speed, which is governed by the movement cadence in config.json. The
# installer prompts for it, offering the last used value as the default, and
# it can be forced non-interactively with SIM_HZ.
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
#
# Build cache: the curl|bash one-liner has no local checkout, so past runs
# cloned into a fresh mktemp dir every time, throwing away server-rust/target/
# and forcing cargo to recompile every dependency from scratch on every run.
# It now clones into a persistent SRC_CACHE_DIR instead and re-fetches on
# later runs, so cargo's incremental build state survives and only changed
# crates rebuild. Force a different location with SRC_CACHE_DIR, or skip
# reuse entirely with SRC_CACHE=no (falls back to a throwaway mktemp clone).
#
# Low-memory hosts: below 2GiB RAM (e.g. a 1GB e2-micro), the installer
# switches to low-resource build settings (single-job cargo build, LTO off)
# and offers to add a swap file so the Rust compiler does not get OOM-killed.
# Force this behavior with LOW_RESOURCE=yes/no; decline the swap file offer
# non-interactively with CREATE_SWAP=no. The swap file is temporary: once the
# build finishes it is torn back down (swapoff, deleted, fstab entry
# removed) unless the installer created it, in which case KEEP_SWAP=yes
# keeps it around for a future run instead. If the source build still fails
# (or you'd rather skip compiling entirely), set USE_PREBUILT=yes to fetch a
# prebuilt server binary from the latest GitHub Release instead.
#
# The installer only marks itself "succeeded" (a flag file under STATE_DIR)
# once every step below has completed. A re-run that finds no such flag from
# a previous attempt says so, since it means that attempt did not finish.
#
# This script is intentionally just the orchestrator: hostname/simHz/
# maxPlayers/debug prompts, port + stale-vhost detection, low-RAM handling,
# and TLS setup all live in install-lib/*.sh (sourced below) to keep this
# file short. See install-lib/README.md for what's in each file.

set -euo pipefail

# ---------------------------------------------------------------------------
# Configuration. Override any value by exporting it before running.
# Note: there is deliberately no default hostname. See resolve_domain below.
# ---------------------------------------------------------------------------
REPO_URL="${REPO_URL:-https://github.com/Kinsman4249/simple-multi-snake.git}"
REPO_BRANCH="${REPO_BRANCH:-main}"
APP_DIR="${APP_DIR:-/opt/multisnake}"        # where the app is installed
SERVICE_USER="${SERVICE_USER:-multisnake}"   # unprivileged account the service runs as
# The server is a compiled Rust binary (server-rust/). The Rust toolchain is
# installed via rustup into RUSTUP_DIR (self-contained, apt is not involved)
# and only used at install/update time to build; the service itself runs the
# resulting static-ish binary with no runtime beyond libc.
RUSTUP_DIR="${RUSTUP_DIR:-/opt/multisnake-toolchain}"
# Deno is installed only to build the WASM renderer (tools/build-wasm.mjs);
# Node.js is no longer needed at all.
DENO_INSTALL_DIR="${DENO_INSTALL_DIR:-/usr/local}"
# Persistent clone reused across curl|bash runs so cargo's target/ dir (and
# thus already-compiled dependencies) survives between installs. See the
# "Build cache" note above.
SRC_CACHE_DIR="${SRC_CACHE_DIR:-/opt/multisnake-build}"
SRC_CACHE="${SRC_CACHE:-yes}"                # set to "no" to force a throwaway clone instead
STATE_DIR="${STATE_DIR:-/etc/multisnake}"    # holds installer state between runs
STATE_FILE="${STATE_DIR}/last-domain"        # the hostname used on the last run
PORT_FILE="${STATE_DIR}/last-port"           # the port used on the last run
EMAIL_FILE="${STATE_DIR}/last-email"         # the Let's Encrypt notice email used on the last run
SIMHZ_FILE="${STATE_DIR}/last-simhz"         # the sim rate (Hz) used on the last run
MAXPLAYERS_FILE="${STATE_DIR}/last-maxplayers" # the max player count used last run
DEBUG_FILE="${STATE_DIR}/last-debug"         # the enableDebug choice (yes/no) used last run
INSTALL_OK_FILE="${STATE_DIR}/install-ok"    # timestamp written only when a run fully succeeds
PREFERRED_PORT="${PORT:-}"                   # optional explicit port override
DEFAULT_PORT=8080                            # starting point for the free-port scan
TEMPLATE_NAME="fillmeout.example.com.conf"   # placeholder vhost shipped in deploy/
TEMPLATE_HOST="fillmeout.example.com"        # placeholder string replaced at install
TEMPLATE_PORT="8080"                         # placeholder port in the vhost template
ENABLE_TLS="${ENABLE_TLS:-yes}"              # set to "no" to skip certbot / 443
CERTBOT_EMAIL="${CERTBOT_EMAIL:-}"           # optional; blank registers without email
CF_API_TOKEN="${CF_API_TOKEN:-}"             # Cloudflare token, Zone:DNS:Edit scope
CF_PROPAGATION="${CF_PROPAGATION:-30}"       # seconds to wait for DNS propagation
DEFAULT_SIMHZ=60                             # default server simulation rate in Hz
DEFAULT_MAXPLAYERS=8                         # default board capacity (~16 is the e2-micro ceiling)
DEFAULT_DEBUG=yes                            # ship with the debug panel + on-page version stamp on
GITHUB_API_REPO="Kinsman4249/simple-multi-snake" # owner/repo for the prebuilt-binary fallback lookup
LOW_RAM_THRESHOLD_MB=2048                    # below this, switch to low-resource build settings
SWAP_FILE="/swapfile"                        # created only if offered/accepted and none exists
SWAP_SIZE_MB=2048

# ---------------------------------------------------------------------------
# Must run as root: it writes to /opt, /etc/systemd, and /etc/apache2.
# ---------------------------------------------------------------------------
if [ "$(id -u)" -ne 0 ]; then
  echo "ERROR: run this as root (use sudo)." >&2
  exit 1
fi

echo "== simple-multi-snake installer =="

# ---------------------------------------------------------------------------
# Load helper functions (see install-lib/README.md for what's in each file).
# If running from a checkout (either invocation form documented at the top),
# the install-lib/ directory sitting next to this script is used directly.
# The curl | bash one-liner has no local checkout, so BASH_SOURCE[0] is not a
# real file in that case -- it fetches the same files from the same branch
# instead. Either way these are plain function definitions; nothing here
# touches the system.
# ---------------------------------------------------------------------------
INSTALL_LIB_FILES="common prompts network resources tls"
INSTALL_LIB_DIR=""
if [ -n "${BASH_SOURCE[0]:-}" ] && [ -f "${BASH_SOURCE[0]}" ]; then
  SELF_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" >/dev/null 2>&1 && pwd)"
  if [ -d "${SELF_DIR}/install-lib" ]; then
    INSTALL_LIB_DIR="${SELF_DIR}/install-lib"
  fi
fi
if [ -z "$INSTALL_LIB_DIR" ]; then
  INSTALL_LIB_DIR="$(mktemp -d)"
  for lib in $INSTALL_LIB_FILES; do
    curl -fsSL "https://raw.githubusercontent.com/${GITHUB_API_REPO}/${REPO_BRANCH}/install-lib/${lib}.sh" \
      -o "${INSTALL_LIB_DIR}/${lib}.sh"
  done
fi
for lib in $INSTALL_LIB_FILES; do
  # shellcheck source=/dev/null
  source "${INSTALL_LIB_DIR}/${lib}.sh"
done

# ---------------------------------------------------------------------------
# Low-resource detection (install-lib/resources.sh). Below LOW_RAM_THRESHOLD_MB
# the compiler is prone to being OOM-killed on a single-core/1GB box, so the
# build switches to a single cargo job with LTO off and offers a swap file
# further down. Override with LOW_RESOURCE=yes/no.
# ---------------------------------------------------------------------------
detect_low_resource

# A prior run that never reached the end left no success flag. That is worth
# surfacing before this run clears it, since a build that keeps failing on a
# tight box is exactly when USE_PREBUILT=yes is the fastest way forward.
if [ -r "$STATE_FILE" ] && [ ! -r "$INSTALL_OK_FILE" ]; then
  echo "NOTICE: a previous install attempt on this host did not finish successfully"
  echo "(no completed run recorded at ${INSTALL_OK_FILE})."
  echo "If the Rust build keeps failing, re-run with USE_PREBUILT=yes to skip"
  echo "compiling and fetch a prebuilt server binary from the latest GitHub Release."
fi
mkdir -p "${STATE_DIR}"
rm -f "${INSTALL_OK_FILE}"

# ---------------------------------------------------------------------------
# Hostname/simHz/maxPlayers/debug resolution (install-lib/prompts.sh). Each
# reads its saved value from *_FILE below, offers it as the interactive
# default, and can be forced non-interactively via its env var.
# ---------------------------------------------------------------------------
LAST_DOMAIN=""
if [ -r "$STATE_FILE" ]; then
  LAST_DOMAIN="$(cat "$STATE_FILE" 2>/dev/null || true)"
fi
LAST_EMAIL=""
if [ -r "$EMAIL_FILE" ]; then
  LAST_EMAIL="$(cat "$EMAIL_FILE" 2>/dev/null || true)"
fi
LAST_SIMHZ=""
if [ -r "$SIMHZ_FILE" ]; then
  LAST_SIMHZ="$(cat "$SIMHZ_FILE" 2>/dev/null || true)"
fi
LAST_MAXPLAYERS=""
if [ -r "$MAXPLAYERS_FILE" ]; then
  LAST_MAXPLAYERS="$(cat "$MAXPLAYERS_FILE" 2>/dev/null || true)"
fi
LAST_DEBUG=""
if [ -r "$DEBUG_FILE" ]; then
  LAST_DEBUG="$(cat "$DEBUG_FILE" 2>/dev/null || true)"
fi

resolve_domain
VHOST_FILE="${CHOSEN_DOMAIN}.conf"
LE_SSL_FILE="/etc/apache2/sites-available/${CHOSEN_DOMAIN}-le-ssl.conf"
CF_CREDS_FILE="/etc/letsencrypt/cloudflare-${CHOSEN_DOMAIN}.ini"
echo "Using hostname: ${CHOSEN_DOMAIN}"

resolve_simhz
echo "Using simHz: ${CHOSEN_SIMHZ}"

resolve_maxplayers
echo "Using maxPlayers: ${CHOSEN_MAXPLAYERS}"

resolve_debug
echo "Using enableDebug: ${CHOSEN_DEBUG}"

# ---------------------------------------------------------------------------
# Port + stale-vhost detection (install-lib/network.sh).
# ---------------------------------------------------------------------------
detect_stale_vhosts
detect_prior_failure
resolve_port

# ---------------------------------------------------------------------------
# TLS inputs (install-lib/tls.sh), gathered before any package installs so a
# missing token fails fast rather than after apt/cargo/deno work.
# ---------------------------------------------------------------------------
resolve_tls_inputs

# ---------------------------------------------------------------------------
# Swap file for low-resource hosts (install-lib/resources.sh). No-op unless
# detect_low_resource set IS_LOW_RESOURCE=1 above.
# ---------------------------------------------------------------------------
maybe_add_swap

# ---------------------------------------------------------------------------
# 1. Base tools. curl and git fetch the toolchain and the repo; gcc (from
#    build-essential) is the linker rustc needs; unzip is for the deno
#    installer.
# ---------------------------------------------------------------------------
echo "[1/9] Installing base packages (curl, git, ca-certificates, build-essential, unzip)..."
apt-get update -y
apt-get install -y curl git ca-certificates build-essential unzip

# ---------------------------------------------------------------------------
# 2. Build toolchains.
#    - Rust (rustup, minimal profile) builds the game server binary. It is
#      installed self-contained under RUSTUP_DIR so nothing touches apt or
#      any developer's ~/.cargo; re-runs reuse and update it.
#    - Deno builds the WASM renderer (tools/build-wasm.mjs). Node.js is no
#      longer used; an old NodeSource install, if present, is simply ignored.
# ---------------------------------------------------------------------------
export RUSTUP_HOME="${RUSTUP_DIR}/rustup"
export CARGO_HOME="${RUSTUP_DIR}/cargo"
export PATH="${CARGO_HOME}/bin:${DENO_INSTALL_DIR}/bin:${PATH}"
# NOTE: `command -v cargo` succeeding does NOT prove a working compiler.
# rustup drops its proxy shims into ${CARGO_HOME}/bin BEFORE it downloads
# the actual toolchain, so an interrupted first install (network drop,
# ctrl-C, OOM) leaves cargo/rustc proxies on PATH with no default
# toolchain configured. Every proxy call then fails with "rustup could
# not choose a version of rustc to run", and under `set -e` the bare
# `rustc --version` below aborted the whole install -- a half-deployed
# box that no re-run could heal. Probe THROUGH the proxy and repair
# instead of assuming: `rustup default stable` both downloads stable (if
# missing) and sets it as the default, exactly the state a fresh
# rustup-init would have produced.
if command -v cargo >/dev/null 2>&1; then
  if rustc --version >/dev/null 2>&1; then
    echo "[2/9] Rust toolchain already present ($(rustc --version)); updating..."
    rustup update stable >/dev/null 2>&1 || true
  else
    echo "[2/9] Rust toolchain half-installed (rustup proxies without a default toolchain); repairing..."
    # Cheap fix first: set (and download if absent) the default toolchain.
    # But an interrupted download can also leave a CORRUPT partial
    # toolchain directory -- `rustup default stable` then reports "using
    # existing install" and errors with "Missing manifest in toolchain
    # 'stable-...'" while rustc stays broken. So verify through the proxy
    # afterward and, if it still fails, remove the corrupt toolchain and
    # reinstall it from scratch before setting the default again.
    rustup default stable || true
    if ! rustc --version >/dev/null 2>&1; then
      echo "  Toolchain directory is corrupt (missing manifest); reinstalling stable from scratch..."
      rustup toolchain uninstall stable >/dev/null 2>&1 || true
      rustup toolchain install stable --profile minimal
      rustup default stable
    fi
  fi
else
  echo "[2/9] Installing the Rust toolchain (rustup, stable, minimal profile)..."
  mkdir -p "${RUSTUP_DIR}"
  curl --proto '=https' --tlsv1.2 -fsSL https://sh.rustup.rs \
    | sh -s -- -y --profile minimal --default-toolchain stable --no-modify-path
fi
rustc --version
cargo --version

if command -v deno >/dev/null 2>&1; then
  echo "  Deno already present ($(deno --version | head -n1)); reusing it."
else
  echo "  Installing Deno (for the WASM renderer build)..."
  curl -fsSL https://deno.land/install.sh | DENO_INSTALL="${DENO_INSTALL_DIR}" sh -s -- -y >/dev/null
fi
deno --version | head -n1

# ---------------------------------------------------------------------------
# 3. Get the source. If run from inside a checkout, use it as-is (nothing to
#    cache: it is already persistent). Otherwise reuse or create the
#    persistent clone at SRC_CACHE_DIR, so server-rust/target/ (cargo's
#    compiled dependencies) survives between curl | bash runs instead of
#    being thrown away with a fresh mktemp dir each time. Set SRC_CACHE=no to
#    opt back into a one-shot throwaway clone.
# ---------------------------------------------------------------------------
CLEANUP_SRC=0
if [ -d "./server-rust" ] && [ -f "./deploy/multisnake.service" ]; then
  SRC="$(pwd)"
  echo "[3/9] Using local checkout at ${SRC}."
elif ! truthy "${SRC_CACHE}"; then
  SRC="$(mktemp -d)"
  CLEANUP_SRC=1
  echo "[3/9] Cloning ${REPO_URL} (branch ${REPO_BRANCH})..."
  git clone --depth 1 --branch "${REPO_BRANCH}" "${REPO_URL}" "${SRC}"
else
  SRC="${SRC_CACHE_DIR}"
  if [ -d "${SRC}/.git" ] \
     && git -C "${SRC}" remote get-url origin 2>/dev/null | grep -qxF "${REPO_URL}"; then
    echo "[3/9] Reusing build cache at ${SRC}; fetching ${REPO_BRANCH}..."
    if ! ( git -C "${SRC}" fetch --depth 1 origin "${REPO_BRANCH}" \
             && git -C "${SRC}" reset --hard FETCH_HEAD \
             && git -C "${SRC}" clean -fdx -e server-rust/target ); then
      echo "  WARNING: fetch/reset failed; re-cloning from scratch." >&2
      rm -rf "${SRC}"
    fi
  fi
  if [ ! -d "${SRC}/.git" ]; then
    echo "[3/9] No usable build cache at ${SRC}; cloning ${REPO_URL} (branch ${REPO_BRANCH})..."
    rm -rf "${SRC}"
    mkdir -p "$(dirname "${SRC}")"
    git clone --depth 1 --branch "${REPO_BRANCH}" "${REPO_URL}" "${SRC}"
  fi
fi

# Build the WASM renderer from the sources just obtained (tools/build-wasm.mjs
# compiles wasm/renderer.ts with the pinned AssemblyScript compiler via npx
# and emits public/js/render-wasm.js). The compiled artifact is deliberately
# NOT committed to the repo: building it here means what this host serves is
# verifiably compiled from the sources in this checkout. The public/ tree
# walk below then deploys it like any other client file. Non-fatal on
# failure: the client automatically falls back to the plain 2D renderer when
# render-wasm.js is absent -- but note an update run that fails here also
# removes a previously deployed render-wasm.js (the stale-file sweep), so
# re-run the installer once the build issue is fixed.
echo "[3/9] Building the WASM renderer from source..."
if ( cd "${SRC}" && deno run -A tools/build-wasm.mjs ); then
  echo "  Built public/js/render-wasm.js from wasm/renderer.ts."
else
  echo "  WARNING: WASM renderer build failed; the game will use the 2D fallback renderer." >&2
fi

# ---------------------------------------------------------------------------
# 4. Lay the app down in APP_DIR, then patch the chosen port/sim rate into
#    config.json. An existing highscores.json is left in place.
#    package.json is still installed: the server reads its "version" field
#    for the build stamp (it is data now, not a Node manifest).
# ---------------------------------------------------------------------------
echo "[4/9] Installing app files to ${APP_DIR}..."
mkdir -p "${APP_DIR}/public"
install -m 0644 "${SRC}/config.json"  "${APP_DIR}/config.json"
install -m 0644 "${SRC}/package.json" "${APP_DIR}/package.json"

# Build stamp: APP_DIR is not a git checkout, so the server falls back to
# build-info.json. Stamp it here from the source checkout's git metadata so
# the deployed build identifies itself precisely instead of as "dev".
if git -C "${SRC}" rev-parse --short HEAD >/dev/null 2>&1; then
  DESCRIBE="$(git -C "${SRC}" describe --tags --always 2>/dev/null || true)"
  COMMIT="$(git -C "${SRC}" rev-parse --short HEAD)"
  printf '{ "describe": "%s", "commit": "%s" }\n' "${DESCRIBE}" "${COMMIT}" \
    > "${APP_DIR}/build-info.json"
  chmod 0644 "${APP_DIR}/build-info.json"
fi

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

# The node server's JS trees (server.js, server/, powerups/) and its
# node_modules are no longer shipped -- the game logic is compiled into the
# Rust binary. Sweep them from an APP_DIR that predates the rewrite so no
# stale runtime lingers.
for legacy in server.js server powerups node_modules package-lock.json; do
  if [ -e "${APP_DIR}/${legacy}" ]; then
    rm -rf "${APP_DIR:?}/${legacy}"
    echo "  Removed legacy ${legacy} (node runtime no longer shipped)."
  fi
done

# config.json carries the chosen port (the Rust binary reads "port"; the
# PORT env var would also work, but keeping it in config.json keeps one
# config surface), the sim rate, capacity, and the debug switch. Edited with
# deno so the JSON stays valid regardless of key order or formatting.
deno eval "
const f = '${APP_DIR}/config.json';
const c = JSON.parse(Deno.readTextFileSync(f));
c.port = ${CHOSEN_PORT};
c.simHz = ${CHOSEN_SIMHZ};
c.maxPlayers = ${CHOSEN_MAXPLAYERS};
c.enableDebug = ${CHOSEN_DEBUG};
Deno.writeTextFileSync(f, JSON.stringify(c, null, 2) + '\n');
"
echo "  Set port=${CHOSEN_PORT}, simHz=${CHOSEN_SIMHZ}, maxPlayers=${CHOSEN_MAXPLAYERS}, enableDebug=${CHOSEN_DEBUG} in ${APP_DIR}/config.json."

# ---------------------------------------------------------------------------
# 5. Build the Rust server and install the binary. Debug symbols are
#    stripped by the release profile; the binary is a couple of MB and
#    depends only on libc. On a small instance (e2-micro) the first build
#    takes a while (all dependencies compile once); re-runs only rebuild
#    what changed.
#
#    Low-resource mode (see IS_LOW_RESOURCE above) forces a single cargo
#    build job and disables LTO: parallel codegen threads and cross-crate
#    LTO are what actually blow past ~1GB of RSS on a 1-vCPU/1GB box, more
#    so than the compile simply taking longer. niced/ioniced so a concurrent
#    SSH session stays responsive. USE_PREBUILT=yes skips the build
#    entirely; on any other build failure, fetch_prebuilt_binary
#    (install-lib/resources.sh) is offered automatically rather than
#    leaving the host with no server binary.
# ---------------------------------------------------------------------------
echo "[5/9] Building the game server from source (cargo build --release)..."
BUILD_PREFIX=()
if [ "$IS_LOW_RESOURCE" -eq 1 ]; then
  echo "  Low-resource mode: single build job, LTO disabled."
  export CARGO_BUILD_JOBS=1
  export CARGO_PROFILE_RELEASE_LTO=off
  export CARGO_PROFILE_RELEASE_CODEGEN_UNITS=16
  BUILD_PREFIX=(nice -n 19)
  if command -v ionice >/dev/null 2>&1; then
    BUILD_PREFIX=(ionice -c3 nice -n 19)
  fi
fi

BUILT=0
if ! truthy "${USE_PREBUILT:-}"; then
  if ( cd "${SRC}/server-rust" && "${BUILD_PREFIX[@]}" cargo build --release ); then
    install -m 0755 "${SRC}/server-rust/target/release/multisnake-server" "${APP_DIR}/multisnake-server"
    echo "  Installed ${APP_DIR}/multisnake-server (built from source)."
    BUILT=1
  else
    echo "  WARNING: building from source failed (common on very low-memory hosts)." >&2
  fi
else
  echo "  USE_PREBUILT set; skipping the source build."
fi

if [ "$BUILT" -eq 0 ]; then
  if ! fetch_prebuilt_binary; then
    echo "ERROR: no server binary could be built or downloaded." >&2
    echo "Try again with more RAM/swap, or check ${GITHUB_API_REPO} releases for" >&2
    echo "a matching prebuilt asset." >&2
    exit 1
  fi
fi

# The swap file (if we made one) only exists to get the compile above
# through without an OOM kill; nothing after this point is memory-hungry
# enough to need it. Left in place on the error exit above, in case a retry
# wants it. See install-lib/resources.sh; override with KEEP_SWAP=yes.
maybe_remove_swap

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
# 9. TLS (install-lib/tls.sh). Skipped entirely with ENABLE_TLS=no.
# ---------------------------------------------------------------------------
if [ "$ENABLE_TLS" = "yes" ]; then
  echo "[9/9] Setting up TLS for ${CHOSEN_DOMAIN} (Let's Encrypt, DNS-01 via Cloudflare)..."
  setup_tls
else
  echo "[9/9] ENABLE_TLS=no, skipping certbot. Serving plain HTTP on port 80."
fi

# Remember the hostname, port, sim rate, and (if TLS is on) the renewal-notice
# email so the next run can offer/reuse them. The email file is 0600 since an
# email address is mildly sensitive; the domain, port, and simhz files stay
# world-readable as before.
mkdir -p "${STATE_DIR}"
printf "%s\n" "${CHOSEN_DOMAIN}" > "${STATE_FILE}"
printf "%s\n" "${CHOSEN_PORT}" > "${PORT_FILE}"
printf "%s\n" "${CHOSEN_SIMHZ}" > "${SIMHZ_FILE}"
printf "%s\n" "${CHOSEN_MAXPLAYERS}" > "${MAXPLAYERS_FILE}"
printf "%s\n" "${CHOSEN_DEBUG}" > "${DEBUG_FILE}"
chmod 0644 "${STATE_FILE}" "${PORT_FILE}" "${SIMHZ_FILE}" "${MAXPLAYERS_FILE}" "${DEBUG_FILE}"
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

# Only written here, after every step above has succeeded, so its presence
# (or absence, on the next run) reliably tells install.sh -- and you --
# whether the last attempt actually finished. See the NOTICE check near the
# top of the script.
date -u +"%Y-%m-%dT%H:%M:%SZ" > "${INSTALL_OK_FILE}"
chmod 0644 "${INSTALL_OK_FILE}"

echo
echo "== Done =="
echo "Service status:  systemctl status multisnake"
echo "The app listens on 127.0.0.1:${CHOSEN_PORT} and Apache proxies ${CHOSEN_DOMAIN} to it."
echo "Server simulation rate: ${CHOSEN_SIMHZ} Hz."
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
