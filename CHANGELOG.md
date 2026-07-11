# Changelog

This file tracks real changes to this repository. For the rules on how entries
here should be written, see CHANGELOG_TEMPLATE.md.

### Initial game and deployment (round one)

1. Created the single-player browser Snake game as a self-contained HTML file with a canvas renderer, arrow key and WASD controls, wall and self collision, a score display, and restart after game over.
2. Replaced the fixed-rate game loop with a self-rescheduling timer so the tick delay can change during play. The game starts slower and speeds up as food is eaten, down to a configurable floor.
3. Replaced the single stored direction with a capped input buffer. Each turn is validated against the last queued direction rather than the committed one, which closes a reversal that could kill the snake when two keys were pressed inside one tick. The buffer holds at most two turns and drops no-op repeats.
4. Rebuilt the game as an authoritative multiplayer server in Node.js. One process holds the game state, serves the client, and exposes the captcha endpoints. The board supports one to four live players with no accounts.
5. Added a spectator queue for connections past the fourth player. A spectator takes over a freed slot after a short delay so they have time to take control. When four or fewer players are connected, a dead player simply respawns.
6. Added player-versus-player scoring. Running into another snake body kills the mover and awards the other player a 10 point bonus with 3 segments of growth. Head-on collisions kill both players with no bonus.
7. Added daily and all-time top 5 high score boards with arcade-style 3 letter initials entry, persisted to a JSON file. The daily board resets when the calendar date changes.
8. Added a simple math captcha that issues a one-time, short-lived token before a WebSocket connection is accepted. It is intended to sit behind a Cloudflare filter, which is expected to do the real bot filtering.
9. Fixed a spawn placement check that could drop a new snake on top of an existing one, so a fresh snake now spawns only where all three of its starting cells are clear.
10. Bound the Node process to 127.0.0.1 so it is not directly reachable, with Apache as the sole public entry point. Added a 30 second WebSocket keepalive ping because Cloudflare closes idle proxied WebSocket connections after about 100 seconds.
11. Added an Apache reverse-proxy virtual host on a dedicated hostname so the game does not collide with the existing static site served from another virtual host on the same server.
12. Added a systemd unit, a one-command install script, a one-command uninstall script, and setup documentation. The installer detects an existing checkout or clones the repository, installs Node.js when needed, deploys the app, creates an unprivileged service user, and adds the Apache virtual host without modifying existing sites. The uninstaller backs up the high score file before removing the app.
