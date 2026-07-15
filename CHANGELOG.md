# Changelog

Note: this is a new entry to merge into the existing CHANGELOG.md at the
repo root. I do not have the current file's contents in this session, so
this is written to prepend, not replace. Pick the version number to match
whatever release.yml tag-push scheme is already in use.

## [Unreleased] - 2026-07-14

### Fixed (predict.js: 2026-07-12.13 -> 2026-07-12.20)

- **.15** - `rebuild()` no longer advances the local body when there are no
  unacknowledged inputs (was the .13 jitter regression: it kept advancing
  using the last known direction even with nothing queued, leaving the head
  a constant one cell ahead and wobbling on snapshot timing and turns).
- **.16** - Prediction bounded to exactly one cell ahead of the
  authoritative body, always. The .15 fix had replayed one cell per queued
  input, which caused a visible multi-cell jump whenever two turns queued up
  before the first was acked. Also added a `predicted` flag so the debug
  panel no longer logs a false "reconciled" correction on ordinary
  straight-line movement with an empty input buffer (there was no
  prediction to validate in that case; comparing stale state against a
  naturally-advanced snapshot is not a misprediction).
- **.17** - Single-cell prediction switched from the newest queued turn to
  the oldest (FIFO). The server applies queued turns in receipt order, so
  predicting off the newest turn guessed a direction the server had not
  reached yet whenever two turns queued up before the first was acked,
  producing spurious diagonal (perpendicular-direction) resyncs during
  ordinary rapid turning.
- **.18** - Mirrored the server's wall-grace lookahead
  (`consumeInboundsTurn` in server.js) client-side: if the oldest queued
  turn would leave the grid, scan the remaining queued turns for the first
  one that stays in bounds, same as the server does, instead of guessing a
  direction the server was never going to use. Eliminated the diagonal
  resyncs that were clustering near map edges.
- **.19** - An input that exhausts all its retries without ever being acked
  (most likely a dropped WebSocket frame that never reached the server) is
  now dropped from the local queue instead of sitting at the front forever.
  Left in place, a permanently-unconfirmable entry poisoned every future
  one-cell prediction (always anchored on the oldest queued entry) and the
  food-eat check, which explained both the sustained mid-board resyncs and
  the "walked over food, nothing happened" reports.
- **.20** - Correction detection (predicted-vs-actual head mismatch) now
  runs unconditionally instead of only while the debug panel is open, so
  the new correction-glide client effect (see Added) works regardless of
  debug state. Debug-panel logging itself is unchanged, still gated on
  `setDebug(true)`.

### Fixed (server.js: 2026-07-12.14 -> 2026-07-12.15)

- **.15** - `socket.setNoDelay(true)` set on the raw TCP socket during the
  WebSocket upgrade, disabling Nagle's algorithm for this connection.
  Removes one source of avoidable added latency on the frequent small
  writes (state broadcasts, dir messages) this game makes; does not affect
  propagation delay or Cloudflare/network-hop latency.

### Added

- **clientFx config** (`config.json`, `server.js` 2026-07-12.16): new
  `clientFx` block (`inputFlash`, `inputFlashMs`, `correctionGlide`,
  `correctionGlideMs`), defaulted on. Served read-only via a new
  `GET /api/config` endpoint. Purely cosmetic, server-controlled, global
  on/off per effect -- not user-configurable, no client-side prompt.
- **Input flash** (`main.js`, `render.js`): the instant a keypress is
  accepted, a short fading strip is drawn on the leading edge of the
  player's own head cell in the pressed direction. Driven entirely by
  elapsed wall-clock time since the keypress, independent of network ticks
  or whether the body actually steps that tick.
- **Correction glide** (`predict.js`, `main.js`, `render.js`): on the rare
  tick where the local prediction didn't match the server's actual head,
  the player's own head eases from the mispredicted cell to the corrected
  cell over `correctionGlideMs` instead of hard-snapping. This is a
  deliberate, narrowly-scoped exception to the project's grid-snapped,
  no-interpolation rendering rule -- it applies only to the local player's
  own head cell, only during the correction window, only when enabled.
  Every other segment, every other player, and every other frame remain
  exactly grid-snapped as before.

### Notes

- Considered and rejected: letting the client self-report "uncontested"
  moves (not touching food/walls/other snakes) and having the server only
  validate contested ones. Rejected because (a) it doesn't reduce latency
  at all -- the server still can't approve a packet it hasn't received yet,
  contested or not -- and (b) it trades the server's current full
  authority (nobody can fake a score) for a real cheating surface, which
  matters even for a friends-only deployment since Daily/All-Time
  leaderboards persist. Server remains authoritative for all positions,
  always.
- No new files were added to the repository tree; all changes are to
  existing files at their existing flat-file-mapped paths.
- 19 headless regression tests (Node, no browser) were run across this
  session's changes with no failures. They currently live only as ad hoc
  scripts, not committed to the repo -- see TODO.md.
