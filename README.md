# simple-multi-snake

Browser-based multiplayer Snake. One authoritative Node.js process holds the
game state and serves the client. Apache reverse-proxies a hostname you choose
to it, with TLS from Let's Encrypt. Up to four live players share one board;
extra connections wait in a spectator queue and are promoted when a slot frees.

## Features

- One to four players on a shared board, no accounts.
- Spectator queue past four players. A spectator takes over shortly after a
  player dies; if four or fewer are connected the dead player just respawns.
- Killing another player (they run into your body) gives you a 10 point bonus
  and grows your snake by 3 segments. Head-on collisions kill both, no bonus.
- Speed starts slow and ramps up over time to a configurable floor.
- Daily and all-time top 5 high scores with arcade-style 3 letter initials.
- Simple math captcha on join, intended to sit behind a Cloudflare filter.
- All gameplay tuning lives in config.json next to the server.

## Requirements

- Debian (tested against Debian 12 Bookworm).
- Apache 2.4 already installed and running. Other sites on the same server are
  fine; the installer only adds a new vhost.
- A hostname you control. For the default TLS path, the domain must be hosted
  on Cloudflare DNS and you need an API token scoped Zone:DNS:Edit for it.
- Root or sudo access.

## Install (one command)

Run this on the server as root. It installs Node.js, deploys the app to
/opt/multisnake, creates a systemd service, adds a single Apache vhost, and by
default obtains a Let's Encrypt certificate. Existing sites are not modified.

    curl -fsSL https://raw.githubusercontent.com/Kinsman4249/simple-multi-snake/main/install.sh | sudo bash

The installer asks two things interactively:

- Hostname to serve the game on. There is no default on the first run. On a
  later run it offers the previously used hostname; press Enter to reuse it.
- Cloudflare API token (input hidden), unless TLS is disabled or a token was
  already provided.

### Non-interactive install

Under the curl pipe there is no keyboard, so pass values as environment
variables:

    curl -fsSL https://raw.githubusercontent.com/Kinsman4249/simple-multi-snake/main/install.sh \
      | sudo DOMAIN=snek.example.com CF_API_TOKEN=your_token bash

## TLS (Let's Encrypt via DNS-01)

By default the installer uses the DNS-01 challenge through the Cloudflare API,
then lets the Apache plugin write the :443 vhost and an 80 to 443 redirect. The
game is served on 443.

DNS-01 does not need inbound port 80, so the DNS record can stay Proxied
(orange cloud) through Cloudflare. This is why DNS-01 is the default rather than
the HTTP-01 (port 80) challenge, which fails when Cloudflare proxying or
"Always Use HTTPS" intercepts the challenge request.

### Cloudflare API token

Create a token in the Cloudflare dashboard:

- My Profile > API Tokens > Create Token.
- Use the "Edit zone DNS" template.
- Under Zone Resources, scope it to the specific zone (the parent domain, not
  the subdomain). The token then covers subdomains of that zone.

Supply it as CF_API_TOKEN, or let the installer prompt for it. It is written to
/etc/letsencrypt/cloudflare-<hostname>.ini with mode 600 and reused
automatically at each renewal. Certbot records the path but does not copy the
contents, so the file must remain in place.

### TLS-related environment variables

- ENABLE_TLS: "yes" (default) or "no". Set to "no" to skip certbot entirely,
  for example when you terminate TLS at Cloudflare with an Origin Certificate.
- CF_API_TOKEN: Cloudflare token with Zone:DNS:Edit on the zone.
- CERTBOT_EMAIL: email for expiry notices. Blank registers without an email.
- CF_PROPAGATION: seconds to wait for DNS propagation before validation.
  Default 30.

### Renewal

Installing certbot on Debian provides a systemd timer that renews every
certificate twice daily. The installer never edits that timer or any cron job.
Because the DNS-01 method and the credentials path are saved in the renewal
configuration, renewals re-run the Cloudflare challenge automatically with no
port 80 involved.

### After install: DNS

- Point an A record for your hostname at this server public IP.
- With the default DNS-01 TLS path, the record can stay Proxied (orange cloud).
- Port 443 must be reachable for players to connect.

Then open https://your-hostname in a browser.

## Uninstall (one command)

    curl -fsSL https://raw.githubusercontent.com/Kinsman4249/simple-multi-snake/main/uninstall.sh | sudo bash

The uninstaller reads the hostname from the installer state file, so it removes
the correct vhost, certificate, and Cloudflare credentials file no matter which
domain was used. It backs up high scores to /root first. The shared certbot
renewal timer and any other certificates are left untouched.

Add --purge to also delete the service user:

    curl -fsSL https://raw.githubusercontent.com/Kinsman4249/simple-multi-snake/main/uninstall.sh | sudo bash -s -- --purge

Set REMOVE_CERT=no to keep the certificate and its Cloudflare credentials.

## Configuration

Edit /opt/multisnake/config.json, then restart:

    sudo systemctl restart multisnake

Keys:

- grid.cols / grid.rows / grid.cellSize: board dimensions and pixel scale.
- speed.startTickMs: starting delay per step. Higher is a slower start.
- speed.minTickMs: fastest allowed delay, the speed cap.
- speed.rampIntervalSec / speed.rampStepMs: how often and by how much the
  delay shrinks over time.
- maxPlayers: number of active player slots before new joins go to spectate.
- respawnDelayMs / spectatorPromoteDelayMs: timing for respawn and takeover.
- killBonusScore / killBonusGrowth: points and growth awarded for a kill.
- captchaTokenTtlMs: how long a solved-captcha token stays valid before the
  WebSocket must be opened.

## Operating the service

    sudo systemctl status multisnake      # health and recent logs
    sudo journalctl -u multisnake -f      # follow live logs
    sudo systemctl restart multisnake     # apply a config change

The app binds to 127.0.0.1:8080 only. Apache is the sole public entry point.

## Repository layout

    .
    |-- server.js                         authoritative game server
    |-- config.json                       gameplay tuning
    |-- package.json                      npm metadata and the ws dependency
    |-- public/
    |   `-- index.html                    game client served to browsers
    |-- deploy/
    |   |-- multisnake.service            systemd unit
    |   `-- fillmeout.example.com.conf    Apache vhost template (installer fills in the hostname)
    |-- install.sh                        one-command installer
    |-- uninstall.sh                      one-command uninstaller
    |-- INSTALL.md                        manual step-by-step install notes
    |-- CHANGELOG.md
    |-- CODE_OF_CONDUCT.md
    |-- CONTRIBUTING.md
    |-- SECURITY.md
    `-- .github/
        |-- ISSUE_TEMPLATE/
        |   |-- bug_report.md
        |   `-- feature_request.md
        |-- PULL_REQUEST_TEMPLATE.md
        `-- workflows/
            `-- release.yml

The vhost is a template. The installer copies deploy/fillmeout.example.com.conf
and replaces the placeholder hostname with the one you enter, writing the result
to /etc/apache2/sites-available/<hostname>.conf. There is no per-domain vhost
committed to the repo.

## Notes and limitations

- A 30 second WebSocket keepalive ping is built into the server because
  Cloudflare closes idle proxied WebSocket connections after about 100 seconds.
- Dead snake bodies are drawn until respawn but are not solid obstacles; the
  collision check only considers live snakes.
- The captcha stops naive scripted joins only. Cloudflare is expected to do the
  real bot filtering in front of it.
- The Cloudflare token grants DNS edit rights for the zone. Protect the
  credentials file (the installer sets mode 600) and prefer the hidden prompt
  over pasting the token into a shell command, which can land in shell history.

## External references

- Node.js on Debian via NodeSource: https://github.com/nodesource/distributions
- Apache WebSocket proxying (mod_proxy_wstunnel):
  https://httpd.apache.org/docs/2.4/mod/mod_proxy_wstunnel.html
- Cloudflare WebSocket support:
  https://developers.cloudflare.com/network/websockets/
- certbot Cloudflare DNS plugin:
  https://certbot-dns-cloudflare.readthedocs.io/en/stable/
- Creating a Cloudflare API token:
  https://developers.cloudflare.com/fundamentals/api/get-started/create-token/

## License and conduct

See CODE_OF_CONDUCT.md, CONTRIBUTING.md, and SECURITY.md.
