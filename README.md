# simple-multi-snake

Browser-based multiplayer Snake. One authoritative Node.js process holds the
game state and serves the client. Apache reverse-proxies a dedicated hostname
to it. Up to four live players share one board; extra connections wait in a
spectator queue and are promoted when a slot frees up.

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
- Apache 2.4 already installed and running, with at least one other site is fine.
- A hostname you control, pointed at this server through Cloudflare.
- Root or sudo access.

## Install (one command)

Run this on the server as root. It installs Node.js, deploys the app to
/opt/multisnake, creates a systemd service, and adds a single new Apache vhost.
Existing sites are not modified.

    curl -fsSL https://raw.githubusercontent.com/Kinsman4249/simple-multi-snake/main/install.sh | sudo bash

To use a different hostname, set DOMAIN first. You must ship a matching vhost
file named <domain>.conf in the deploy/ directory (copy the provided one and
change ServerName):

    curl -fsSL https://raw.githubusercontent.com/Kinsman4249/simple-multi-snake/main/install.sh | sudo DOMAIN=snek.example.com bash

### After install: Cloudflare DNS

The installer cannot touch your DNS. Do this once by hand:

- Add an A record for the host part of your domain pointing to this server
  public IP.
- Keep it Proxied (orange cloud). Cloudflare proxies WebSockets on all plans
  with no extra configuration.
- Recommended SSL/TLS mode is Full (strict) with a Cloudflare Origin
  Certificate installed on Apache and a matching *:443 vhost.

Then open https://your-domain in a browser.

## Uninstall (one command)

    curl -fsSL https://raw.githubusercontent.com/Kinsman4249/simple-multi-snake/main/uninstall.sh | sudo bash

Add --purge to also delete the service user. High scores are backed up to
/root before removal either way:

    curl -fsSL https://raw.githubusercontent.com/Kinsman4249/simple-multi-snake/main/uninstall.sh | sudo bash -s -- --purge

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
    |   `-- snek.ethanantonio.com.conf    Apache vhost (rename per your domain)
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

## Notes and limitations

- A 30 second WebSocket keepalive ping is built into the server because
  Cloudflare closes idle proxied WebSocket connections after about 100 seconds.
- Dead snake bodies are drawn until respawn but are not solid obstacles; the
  collision check only considers live snakes.
- The captcha stops naive scripted joins only. Cloudflare is expected to do the
  real bot filtering in front of it.

## External references

- Node.js on Debian via NodeSource: https://github.com/nodesource/distributions
- Apache WebSocket proxying (mod_proxy_wstunnel):
  https://httpd.apache.org/docs/2.4/mod/mod_proxy_wstunnel.html
- Cloudflare WebSocket support:
  https://developers.cloudflare.com/network/websockets/

## License and conduct

See CODE_OF_CONDUCT.md, CONTRIBUTING.md, and SECURITY.md.
