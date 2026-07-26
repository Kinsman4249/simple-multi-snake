# Features

## Players

- Up to 8 players on one shared board by default (`maxPlayers`, configurable). No accounts.
- Couch co-op: a second local player can join on the same connection (p1 arrow keys, p2 WASD).
- Spectator queue past the player cap; a spectator is promoted shortly after a slot opens.
- Leave button per local seat -- rejoin any time with that seat's own keys. Leaving your last seat shows a rejoin screen.
- Idle cleanup: if every living snake goes quiet at once, the whole lobby is disconnected; one active player keeps it alive for everyone.

## Movement

- Boost & momentum drift: hold your direction key to speed up. A short tap does nothing (hold-grace); once engaged, speed ramps up and decays back down rather than snapping. Turning at speed skids the body sideways, scaled to how fast you were going. Configurable, can be disabled entirely.
- Global speed scales with the *average* snake length in the room, eased smoothly so growth or a join/leave never snaps the speed.
- Client-side prediction with server reconciliation: local movement feels responsive; the server stays authoritative for collisions, food, and score.

## Powerups

Pickups spawn on the board and fire on contact, except Speed Boost and Wormhole, which are held and trigger on demand (activation key, or on-death for Wormhole).

- **Wormhole** -- auto-fires the instant a move would kill you, teleporting you to safety. The body threads through the portal segment by segment instead of snapping across the board.
- **Scissors** -- a second, fallback self-save charge, only tried after Wormhole has already failed to save you. On a self-collision it cuts off your own tail at the impact point instead of killing you (the severed tail scatters as pinata food); on hitting a dynamic wall it shatters that wall piece and reroutes you around it. If an opponent runs into a scissors-armed snake's body, *they* get cut off there instead of scoring a kill.
- **Growth Spurt**, **Speed Boost**, **Ice Trail**, **Poison Trail** -- standard buff/debuff pickups, each with its own config block.
- **Blue Shell** -- a fast homing projectile aimed at the current leader (even the player who fired it). Phases through bodies, only detonates on the head, dealing a large direct hit -- plus a smaller splash to any other snake caught within the blast radius. Needs 2+ players and a length spread to spawn; fizzles into food otherwise.
- **Banana Trail** -- lays peels that reverse controls for a few seconds on contact.

A held or armed powerup glows on the snake's body, visible to everyone. Every powerup type has its own on/off switch; see `config.json`.

## Board hazards and bounties

- **Dynamic walls** -- pentomino-shaped 5-cell obstacle pieces spawn periodically, biased toward the leader's position. Each telegraphs (flashes a warning) before going solid, then despawns after a lifetime -- or shrinks away early as the player pool thins, so a nearly-empty board never stays cluttered.
- **Pinata bounty food** -- when a sufficiently long snake dies (or a Scissors self-cut severs its tail), its body bursts into short-lived bonus food scattered around the death point, biased toward whichever players are trailing or scoring lowest. Uneaten candy expires after a few seconds.

## Rubberbanding

Silent catch-up, both independently toggleable:

- Food spawns biased toward the shortest living snake.
- Once the leader is 30%+ longer than the runner-up, Blue Shells spawn sooner and more often.

## Scoring

- A kill (running another snake into your body) gives +10 points and +3 growth. Head-on collisions kill both, no bonus.
- Food and powerup counts scale with player count, recomputed live as players join and leave.
- Daily and all-time top-5 high scores, kept as two separate boards: **Single PC** (solo or couch co-op) and **Networked** (2+ computers) -- different skills, judged separately. Initials are session-bound (entered once at join) and a qualifying score is written automatically at death, no post-game prompt.
- A third, independent leaderboard tracks **food-eaten-per-minute** as a speed-run mode, shown alongside the length-based boards with its own daily/all-time pair.

## Client

- Simple math captcha on join (meant to sit behind a Cloudflare filter, not stop a determined bot).
- Rebindable activation keys and a WASD/Arrows swap, saved locally.
- Mobile: swipe to steer, always-visible PWR/BOOST buttons; the info overlays (leaderboard, top bar, status) start hidden and toggle on tap so they never block the board.
- On-page DEBUG button: per-module build stamps, live server build, recent corrections -- catches a stale deploy at a glance. Can be fully disabled server-side (`enableDebug: false`) for zero overhead.
- All gameplay tuning lives in `config.json` -- see the README's Configuration section.
