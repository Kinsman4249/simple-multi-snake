# simple-multi-snake

Browser-based multiplayer Snake. One authoritative server process (a compiled
Rust binary, built from `server-rust/`) holds the game state and serves the
client. Apache reverse-proxies a hostname you choose
to it, with TLS from Let's Encrypt. Up to eight live players share one board by
default -- the cap (maxPlayers) is configurable to taste and to the hardware you
run it on; extra connections wait in a spectator queue and are promoted when a
slot frees.

## Features

- Up to eight players on a shared board by default (the cap is configurable --
  see maxPlayers), no accounts.
- Couch co-op: a second local player can join on the same connection (p1 on
  arrow keys, p2 on WASD), taking a second slot on the same board.
- Leave button per local seat. Leaving exits that seat completely (it is not
  queued as a spectator); rejoin any time by pressing that seat's own keys or
  the Play/Add button. Leaving your last seat closes the connection and shows
  a rejoin screen instead of leaving a dead board on screen.
- Boost & momentum drift: hold the key of the direction you're already moving
  to speed up. Boost doesn't kick in instantly: a short tap does nothing at
  all (a hold-grace, so taps can't accidentally tag a queued turn with a
  drift), and once engaged the speed RAMPS up to full over a moment rather
  than snapping. Speed is real momentum: releasing the key does not stop you
  dead -- the snake decelerates over a moment (faster than it accelerated,
  but spanning multiple frames), and while it is still fast a turn skids
  exactly like a boosted one. Turning at speed turns your head immediately,
  but your body keeps skidding sideways in the old direction -- and the skid
  length scales with how fast you actually were when you turned (a
  barely-moving snake barely drifts). Rapid alternating turns chain skids.
  The skidding body clamps against walls and other snakes rather than dying,
  lays a trail of fading dust on every cell it slides through, and there is
  no wall-grace tick while you carry speed. A brief tip explaining this is
  shown on the join screen while the captcha is being solved. Configurable,
  and can be turned off entirely.
- Held-powerup glow: a snake carrying a powerup (or an armed wormhole charge)
  glows in that powerup's color -- visible to EVERYONE, not just the holder,
  so opponents can see what's coming and play around it. When a snake has
  BOTH a held powerup and an armed wormhole charge, the glow alternates
  between the two colors so neither ready cue is hidden. Cosmetic-only flag
  clientFx.heldGlow (default true).
- Powerups: pickups spawn on the board and fire the instant you collect them --
  the only exception is Speed Boost, which you hold and trigger with your seat's
  activation key (default Right Shift for the arrows seat, Space for the WASD
  seat). Wormhole is also held, as an independent charge, and auto-fires the
  instant a move would otherwise kill you (a wall, another snake, or your own
  body), teleporting you somewhere safe -- and the teleport THREADS: only the
  head exits at the destination, with the body following through the entry
  point segment by segment, so the snake visibly snakes through the wormhole
  instead of snapping across the board. The set: Wormhole, Growth Spurt,
  Speed Boost, Ice Trail, Poison Trail, Blue Shell (a fast projectile that
  hunts whoever is longest -- even the player who fired it. It phases straight
  through bodies and only detonates on the target's HEAD, so you cannot shield
  with your tail; it is faster than a plain boost, so it is almost impossible
  to dodge -- but a hold-boost stacked with the Speed Boost powerup can still
  outrun it. It never spawns and fizzles into food if collected when every
  snake is the same length, and it is much rarer while the leader is still
  short, since there is no meaningful leader to punish yet), and Banana Trail
  (lays
  pixel-art banana peels -- drawn as little bananas so they read distinctly on
  the board; any snake that slips on one, the layer included, has its
  controls REVERSED for a few seconds -- the status bar shows a "controls
  reversed" notice while it lasts). Each type has its own config block and
  on/off switch. A "What do the powerups do?" button on the join screen
  explains them, and every powerup can be disabled. See Configuration.
- Rubberbanding (silent catch-up, config block `rubberband`): food spawns
  biased toward the shortest living snake, and when the leader is at least
  30% longer than the next snake, Blue Shells spawn sooner and more often --
  pressure on the runaway leader from both ends. Both mechanics have their
  own enable switches and tuning knobs.
- Powerup feedback on the snake itself (clientFx.powerupFx, default true): a
  brief bright flash in the powerup's color when it fires, a jetstream while
  Speed Boost is active, and a built-in timer -- an active powerup tints the
  snake its color and that tint drains tail-first as the effect runs down, so
  the amount of colored snake is the time you have left.
- Rebindable activation keys and a WASD/Arrows swap, from a small panel in the
  bottom-left corner. Saved in the browser (localStorage); nothing is sent to
  the server but which seat activated.
- Mobile: swipe on the board to steer, with on-screen PWR and BOOST buttons
  that are always visible (they are play controls). The INFO overlays
  (leaderboard, top bar and its panels, status line) are HIDDEN by default so
  they never cover the board -- a small round toggle button at the bottom
  reveals or hides them on tap; swipe-steering and the PWR/BOOST buttons keep
  working throughout. The overlays start hidden again on every reload.
- Spectator queue past the player cap (eight by default, configurable). A
  spectator takes over shortly after a player dies; if the board is not full the
  dead player just respawns.
- Killing another player (they run into your body) gives you a 10 point bonus
  and grows your snake by 3 segments. Head-on collisions kill both, no bonus.
- Global speed scales with the AVERAGE snake length in the room (total length
  / number of snakes), saturating at a configurable cap and eased smoothly so
  growth or a join/leave never snaps the speed. One long snake alone runs as
  fast as four long snakes; one long + one short matches two mediums.
- Food and powerups scale with the number of players: food is ceil(players/2)
  items at once (1-2 players: 1, 3-4: 2, 5-6: 3, ...) and powerups
  max(1, ceil(players/4)) (1 up to four players, 2 at five to eight, ...),
  recomputed live as players join and leave.
- Daily and all-time top 5 high scores with arcade-style 3 letter initials --
  kept as TWO separate board pairs: "Single PC" (one computer: solo or
  couch co-op) and "Networked" (two or more computers), because those are
  different skills. The "Single PC" board is the uncontested / same-computer
  board; it is not tied to any specific machine, just distinct from networked
  play. A run is classified at death time by how many computers had players
  in the game, the hover panel shows both pairs with the current mode
  highlighted, and an existing single-board highscores.json migrates into the
  Single PC pair automatically (the networked boards start fresh).
  Initials are SESSION-BOUND: P1 enters them on the join screen (with the
  captcha) before playing, P2 at its first join, and a qualifying score is
  written to the boards automatically the moment the run ends -- there is no
  post-game prompt to interrupt anyone. A persistent INITIALS button in the
  top bar changes either seat's initials any time, no refresh needed. While
  any initials entry is on screen, game keys are fully suspended (typing
  "WAS" into a text box can never steer a snake or spawn P2), and a short
  grace after confirming absorbs trailing keypresses.
- Simple math captcha on join, intended to sit behind a Cloudflare filter.
- Client-side prediction with server reconciliation: local movement is
  responsive while the server stays authoritative for collisions, food, and
  score. Other players' snakes are smoothed between server updates in lock
  step with the server's own movement rate (cosmetic only; this does not
  change server-side collision or authority).
- Idle cleanup applies to active play too: if every living snake on the board
  goes quiet at once, the whole lobby is disconnected; one attentive player
  keeps the session alive for everyone else.
- An on-page DEBUG button shows per-module build stamps, the live server
  build (commit-derived, not hand-edited), and recent server corrections, so
  a stale or partial deploy is obvious. The operator can disable the debug
  system entirely (see enableDebug below) for zero added overhead.
- All gameplay tuning lives in config.json next to the server.

## Requirements

- Debian (tested against Debian 12 Bookworm).
- Apache 2.4 already installed and running. Other sites on the same server are
  fine; the installer only adds a new vhost.
- A hostname you control. For the default TLS path, the domain must be hosted
  on Cloudflare DNS and you need an API token scoped Zone:DNS:Edit for it.
- Root or sudo access.

## Install (one command)

Run this on the server as root. It installs the Rust toolchain (self-contained
under /opt/multisnake-toolchain) and Deno, builds the server binary and the
WASM renderer from source, deploys the app to /opt/multisnake, creates a
systemd service, adds a single Apache vhost, and by default obtains a Let's
Encrypt certificate. Existing sites are not modified. Node.js is no longer
used; a leftover install from an older version is ignored.

curl -fsSL https://raw.githubusercontent.com/Kinsman4249/simple-multi-snake/main/install.sh | sudo bash

The installer asks a few things interactively:

- Hostname to serve the game on. There is no default on the first run. On a
  later run it offers the previously used hostname; press Enter to reuse it.
- Server simulation rate in Hz. Defaults to 60 (or the last used value on a
  repeat run). Higher samples input more finely; it does not change snake speed.
- Cloudflare API token (input hidden), unless TLS is disabled or a token was
  already provided.

### Non-interactive install

Under the curl pipe there is no keyboard, so pass values as environment
variables:

curl -fsSL https://raw.githubusercontent.com/Kinsman4249/simple-multi-snake/main/install.sh \
  | sudo DOMAIN=snek.example.com CF_API_TOKEN=your_token SIM_HZ=60 bash

## Port selection

The app binds a loopback TCP port that Apache proxies to. The default is
8080. If that port is already taken (common on a host that already runs other
services) the installer automatically picks the next free port and points both
config.json ("port") and the Apache vhosts at it. The chosen port is saved to
/etc/multisnake/last-port and reused on later runs.

- Force a specific port with the PORT environment variable.
- After the service starts, the installer performs a health check against the
  chosen port. If the app does not answer, the install fails immediately with
  the relevant service logs rather than continuing to issue a certificate for a
  process that is not running.
- If an earlier install is detected as failed (for example a port clash that
  left the service crash-looping), the installer explains the problem, names
  the process currently holding the port, and offers to move the app to a free
  port and re-point the vhosts before continuing.
- Before that, the installer also scans every enabled Apache site for the
  distinctive /ws WebSocket ProxyPass line the vhost template writes, so it
  can find other multisnake-managed vhosts left over from a previous hostname
  or a manual edit, not just the immediately previous run. Any it finds are
  reported with the hostname and port each one points at, flagged as dead if
  nothing is listening on that port, and left alone by default; you are
  offered the option to remove the dead ones.

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
- CERTBOT_EMAIL: email for expiry/renewal notices. Blank registers without an
  email. On an interactive run, if you have provided one before, it is
  offered as the default (press Enter to reuse it) and saved to
  /etc/multisnake/last-email (chmod 600) for next time.
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

- simHz: server simulation rate in Hz (default 60). Higher samples input more
  finely (lower input latency) but does NOT change snake speed.
- grid.cols / grid.rows / grid.cellSize: board dimensions and pixel scale.
- move.startIntervalMs: milliseconds per cell at the slow base (an empty room,
  or snakes still at their spawn length). Higher is a slower start.
- move.minIntervalMs: fastest milliseconds per cell, the speed floor.
- move.lengthSaturation: the AVERAGE snake length at which the game reaches
  the fast floor (default 40). The global speed is a function of the average
  length across all living snakes (total length / number of snakes), NOT total
  length and NOT player count: equal averages give equal speed, and the curve
  saturates here so a very long average is no faster than a moderately long
  one. Set startIntervalMs == minIntervalMs for a constant speed.
- move.speedEaseMs: how long the actual speed takes to glide to a new target
  when the average length changes -- growth, or a join/leave that shifts the
  average (default 1000). Prevents a jarring speed jump on join/leave. 0
  applies target changes instantly.
- maxPlayers: number of active player slots before new joins go to spectate
  (default 8). ~16 is the realistic ceiling on a Google Cloud e2-micro
  free-tier instance (network fan-out and the 0.25 vCPU baseline bind before
  RAM does). The installer prompts for this and offers the last value.
- maxConcurrentFood: hard ceiling on simultaneous food items (default 8). The
  live count scales with players -- ceil(players / 2), so 1-2 players get 1
  food, 3-4 get 2, 5-6 get 3, and so on -- clamped to this. Set to 1 for the
  classic single-food board, or 0 to disable food entirely.
- maxLocalPlayers: how many local players one browser tab (one WebSocket
  connection) may control at once via couch co-op. Default 2 (p1 on arrow
  keys, p2 on WASD). Every local seat is round-robin fair on its own: adding
  one is only refused once this cap is reached, otherwise it either takes a
  free slot immediately or joins the spectator queue fairly like anyone
  else.
- killBonusScore / killBonusGrowth: points and growth awarded for a kill.
- minSnakeLength: the length a snake spawns at, and the floor below which
  poison-trail damage cannot shrink it (default 3). One value drives both so
  they can never disagree.
- spectatorPromoteDelayMs: delay before a non-qualifying dead player respawns
  or yields to the queue.
- captchaTokenTtlMs: how long a solved-captcha token stays valid before the
  WebSocket must be opened.
- wallGraceTicks: ticks a snake may stall against a wall waiting for a late but
  valid turn before the wall wins. 0 disables the grace.
- spectatorIdleMs: global spectator idle disconnect time.
- playerIdleMs: inactivity timeout for ACTIVE play (default 120000). If every
  currently-living snake on the board goes this long without any input, the
  idle connections are disconnected, same as the spectator idle rule. Any one
  player pressing a key resets the clock for the whole board; dying and
  auto-respawning does not reset it on its own, so an AFK player who keeps
  dying cannot dodge the timeout.
- joinOfferMs: time a queued spectator has to accept an open slot before the
  offer passes to the next spectator.
- inputBuffer: maximum queued turns per snake.
- boost.enabled: turns the boost/drift mechanic on or off (default true).
- boost.boostSpeed: multiplier on movement rate while boosting (default 2.0).
- boost.driftMs: the body's maximum skid time after a boosted turn (default
  250). The actual skid is driftMs scaled by the boost ramp progress at the
  moment the turn was pressed. Replaces the old slideDistance ("turn is
  delayed N cells") knob, which is now ignored if present.
- boost.holdGraceMs: how long the boost key must be HELD before boost engages
  at all (default 120). Below this, a tap neither speeds the snake up nor
  makes a queued turn drift. 0 restores instant engagement.
- boost.rampMs: once engaged, how long the speed multiplier takes to climb
  from 1x to boostSpeed (default 400). 0 restores an instant jump to full.
- boost.decelMs: how long a released boost takes to wind back down to base
  speed (default 250 -- faster than the ramp-up, but real momentum: the
  snake stays fast, and turns still skid, while it decays). 0 restores an
  instant stop on release.
- boost.driftThreshold: the momentum fraction (0..1 of the ramp) above which
  a turn starts a body skid (default 0.3). Speed-based, not key-based: a
  turn just after releasing boost still skids until the decay crosses this.
- clientFx.boostTrail / clientFx.slideDust: purely-cosmetic client visuals for
  a boosting head and the drift dust (one fading particle per cell a sliding
  body slides through; both default true). No gameplay effect.
- clientFx.heldGlow: the everyone-can-see-it glow around a snake holding a
  powerup or wormhole charge (default true). Cosmetic only -- the underlying
  heldPowerup/wormholeCharge fields were always in the shared broadcast.
- clientFx.powerupFx: the on-snake powerup cues (default true) -- the activation
  flash, the Speed Boost active jetstream, and the tail-drain duration timer.
  Cosmetic only; the activePct / activated fields it reads are server-computed.
- powerups.spawnIntervalMs: how often a pickup spawn is attempted (default 8000).
- powerups.maxConcurrentPickups: hard ceiling on pickups on the board at once
  (default 4). Like food, the live cap scales with players -- max(1,
  ceil(players / 4)), so 1-4 players get 1, 5-8 get 2, and so on -- clamped to
  this. Set to 1 to keep a single pickup regardless of player count.
- powerups.<type>.enabled: on/off per powerup type. Types: wormhole,
  growthSpurt, speedBoost, iceTrail, poisonTrail, blueShell, bananaTrail.
  All default on. Blue Shell additionally requires at least two people in
  the game AND a spread in snake lengths to spawn: a pickup collected while
  alone, or once every snake is the same length, fizzles into +1 growth
  (acts like food) instead of launching. Each type has its own tuning keys
  alongside enabled -- for
  example growthSpurt.durationMs / foodMultiplier / killBonusGrowth,
  speedBoost.durationMs / speedMult, iceTrail.slowMultiplierPerStack /
  minSpeedMultiplier / tileDurationMs, wormhole.lookaheadDepth,
  blueShell.segmentLossPercent / explosionRadius / splashLossPercent /
  speedRatio (projectile cadence as a fraction of the game move interval;
  lower = faster, 0.45 is ~2.2x a normal snake and dodgeable only with a
  boost + Speed Boost) / shortLeaderLength / shortLeaderFactor (spawn weight
  is multiplied by shortLeaderFactor while the leader is shorter than
  shortLeaderLength), and bananaTrail.invertDurationMs / tileDurationMs. See
  the powerups block in config.json for the full set and defaults.
- rubberband.foodBias: bias food placement toward the shortest living snake
  (enabled default true). A free cell within `radius` (default 15, Chebyshev)
  of the trailing snake's head is always accepted; farther cells only with
  probability 1/strength (default 3). Inert with one player or all-equal
  lengths.
- rubberband.shellPressure: when the longest snake is at least `leadRatio`
  (default 1.3, i.e. 30% longer) times the second-longest, Blue Shells spawn
  at spawnIntervalMs x intervalScale (default 0.5) and the spawn type roll
  weights blueShell at `typeWeight` (default 4) vs 1 for the others. Never
  overrides the two-player spawn gate.
- highscoresFile: filename (relative to the app directory) of the score
  store (default "highscores.json"). Mainly for tests, which point each
  server at its own temp file. The file holds both board pairs
  ({ version: 2, modes: { local, networked } }); a flat pre-split file is
  migrated automatically.
- enableDebug: master switch for the debug system (default true). When set
  to false, the server never builds or logs a debug line (a single null
  check at every call site) and the client never constructs the DEBUG
  button, panel, or correction-recording hooks at all.
- clientRender.interpolate: smooths other players' on-screen movement between
  server updates at the server's own known movement rate (default true).
  Purely cosmetic; server-side collision and authority are unaffected. Set to
  false for the old grid-snapped, no-interpolation look.
- clientRender.renderer: which client draw path to use -- "auto" (default:
  the WebAssembly renderer, falling back to the plain 2D renderer if the
  wasm artifact is missing or fails to load), "wasm" (same as auto today),
  or "2d" (force the fallback; the operator kill-switch, no redeploy
  needed). A player can also override per-session with ?renderer=2d in the
  URL. See "The WASM renderer" below.

The listening port IS in config.json ("port", default 8080), written at
install time; the PORT environment variable overrides it at runtime. To
change it, re-run the installer with PORT set.

## The WASM renderer

The per-frame draw logic lives in a WebAssembly module written in
AssemblyScript (`wasm/renderer.ts`): JS encodes each server snapshot into the
module's linear memory once per broadcast, writes a small per-frame effects
block, and the module emits an ordered instance buffer of colored shapes that
a thin executor plays onto the canvas's 2D context. Rendering stays
requestAnimationFrame-driven, i.e. vsync-paced -- the wasm work happens
inside the same frame callback.

Why the executor is the 2D canvas context and not WebGL: both were
benchmarked on real hardware (`tools/bench/`), and GPU-accelerated canvas 2D
beat a WebGL2 instanced-quad pipeline on this flat-tile workload at every
board size -- decisively at the 4k preset. The instance-buffer architecture
is executor-agnostic, so a WebGL executor could be swapped in later without
touching the wasm module.

The compiled artifact (`public/js/render-wasm.js`, the wasm embedded as
base64 inside a plain JS file) is deliberately NOT committed to the repo:
`install.sh` and the release workflow build it from source, so what a host
serves is verifiably compiled from the sources in the tree. Rebuild it any
time with either runtime:

    deno run -A tools/build-wasm.mjs

(The pinned AssemblyScript compiler is fetched through deno's npm support on
first run.) A checkout WITHOUT the artifact still works: the
render facade (`public/js/render.js`) detects the missing file and falls
back to the complete pre-wasm 2D renderer (`public/js/render2d.js`).
Verification lives in `tools/bench/`: `run-bench.js` (frame-time benchmark),
`run-parity.js` via `parity.html` (pixel-diffs the wasm path against the 2D
fallback on frozen-clock scenes), and `run-smoke.js` (joins the live game
headless and asserts each renderer actually draws).

## Netcode and debugging

The client predicts its own movement and reconciles against the authoritative
server using input acknowledgments. Each turn the client sends carries a
sequence id; the server stamps the last sequence it processed into each
snapshot, and the client drops acknowledged inputs and replays only the
unacknowledged ones on top of the authoritative body. The server remains
authoritative for collisions, food, and score, and only overrides the client
position on a real conflict such as a death or a respawn.

A DEBUG button on the page toggles a panel that shows each client module build
stamp, the server build, the current sequence and tick, the pending input
buffer, whether each local seat is currently boosting, and the most recent
server corrections. Recording is off until the panel is opened so there is no
cost during normal play. After any deploy, open the panel and confirm every
build stamp matches the version you deployed before judging behavior; a stale
Cloudflare edge cache serving old JS is the most common cause of "it did not
change." Set enableDebug to false in config.json to remove the debug system
entirely, client and server, if you don't want it available at all.

The server build shown is resolved automatically, not hand-edited: a live git
checkout reports its commit count and short hash (so it changes every commit),
a release archive built by `git archive` (see the Release workflow) carries a
build-info.json stamped with the tag and commit at packaging time, and a bare
copy with neither falls back to the package.json version marked "dev".

## Manual install

The one-command installer above is the recommended path and handles everything:
hostname selection, sim rate, free-port selection, the systemd service, the
Apache vhost, and TLS. This section is for doing it by hand or understanding
what the installer does. Replace YOUR_HOST with your hostname throughout.

### 1. Toolchains (Rust to build the server, Deno to build the renderer)

sudo apt update
sudo apt install -y curl git ca-certificates build-essential unzip
curl --proto '=https' --tlsv1.2 -fsSL https://sh.rustup.rs | sh -s -- -y --profile minimal
source "$HOME/.cargo/env"
curl -fsSL https://deno.land/install.sh | DENO_INSTALL=/usr/local sh -s -- -y

### 2. Build and deploy the app

deno run -A tools/build-wasm.mjs
( cd server-rust && cargo build --release )
sudo mkdir -p /opt/multisnake/public
sudo cp server-rust/target/release/multisnake-server /opt/multisnake/
sudo cp config.json package.json /opt/multisnake/
sudo cp -r public/. /opt/multisnake/public/

The first line compiles the WASM renderer from source into
`public/js/render-wasm.js` (see "The WASM renderer") BEFORE the `public/`
copy, so the artifact deploys with the rest of the client. Skipping it is
not fatal -- the client falls back to the plain 2D renderer -- but it is the
intended, faster draw path. The second line compiles the game server itself;
all the game logic is inside the resulting `multisnake-server` binary, so
there are no server-side JS trees or npm dependencies to deploy.

Use `cp -r public/.` (everything under `public/`), not `cp public/index.html`
alone. The client is split across `public/index.html` and `public/js/*.js`
(`net.js`, `predict.js`, `render.js`, `ui.js`, `main.js`); copying only
`index.html` leaves the game unable to load and every module 404ing in the
browser console, even though the server process itself comes up fine.

package.json is still copied: the server reads its "version" field for the
build stamp (it is data now, not a Node manifest).

### 3. Choose the listening port

The app defaults to 8080; the "port" key in config.json (or a PORT
environment variable on the service) overrides it. If 8080 is already used
by another service, check what holds it and pick a free port:

sudo ss -ltnp | grep ':8080'
# then set "port": 8091 in /opt/multisnake/config.json

Use the same port everywhere below in place of 8080.

### 4. Service account and permissions

sudo useradd --system --no-create-home --shell /usr/sbin/nologin multisnake
sudo chown -R multisnake:multisnake /opt/multisnake

### 5. systemd service

sudo cp deploy/multisnake.service /etc/systemd/system/multisnake.service
sudo systemctl daemon-reload
sudo systemctl enable --now multisnake
sudo systemctl status multisnake

Confirm the app is listening before continuing. This catches a port clash early,
before Apache and TLS are set up:

curl -sI http://127.0.0.1:8080/            # expect HTTP/1.1 200 OK
curl -sI http://127.0.0.1:8080/js/main.js  # expect HTTP/1.1 200 OK

Check both. The first only proves the server process is up and index.html is in
place; it will return 200 even if the public/js files from step 2 never made
it onto disk, which is exactly the failure mode that produces a working-looking
service with a broken game in every browser. The installer runs this same
second check automatically after every install.

If the service is failed or the port is in use, check the logs, pick a different
port, redo step 3, and restart:

sudo journalctl -u multisnake -n 20 --no-pager
sudo systemctl restart multisnake

### 6. Apache reverse proxy

sudo a2enmod proxy proxy_http proxy_wstunnel
sudo sed -e 's/fillmeout.example.com/YOUR_HOST/g' \
  deploy/fillmeout.example.com.conf \
  > /etc/apache2/sites-available/YOUR_HOST.conf
sudo a2ensite YOUR_HOST.conf
sudo apache2ctl configtest
sudo systemctl reload apache2

If you changed the port in step 3, also replace 127.0.0.1:8080 with your port in
the generated vhost before enabling it.

### 7. TLS with Let's Encrypt (DNS-01 via Cloudflare)

DNS-01 needs no inbound port 80, so the record can stay proxied through
Cloudflare. You need a Cloudflare API token scoped Zone:DNS:Edit for the zone.

sudo apt install -y certbot python3-certbot-apache python3-certbot-dns-cloudflare

sudo mkdir -p /etc/letsencrypt
sudo sh -c 'umask 077; printf "dns_cloudflare_api_token = %s\n" "YOUR_TOKEN" \
  > /etc/letsencrypt/cloudflare-YOUR_HOST.ini'
sudo chmod 600 /etc/letsencrypt/cloudflare-YOUR_HOST.ini

sudo certbot --authenticator dns-cloudflare --installer apache \
  --dns-cloudflare-credentials /etc/letsencrypt/cloudflare-YOUR_HOST.ini \
  --dns-cloudflare-propagation-seconds 30 \
  -d YOUR_HOST \
  --non-interactive --agree-tos --keep-until-expiring --redirect \
  --key-type ecdsa -m you@example.com

The Apache plugin writes the :443 vhost (YOUR_HOST-le-ssl.conf) and the 80 to
443 redirect. If you changed the app port, confirm the SSL vhost proxies to the
right port, since certbot copies the proxy directives from the :80 vhost:

grep -i proxypass /etc/apache2/sites-available/YOUR_HOST-le-ssl.conf

Installing certbot provides a systemd timer that renews all certificates twice
daily. No cron entry is needed and none should be added.

### 8. DNS and verify

Point an A record for YOUR_HOST at this server public IP (it can stay Proxied),
make sure port 443 is reachable, then open https://YOUR_HOST in a browser.

The vhost is a template. The installer copies deploy/fillmeout.example.com.conf
and replaces the placeholder hostname and the placeholder port (8080) with the
values chosen at install, writing the result to
/etc/apache2/sites-available/<hostname>.conf. There is no per-domain vhost
committed to the repo.

## Notes and limitations

- Blue Shell is on by default and fires the instant it is picked up. It
  launches a seeking projectile at the current leader (including the player
  who fired it -- guarding the shell is the leader's counterplay), deals a
  large direct hit and a smaller splash to nearby snakes, and is consumed on
  impact. It never spawns with fewer than two people in the game, and a
  pickup collected while alone fizzles into +1 growth.
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

- Rust installation via rustup: https://rustup.rs
- Deno installation: https://docs.deno.com/runtime/getting_started/installation/
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
