// ============================================================
// Shared mutable game state + the small board/snake primitives that
// operate directly on it. Everything mutable lives on the single exported
// S object (S.slots, S.food, S.trails, ...) so every module reads and
// writes THE SAME state -- reassignments like `S.trails = S.trails.filter`
// stay visible everywhere, which plain destructured bindings would break.
// ============================================================
const { CFG, MOVE, MIN_SNAKE_LENGTH, DIR_VECTORS, TEST_SPAWNS, RUBBERBAND } = require("./config");

const S = {
  slots: new Array(CFG.maxPlayers).fill(null),
  spectatorQueue: [],
  connections: new Map(),
  food: null,
  sessionStart: null,
  joinOffer: null,
  // Powerups: pickups on the board (like food, but multi-entity) and laid
  // trails (ice/poison). Both are separate from any snake's body -- neither
  // permanently modifies board cells. One trail entry per (x,y): a later lay
  // on an occupied cell replaces it rather than stacking (confirmed design).
  powerupPickups: [],      // [{ id, type, x, y }]
  trails: [],              // [{ id, type, x, y, ownerSlot, expiresAtTick }]
  blueShells: [],          // [{ id, x, y, ownerSlot, moveAccumMs }]
  explosions: [],          // one-shot, broadcast once then cleared: [{ x, y, radius }]
  nextPowerupId: 1,
  lastPowerupSpawnAt: null,
  moveSeq: 0,              // counts MOVEMENT ticks (used as network seq)
  lastSimAt: null,
  nextSimAt: null
};

function cellFree(x, y, ignoreSlotIndex = -1) {
  for (let i = 0; i < S.slots.length; i++) {
    const s = S.slots[i];
    if (!s || i === ignoreSlotIndex) continue;
    if (s.body.some(seg => seg.x === x && seg.y === y)) return false;
  }
  return true;
}
// Food placement. Uniform rejection sampling over free cells -- except when
// the rubberband food bias is active (>= 2 living snakes with a real length
// gap): then a free candidate within `radius` (Chebyshev) of the TRAILING
// snake's head is always accepted, while a farther one is only accepted with
// probability 1/strength, so food lands near whoever is behind more often.
// The catch-up mechanic is silent by design (maintainer, 2026-07-16).
// Bounded: hard 500-attempt cap with a first-free-cell fallback (bias is
// abandoned past 300 attempts), plus a full-board scan if sampling never hit
// a free cell -- the pre-split placeFood loop was uncapped and could
// in principle spin on a pathologically full board.
function placeFood() {
  const fb = RUBBERBAND.foodBias;
  let target = null;
  if (fb.enabled) {
    const ti = currentTrailingIndex();
    const li = currentLeaderIndex();
    if (ti != null && li != null && ti !== li &&
        S.slots[li].body.length > S.slots[ti].body.length) {
      target = S.slots[ti].body[0];
    }
  }
  let chosen = null, fallback = null;
  for (let attempts = 0; attempts < 500; attempts++) {
    const x = Math.floor(Math.random() * CFG.grid.cols);
    const y = Math.floor(Math.random() * CFG.grid.rows);
    if (!cellFree(x, y) || S.powerupPickups.some(p => p.x === x && p.y === y)) continue;
    if (!fallback) fallback = { x, y };
    if (!target || attempts >= 300) { chosen = { x, y }; break; }
    const d = Math.max(Math.abs(x - target.x), Math.abs(y - target.y));
    if (d <= fb.radius || Math.random() < 1 / fb.strength) { chosen = { x, y }; break; }
  }
  if (!chosen) chosen = fallback;
  if (!chosen) {
    // Sampling never found a free cell: linear scan (near-full board).
    for (let y = 0; y < CFG.grid.rows && !chosen; y++) {
      for (let x = 0; x < CFG.grid.cols; x++) {
        if (cellFree(x, y) && !S.powerupPickups.some(p => p.x === x && p.y === y)) { chosen = { x, y }; break; }
      }
    }
  }
  if (chosen) S.food = chosen;
}
function spawnSnake(slotIndex) {
  let len = MIN_SNAKE_LENGTH;
  let x, y, dir = { x: 1, y: 0 };
  // Test-only fixed spawns (inert unless SNAKE_TEST_SPAWNS is set): a JSON
  // array indexed by slot, each { x, y, dir, len? } placing a snake at a known
  // cell, heading, and (optionally) length. Used by tests that need a
  // deterministic layout (e.g. a controlled head-on, or a known leader)
  // instead of walking randomly-spawned snakes together.
  const forced = TEST_SPAWNS && TEST_SPAWNS[slotIndex];
  if (forced) {
    x = forced.x; y = forced.y;
    dir = DIR_VECTORS[forced.dir] || dir;
    if (Number.isInteger(forced.len) && forced.len >= MIN_SNAKE_LENGTH) len = forced.len;
  } else {
    let attempts = 0;
    do {
      x = 3 + Math.floor(Math.random() * (CFG.grid.cols - 6));
      y = 3 + Math.floor(Math.random() * (CFG.grid.rows - 6));
      attempts++;
    } while ((!cellFree(x, y, slotIndex) || !cellFree(x - 1, y, slotIndex) || !cellFree(x - 2, y, slotIndex)) && attempts < 100);
  }
  const s = S.slots[slotIndex];
  const body = [];
  // Body trails BEHIND the head, opposite the heading, so the snake can move
  // off in `dir` without immediately reversing into its own neck.
  for (let n = 0; n < len; n++) body.push({ x: x - dir.x * n, y: y - dir.y * n });
  s.body = body;
  s.dir = dir;
  s.inputQueue = [];
  s.alive = true;
  s.wallStalls = 0;
  s.score = 0;
  s.lastAck = 0;
  s.boost = false;
  s.boostSince = null;
  s.moveAccumMs = 0;
  // NOTE: lastInputAt is deliberately NOT reset here. spawnSnake also runs
  // on automatic respawns, and an AFK player who keeps dying and respawning
  // must not keep resetting their own inactivity clock -- only real input
  // (dir/boost) and seat creation (newPlayerSlot) count as activity.
  // Powerup state, by contrast, DOES reset on every (re)spawn -- deliberately
  // diverging from the lastInputAt precedent above. Powerup state is tied to
  // a specific run; letting a wormhole charge or an active timed effect
  // survive a death would let a player "bank" it across a run that should be
  // a clean slate. Do not "fix" this to match lastInputAt's behavior.
  s.heldPowerup = null;
  s.wormholeCharge = false;
  s.activePowerup = null;
  s.activatedFx = null;
  s.iceStacks = 0;
  s.iceExpiresAtTick = 0;
  s.teleportedThisTick = false;
  s.driftDir = null;
  s.driftUntilMs = 0;
  s.invertUntilTick = 0;
}
function newPlayerSlot(connId) {
  return {
    connId, color: null, body: [], dir: { x: 1, y: 0 }, inputQueue: [],
    alive: true, score: 0, wallStalls: 0, lastAck: 0,
    boost: false, boostSince: null, moveAccumMs: 0, lastInputAt: Date.now(),
    heldPowerup: null, wormholeCharge: false, activePowerup: null, activatedFx: null,
    iceStacks: 0, iceExpiresAtTick: 0, teleportedThisTick: false,
    driftDir: null, driftUntilMs: 0, invertUntilTick: 0
  };
}
// Banana-trail control inversion status (sim-clock based, like the ice
// slow). Checked at dir-enqueue time and in the broadcast.
function isInverted(s) { return S.moveSeq < s.invertUntilTick; }
function growSegment(s) {
  const tail = s.body[s.body.length - 1];
  s.body.push({ ...tail });
}
// Shared floor-respecting shrink, used by both poison trail (via
// powerups/poisonTrail.js's own pop) and blue shell's percentage damage.
function removeSegments(s, count) {
  const n = Math.min(count, s.body.length - MIN_SNAKE_LENGTH);
  for (let i = 0; i < n; i++) s.body.pop();
}
// The living snake with the most segments (ties broken by lowest slot
// index, for determinism). Returns null if nobody is alive.
function currentLeaderIndex() {
  let bestIdx = null, bestLen = -1;
  for (let i = 0; i < S.slots.length; i++) {
    const s = S.slots[i];
    if (s && s.alive && s.body.length > bestLen) { bestLen = s.body.length; bestIdx = i; }
  }
  return bestIdx;
}
// The living snake with the FEWEST segments (inverse of currentLeaderIndex,
// same tie rule). Who the rubberband food bias helps.
function currentTrailingIndex() {
  let worstIdx = null, worstLen = Infinity;
  for (let i = 0; i < S.slots.length; i++) {
    const s = S.slots[i];
    if (s && s.alive && s.body.length < worstLen) { worstLen = s.body.length; worstIdx = i; }
  }
  return worstIdx;
}
// How many connected PEOPLE are still in the game: seats in role "player"
// (alive OR dead awaiting respawn -- the seat persists through the
// spectatorPromoteDelayMs window) plus seats parked as "held" during an
// initials flush. Spectators do not count. This is the blue-shell presence
// gate (maintainer, 2026-07-16): a lone survivor whose opponent is merely
// dead still self-nukes on pickup; only a genuine disconnect makes the
// shell fizzle. Note this counts SEATS, not connections -- two couch seats
// on one computer are two players for shell purposes.
function playerSeatCount() {
  let n = 0;
  for (const [, conn] of S.connections) {
    for (const l of conn.locals) {
      if (l && (l.role === "player" || l.role === "held")) n++;
    }
  }
  return n;
}
function inBounds(h) { return h.x >= 0 && h.x < CFG.grid.cols && h.y >= 0 && h.y < CFG.grid.rows; }
// hitsBody: does (h) land on any segment of `body` except the tail? The tail
// cell vacates this step. Index loop instead of slice().some() on purpose:
// this runs per snake pair per movement step and the slice allocated a fresh
// array each call in the hottest path the server has.
function hitsBody(body, h, skipTail) {
  const end = skipTail ? body.length - 1 : body.length;
  for (let k = 0; k < end; k++) {
    if (body[k].x === h.x && body[k].y === h.y) return true;
  }
  return false;
}
function currentMoveIntervalMs() {
  if (S.sessionStart === null) return MOVE.startIntervalMs;
  const elapsedSec = (Date.now() - S.sessionStart) / 1000;
  const steps = Math.floor(elapsedSec / MOVE.rampIntervalSec);
  const ms = MOVE.startIntervalMs - steps * MOVE.rampStepMs;
  return Math.max(MOVE.minIntervalMs, ms);
}

module.exports = {
  S, cellFree, placeFood, spawnSnake, newPlayerSlot, growSegment,
  removeSegments, currentLeaderIndex, currentTrailingIndex, playerSeatCount,
  inBounds, hitsBody, currentMoveIntervalMs, isInverted
};
