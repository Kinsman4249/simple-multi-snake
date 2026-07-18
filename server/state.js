// ============================================================
// Shared mutable game state + the small board/snake primitives that
// operate directly on it. Everything mutable lives on the single exported
// S object (S.slots, S.food, S.trails, ...) so every module reads and
// writes THE SAME state -- reassignments like `S.trails = S.trails.filter`
// stay visible everywhere, which plain destructured bindings would break.
// ============================================================
const { CFG, MOVE, MAX_FOOD, POWERUPS, MIN_SNAKE_LENGTH, DIR_VECTORS, TEST_SPAWNS, RUBBERBAND } = require("./config");

const S = {
  slots: new Array(CFG.maxPlayers).fill(null),
  spectatorQueue: [],
  connections: new Map(),
  foods: [],               // active food cells [{x,y}]; count scales with players
  moveIntervalMs: null,    // eased global movement interval (ms/cell); null = uninitialized
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
// Cell already taken by food or a powerup pickup? (Snakes are handled by
// cellFree.) Used so a new food never lands on an existing food/pickup.
function cellHasEntity(x, y) {
  if (S.foods.some(f => f.x === x && f.y === y)) return true;
  if (S.powerupPickups.some(p => p.x === x && p.y === y)) return true;
  return false;
}
// Place ONE food. Uniform rejection sampling over free cells -- except when
// the rubberband food bias is active (>= 2 living snakes with a real length
// gap): then a free candidate within `radius` (Chebyshev) of the TRAILING
// snake's head is always accepted, while a farther one is only accepted with
// probability 1/strength, so food lands near whoever is behind more often.
// The catch-up mechanic is silent by design (maintainer, 2026-07-16).
// Bounded: hard 500-attempt cap with a first-free-cell fallback (bias is
// abandoned past 300 attempts), plus a full-board scan if sampling never hit
// a free cell. Returns true if a food was placed, false if the board is full.
function placeOneFood() {
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
    if (!cellFree(x, y) || cellHasEntity(x, y)) continue;
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
        if (cellFree(x, y) && !cellHasEntity(x, y)) { chosen = { x, y }; break; }
      }
    }
  }
  if (chosen) { S.foods.push(chosen); return true; }
  return false;
}
// How many players are currently ON THE BOARD (occupied slots, alive or in
// the respawn window). This is "players in the room" for spawn scaling.
function boardPlayerCount() {
  let n = 0;
  for (const s of S.slots) if (s) n++;
  return n;
}
// Food/powerup spawn scaling by player count (v3.5.0):
//   food:    ceil(players / 2)  -> 1-2:1, 3-4:2, 5-6:3, ...   (cap MAX_FOOD)
//   pickups: max(1, ceil(players / 4)) -> 1-4:1, 5-8:2, ...   (cap maxConcurrentPickups)
// Both clamp to their configured hard ceilings so an operator (or a test)
// can pin them. An empty board scales to zero of each.
function targetFoodCount() {
  const n = boardPlayerCount();
  return n <= 0 ? 0 : Math.min(Math.ceil(n / 2), MAX_FOOD);
}
function pickupCap() {
  const n = boardPlayerCount();
  return n <= 0 ? 0 : Math.min(Math.max(1, Math.ceil(n / 4)), POWERUPS.maxConcurrentPickups);
}
// Bring the active food count up to (or down to) the player-count target.
// Called every sim tick and on join/leave, so a changing player count is
// reflected immediately rather than leaving a stale count. Trims extras
// (fungible) and tops up shortfalls one placement at a time.
function ensureFoods() {
  const target = targetFoodCount();
  if (S.foods.length > target) S.foods.length = target;
  while (S.foods.length < target) {
    if (!placeOneFood()) break; // board full: stop trying this tick
  }
}
// Clear and refill food to the current target (used by the placeFood test
// hook to re-roll for the rubberband distribution sampler).
function rerollFoods() { S.foods = []; ensureFoods(); }
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
  s.rampProgress = 0;
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
    boost: false, boostSince: null, rampProgress: 0, moveAccumMs: 0, lastInputAt: Date.now(),
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
// spectatorPromoteDelayMs window). Spectators do not count. This is the
// blue-shell presence gate (maintainer, 2026-07-16): a lone survivor whose
// opponent is merely dead still self-nukes on pickup; only a genuine
// disconnect makes the shell fizzle. Note this counts SEATS, not
// connections -- two couch seats on one computer are two players for shell
// purposes. (The "held" role this used to also count was removed with the
// v3.4.0 session-initials rework -- scores now record instantly at death,
// so no seat is ever parked waiting on an initials prompt.)
function playerSeatCount() {
  let n = 0;
  for (const [, conn] of S.connections) {
    for (const l of conn.locals) {
      if (l && l.role === "player") n++;
    }
  }
  return n;
}
// "How many computers" (Phase 12 leaderboard split): connections that own at
// least one seat still in the game (role "player" -- alive or
// dead-awaiting-respawn). 1 => "local" (solo or couch co-op on one machine);
// 2+ => "networked". Spectator-only connections don't count -- a watcher
// isn't a competitor. Sampled at DEATH/LEAVE time, the instant the score is
// recorded, so a session changing shape later can't reclassify a finished
// run. Distinct from playerSeatCount above, which counts SEATS (two couch
// seats = two players for the blue shell) -- this counts MACHINES.
function scoreMode() {
  let n = 0;
  for (const [, conn] of S.connections) {
    if (conn.locals.some(l => l && l.role === "player")) n++;
  }
  return n >= 2 ? "networked" : "local";
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
// Global speed target (v3.5.0): a function of the AVERAGE living-snake length
// (total combined length / number of living snakes), NOT total length and NOT
// player count. Equal averages give equal speed (one long + one short == two
// mediums), and the curve SATURATES at MOVE.lengthSaturation so a very long
// average is no faster than a moderately long one (one long snake alone ==
// four long snakes). Empty room / all-minimum-length snakes sit at the slow
// startIntervalMs; the average reaching lengthSaturation hits the fast
// minIntervalMs floor. Monotonic, with an ease-out shape (quick early gains,
// flattening) between the two.
function targetMoveIntervalMs() {
  let total = 0, n = 0;
  for (const s of S.slots) if (s && s.alive) { total += s.body.length; n++; }
  if (n === 0) return MOVE.startIntervalMs;
  const avg = total / n;
  const lo = MIN_SNAKE_LENGTH;
  const hi = Math.max(lo + 1, MOVE.lengthSaturation);
  let t = (avg - lo) / (hi - lo);
  t = t < 0 ? 0 : (t > 1 ? 1 : t);
  const eased = 1 - (1 - t) * (1 - t); // easeOutQuad
  return MOVE.startIntervalMs + (MOVE.minIntervalMs - MOVE.startIntervalMs) * eased;
}
// Ease the ACTUAL global interval toward the target by dt ms. Exponential
// smoothing with time-constant MOVE.speedEaseMs, so any target change --
// growth, join, or leave -- glides in over ~speedEaseMs instead of snapping
// (a join/leave that jumps the average length must not jump the speed).
// Called once per sim tick. speedEaseMs 0 restores instant application.
function advanceGlobalSpeed(dt) {
  const target = targetMoveIntervalMs();
  if (S.moveIntervalMs == null || !(MOVE.speedEaseMs > 0) || dt <= 0) { S.moveIntervalMs = target; return; }
  const a = Math.min(1, dt / MOVE.speedEaseMs);
  S.moveIntervalMs += (target - S.moveIntervalMs) * a;
}
// The eased actual interval every consumer reads (movement cadence, broadcast
// moveMs, powerup duration->ticks). Falls back to the instantaneous target
// before the first advanceGlobalSpeed of a session.
function currentMoveIntervalMs() {
  return S.moveIntervalMs != null ? S.moveIntervalMs : targetMoveIntervalMs();
}

module.exports = {
  S, cellFree, placeOneFood, ensureFoods, rerollFoods, targetFoodCount,
  pickupCap, boardPlayerCount, spawnSnake, newPlayerSlot, growSegment,
  removeSegments, currentLeaderIndex, currentTrailingIndex, playerSeatCount,
  inBounds, hitsBody, currentMoveIntervalMs, targetMoveIntervalMs,
  advanceGlobalSpeed, isInverted, scoreMode
};
