#!/usr/bin/env bash
#
# install-lib/tls.sh - TLS via certbot's DNS-01 challenge (Cloudflare). All
# optional: skipped entirely by install.sh when ENABLE_TLS=no. Requires
# CHOSEN_DOMAIN, CF_CREDS_FILE, LE_SSL_FILE, CF_PROPAGATION, LAST_EMAIL,
# CHOSEN_PORT from install.sh.

# TLS inputs, gathered before any package installs so a missing token fails
# fast instead of after apt/cargo/deno work.
#   Email: CERTBOT_EMAIL wins; else optional prompt; blank registers without.
#   Cloudflare token: CF_API_TOKEN wins; else reuse an existing creds file if
#   one is already on disk from a previous run; else prompt (hidden). Without
#   a token and without an existing creds file, DNS-01 cannot proceed.
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

# Sets up TLS via certbot using the DNS-01 challenge (Cloudflare), with the
# Apache installer writing the :443 vhost and the 80->443 redirect. Called by
# install.sh only when ENABLE_TLS=yes. Guardrails:
#   - certbot and the two plugins are installed only if certbot is not
#     already present, so an existing certbot and its renewal schedule are
#     left alone. We never edit certbot.timer or /etc/cron.d/certbot;
#     installing the Debian package already provides a twice-daily renewal
#     timer covering every cert in /etc/letsencrypt/renewal/, including this
#     one. Renewal reuses the saved DNS-01 method, so no port 80 is needed.
#   - If a certificate for this hostname already exists,
#     --keep-until-expiring reuses it instead of requesting a new one.
#   - DNS-01 needs no inbound port 80, so the record can stay proxied
#     through Cloudflare (orange cloud).
setup_tls() {
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
  local email_arg
  if [ -n "$CERTBOT_EMAIL" ]; then
    email_arg=( -m "$CERTBOT_EMAIL" )
  else
    email_arg=( --register-unsafely-without-email )
  fi

  # DNS-01 authenticator with the Apache installer. The authenticator creates
  # the _acme-challenge TXT record via the Cloudflare API; the installer
  # writes the :443 vhost and redirect. --key-type ecdsa keeps modern
  # defaults.
  certbot --authenticator dns-cloudflare --installer apache \
    --dns-cloudflare-credentials "$CF_CREDS_FILE" \
    --dns-cloudflare-propagation-seconds "$CF_PROPAGATION" \
    -d "$CHOSEN_DOMAIN" \
    --non-interactive --agree-tos \
    --keep-until-expiring \
    --redirect \
    --key-type ecdsa \
    "${email_arg[@]}"

  # certbot may have (re)written the SSL vhost; make sure its proxy port is
  # correct, then test and reload.
  if [ -f "$LE_SSL_FILE" ]; then
    sed -i "s#127\.0\.0\.1:[0-9]\+#127.0.0.1:${CHOSEN_PORT}#g" "$LE_SSL_FILE"
  fi
  apache2ctl configtest
  systemctl reload apache2
  echo "  TLS is configured. The game is served on https://${CHOSEN_DOMAIN}"
}
