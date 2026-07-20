// ============================================================
// Shared mutable game state + the small board/snake primitives that
// operate directly on it. Everything mutable lives on the single exported
// S object (S.slots, S.food, S.trails, ...) so every module reads and
// writes THE SAME state -- reassignments like `S.trails = S.trails.filter`
// stay visible everywhere, which plain destructured bindings would break.
// ============================================================
const { CFG, MOVE, MAX_FOOD, POWERUPS, MIN_SNAKE_LENGTH, DIR_VECTORS, TEST_SPAWNS, RUBBERBAND, PINATA, FOOD_RATE } = require("./config");

const S = {
  slots: new Array(CFG.maxPlayers).fill(null),
  spectatorQueue: [],
  connections: new Map(),
  foods: [],               // active food cells [{x,y}]; count scales with players.
                           // Piñata "bounty" food rides here too: {x,y,bounty:true,
                           // expiresAtTick} -- excluded from the player-scaled count.
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
  // Grid decay / anti-turtling obstacles (v3.8.0): telegraphed, temporary
  // indestructible walls -- see server/sim.js maybeSpawnWall. Each entry is
  // { id, x, y, telegraphUntil, solidUntil } (epoch ms); "warn"/"solid"/
  // "fading" display state is derived from these at broadcast time (net.js),
  // never stored -- see isSolidWallCell for the collision-time check.
  walls: [],
  nextPowerupId: 1,
  lastPowerupSpawnAt: null,
  lastWallSpawnAt: null,
  moveSeq: 0,              // counts MOVEMENT ticks (used as network seq)
  lastSimAt: null,
  nextSimAt: null,
  // Kill feed (v3.6.8): one-shot per-broadcast queue, same pattern as
  // S.explosions -- pushed to in lifecycle.js handleDeath, broadcast once by
  // net.js, then cleared. rivalries tallies killer->victim pairs (keyed by
  // "killerInitials>victimInitials") for the whole server session -- NOT
  // persisted to the highscores store, lost on restart like any other S state.
  killEvents: [],
  rivalries: new Map()
};

function cellFree(x, y, ignoreSlotIndex = -1) {
  for (let i = 0; i < S.slots.length; i++) {
    const s = S.slots[i];
    if (!s || i === ignoreSlotIndex) continue;
    if (s.body.some(seg => seg.x === x && seg.y === y)) return false;
  }
  return true;
}
// Cell already taken by food, a powerup pickup, or an obstacle wall (any
// display state -- warn or solid, never just the solid ones)? Used so a new
// food/pickup/wall never lands on top of another entity.
function cellHasEntity(x, y) {
  if (S.foods.some(f => f.x === x && f.y === y)) return true;
  if (S.powerupPickups.some(p => p.x === x && p.y === y)) return true;
  if (S.walls.some(w => w.x === x && w.y === y)) return true;
  return false;
}
// True while (x,y) is an ACTIVE (past its telegraph, not yet despawned)
// obstacle wall -- the collision-time check sim.js's movement/drift paths
// treat exactly like an out-of-bounds cell. A cell still in its telegraph
// window is a warning only, not yet solid.
function isSolidWallCell(x, y, now) {
  for (const w of S.walls) {
    if (w.x === x && w.y === y && now >= w.telegraphUntil && now < w.solidUntil) return true;
  }
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
  // Only NORMAL (non-bounty) food is managed toward the player-scaled target;
  // piñata bounty food is transient and lives/dies on its own TTL, so it is
  // never counted here and never trimmed by this top-up (it would otherwise be
  // dropped the instant it pushed the array over target).
  let normal = 0;
  for (const f of S.foods) if (!f.bounty) normal++;
  if (normal > target) {
    let remove = normal - target;
    S.foods = S.foods.filter(f => f.bounty || remove-- <= 0);
    normal = target;
  }
  while (normal < target) {
    if (!placeOneFood()) break; // board full: stop trying this tick
    normal++;
  }
}
// "Piñata" bounties (v3.6.6): a snake dying at/over PINATA.minLength POPS like
// a piñata. It does NOT convert its exact body cells to food; instead a candy
// burst SCATTERS food over a wide area (PINATA.spread cells) around the
// corpse's midpoint. Candy count is PINATA.percent of the popped length,
// capped at PINATA.maxFood (so a monster corpse can't hand out an instant
// runaway lead). Each candy gets a short expiresAtTick (PINATA.ttlMs) -- grab
// it fast. The scatter is biased (PINATA.bias) toward the SHORTEST living
// snake, so a catch-up player gets first crack (rubberband). A one-shot
// explosion entity (radius encoded NEGATIVE to flag it "candy" vs a blue-shell
// ring -- see the renderers) drives the client pixel-burst visual.
function dropPinataFood(s) {
  if (!PINATA.enabled || !s || !s.body || s.body.length < PINATA.minLength) return;
  // Piñatas shine in multiplayer -- a lone player popping their own corpse for
  // gold is just free score, so skip it unless there are at least two player
  // seats present (a merely-dead opponent still counts, matching the blue
  // shell's lone-survivor rule).
  if (playerSeatCount() < 2) return;
  const body = s.body;
  const count = Math.min(PINATA.maxFood, Math.max(1, Math.round(body.length * PINATA.percent)));
  const spread = PINATA.spread;
  const ttlTicks = Math.max(1, Math.ceil(PINATA.ttlMs / currentMoveIntervalMs()));
  const expiresAtTick = S.moveSeq + ttlTicks;
  const mid = body[Math.floor(body.length / 2)];
  const cols = CFG.grid.cols, rows = CFG.grid.rows;
  const clamp = (v, hi) => (v < 0 ? 0 : (v > hi ? hi : v));
  // Bias target: the shortest living snake's head, if it's genuinely shorter
  // than the popped snake (don't feed candy toward an equal/longer rival).
  let bias = null;
  const ti = currentTrailingIndex();
  if (ti != null && S.slots[ti] && S.slots[ti] !== s && S.slots[ti].body.length < body.length) {
    bias = S.slots[ti].body[0];
  }
  const placed = new Set();
  for (let n = 0; n < count; n++) {
    // Scatter around the corpse midpoint, or -- with PINATA.bias odds -- around
    // a point pulled halfway toward the trailing snake.
    let cx = mid.x, cy = mid.y;
    if (bias && Math.random() < PINATA.bias) {
      cx = Math.round(cx + (bias.x - cx) * 0.5);
      cy = Math.round(cy + (bias.y - cy) * 0.5);
    }
    for (let a = 0; a < 12; a++) {
      const x = clamp(cx + Math.round((Math.random() * 2 - 1) * spread), cols - 1);
      const y = clamp(cy + Math.round((Math.random() * 2 - 1) * spread), rows - 1);
      const key = x + "," + y;
      if (placed.has(key) || cellHasEntity(x, y)) continue; // one candy per cell, no stacking on existing food/pickups
      placed.add(key);
      S.foods.push({ x, y, bounty: true, expiresAtTick });
      break;
    }
  }
  // Candy-burst visual: negative radius flags the client to draw a pixel spray
  // (festive candy bits) instead of a blue-shell ring. One-shot, aged out
  // client-side like every explosion.
  if (placed.size > 0) S.explosions.push({ x: mid.x, y: mid.y, radius: -spread });
}
// Clear and refill food to the current target (used by the placeFood test
// hook to re-roll for the rubberband distribution sampler).
function rerollFoods() { S.foods = []; ensureFoods(); }
// Safe-spawn tuning (v3.6.2): how many empty cells a fresh snake keeps from
// every wall, and the halo radius that must be clear of OTHER snakes around
// every one of its body cells. Both auto-shrink on tiny boards (see spawnSnake).
const SPAWN_WALL_MARGIN = 4;
const SPAWN_CLEARANCE = 2;
// True when a snake of `len` placed head-first at (hx,hy) heading `dir` fits
// with `wallMargin` empty cells from every edge AND no other snake within
// `clearance` cells of any of its body cells. clearance 0 = "no body overlap"
// only (used for the crowded-board fallback). Off-board halo cells count as
// free -- wall proximity is enforced separately by the margin check.
function spawnAreaClear(hx, hy, dir, len, slotIndex, clearance, wallMargin) {
  for (let n = 0; n < len; n++) {
    const bx = hx - dir.x * n, by = hy - dir.y * n;
    // Whole body must sit inside the wall margin on every edge.
    if (bx < wallMargin || bx >= CFG.grid.cols - wallMargin ||
        by < wallMargin || by >= CFG.grid.rows - wallMargin) return false;
    // Never spawn a snake onto (or under the telegraph of) an obstacle wall.
    if (S.walls.some(w => w.x === bx && w.y === by)) return false;
    // Clearance halo around this body cell must be free of other snakes.
    for (let ox = -clearance; ox <= clearance; ox++) {
      for (let oy = -clearance; oy <= clearance; oy++) {
        if (!cellFree(bx + ox, by + oy, slotIndex)) return false;
      }
    }
  }
  return true;
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
    // Safe random spawn (v3.6.2). The old spawn only checked the three exact
    // body cells, so a snake could pop in nose-to-nose with someone (head-on
    // before you could turn) or a couple of cells from a wall it was already
    // heading into -- either kills you within a second. Now we require:
    //   * a CLEARANCE halo of empty cells around the whole body (no other
    //     snake nearby), and
    //   * a WALL MARGIN of empty cells from every edge, and
    //   * the head oriented toward the roomier (center-ward) side of the
    //     board, so the nearest wall is never straight ahead.
    // Margins shrink on tiny boards so a valid spawn always exists; if the
    // board is genuinely too crowded we fall back to the best candidate seen
    // (body-overlap-free if possible, else the last one) rather than loop forever.
    const cols = CFG.grid.cols, rows = CFG.grid.rows;
    const wallMargin = Math.max(1, Math.min(SPAWN_WALL_MARGIN, Math.floor(Math.min(cols, rows) / 4)));
    let chosen = null, bodyFree = null, anyCandidate = null;
    for (let attempts = 0; attempts < 200 && !chosen; attempts++) {
      // Head x keeps room for the trailing body plus the wall margin on both
      // sides; head y just clears the top/bottom margin (body is horizontal).
      const hx = wallMargin + len + Math.floor(Math.random() * Math.max(1, cols - 2 * (wallMargin + len)));
      const hy = wallMargin + Math.floor(Math.random() * Math.max(1, rows - 2 * wallMargin));
      // Face toward the center: from the left half head right, from the right
      // half head left -- the long open stretch is always ahead of the head.
      const d = hx < cols / 2 ? { x: 1, y: 0 } : { x: -1, y: 0 };
      anyCandidate = { x: hx, y: hy, dir: d };
      if (spawnAreaClear(hx, hy, d, len, slotIndex, SPAWN_CLEARANCE, wallMargin)) chosen = anyCandidate;
      else if (!bodyFree && spawnAreaClear(hx, hy, d, len, slotIndex, 0, wallMargin)) bodyFree = anyCandidate;
    }
    const pick = chosen || bodyFree || anyCandidate ||
      { x: Math.floor(cols / 2), y: Math.floor(rows / 2), dir: { x: 1, y: 0 } };
    x = pick.x; y = pick.y; dir = pick.dir;
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
  s.teleportDrain = 0;
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
    iceStacks: 0, iceExpiresAtTick: 0, teleportedThisTick: false, teleportDrain: 0,
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
// Kill feed (v3.6.8): a slot's session-bound initials, looked up the same
// way recordIfQualifies does (via its connection's per-local-index initials
// array) -- "???" for a slot with none set, matching the highscores fallback.
function initialsForSlot(slotIndex) {
  const s = S.slots[slotIndex];
  if (!s) return "???";
  const conn = S.connections.get(s.connId);
  if (!conn) return "???";
  const localIdx = conn.locals.findIndex(l => l && l.role === "player" && l.slotIndex === slotIndex);
  if (localIdx === -1) return "???";
  return conn.initials[localIdx] || "???";
}
// Kill feed rivalry tally: increments and returns the running count of
// killerInitials having killed victimInitials this server session (in-memory
// only, never persisted). Keyed on the displayed initials themselves --
// consistent with the feed text ("EEA killed DEC") being the whole point.
function bumpRivalry(killerInitials, victimInitials) {
  const key = killerInitials + ">" + victimInitials;
  const count = (S.rivalries.get(key) || 0) + 1;
  S.rivalries.set(key, count);
  return count;
}
// Blue-shell equal-length gate (v3.6.0): true only when there are at least
// TWO living snakes and they ALL share the same body length. A shell needs a
// length spread to have a meaningful target, so an all-equal board neither
// spawns one nor lets one fire (it fizzles to food instead). Deliberately
// returns false with fewer than two living snakes so this never overrides the
// separate lone-survivor self-nuke behavior (that is the presence gate's job,
// which counts dead-awaiting-respawn seats).
function allEqualLength() {
  let first = null, count = 0;
  for (const s of S.slots) {
    if (!s || !s.alive) continue;
    count++;
    if (first === null) first = s.body.length;
    else if (s.body.length !== first) return false;
  }
  return count >= 2;
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
// ---------------------------------------------------------------
// Speed-run / food-rate score mode (v3.7.0). One accumulator lives per LOCAL
// SEAT on its connection (conn.foodRate[localIdx], created lazily the first
// time that seat becomes a player -- see ensureFoodRateAcc) rather than on
// the S.slots entry, because a slot is discarded and replaced with a fresh
// object every time a seat is demoted to spectator (movePlayerToSpectator)
// and a NEW one is handed out on rejoin (acceptJoin/admitLocal). Keying off
// the connection instead is what makes the metric survive across lives AND
// across spectate/rejoin cycles for the whole session (session = the
// connection's lifetime, maintainer-specced) -- exactly the "independent of
// death" requirement.
//
// Buckets close on PLAY time, not wall-clock time: a bucket only accumulates
// while advanceFoodRateTimers sees the owning slot alive and on the board, so
// a spectate stretch simply never advances curPlayMs -- the pause falls out
// of the mechanism for free, no separate pause/resume bookkeeping needed.
// Each closed bucket is worth exactly FOOD_RATE.bucketMs of real play time,
// so ranking buckets by raw food count IS ranking them by rate.
// topBuckets is a small (windowMs/bucketMs, default 300) ascending-sorted
// array of the best bucket food-counts seen all session -- a worse new bucket
// is discarded, a better one evicts the current worst. That rolling top-K is
// the "best N minutes, not necessarily contiguous" the spec asks for, and
// topSum/cachedRate stay O(1) to read every broadcast tick.
function foodRateWindowSize() {
  return Math.max(1, Math.round(FOOD_RATE.windowMs / FOOD_RATE.bucketMs));
}
function newFoodRateAcc() {
  return { curFood: 0, curPlayMs: 0, closedCount: 0, topBuckets: [], topSum: 0, cachedRate: 0, locked: false };
}
// Called once, the first time a local seat becomes a player -- idempotent,
// so later re-joins of the same seat (spectate -> rejoin) reuse the same
// accumulator instead of resetting the session.
function ensureFoodRateAcc(conn, localIdx) {
  if (!conn) return;
  if (!conn.foodRate) conn.foodRate = [];
  if (!conn.foodRate[localIdx]) conn.foodRate[localIdx] = newFoodRateAcc();
}
function closeFoodRateBucket(acc) {
  const food = acc.curFood;
  acc.curFood = 0;
  acc.curPlayMs -= FOOD_RATE.bucketMs;
  acc.closedCount++;
  const N = foodRateWindowSize();
  const arr = acc.topBuckets;
  if (arr.length < N) {
    let idx = arr.length;
    while (idx > 0 && arr[idx - 1] > food) idx--;
    arr.splice(idx, 0, food);
    acc.topSum += food;
  } else if (food > arr[0]) {
    acc.topSum += food - arr[0];
    arr[0] = food;
    let idx = 0;
    while (idx + 1 < arr.length && arr[idx] > arr[idx + 1]) {
      const t = arr[idx]; arr[idx] = arr[idx + 1]; arr[idx + 1] = t; idx++;
    }
  }
  const k = Math.min(acc.closedCount, N);
  acc.cachedRate = k > 0 ? (acc.topSum * 60000) / (k * FOOD_RATE.bucketMs) : 0;
  if (!acc.locked && acc.closedCount * FOOD_RATE.bucketMs >= FOOD_RATE.floorMs) acc.locked = true;
}
// The local seat (conn + localIdx) currently occupying slot i, or null. Same
// lookup shape as initialsForSlot; kept separate since the callers differ
// (one wants initials text, this wants the accumulator object).
function seatForSlot(slotIndex) {
  const s = S.slots[slotIndex];
  if (!s) return null;
  const conn = S.connections.get(s.connId);
  if (!conn) return null;
  const localIdx = conn.locals.findIndex(l => l && l.role === "player" && l.slotIndex === slotIndex);
  if (localIdx === -1) return null;
  return { conn, localIdx };
}
// Called from the food-eaten and kill-bonus sites in sim.js (the same two
// s.score increment sites the handoff flagged as the food-rate signal to
// repurpose) -- credits the owning seat's CURRENT bucket, whatever life it's
// on. A slot with no owning seat (shouldn't happen for a living snake, but
// cheap to guard) is a no-op.
function bumpFoodRatePoints(slotIndex, amount) {
  if (!FOOD_RATE.enabled) return;
  const seat = seatForSlot(slotIndex);
  const acc = seat && seat.conn.foodRate && seat.conn.foodRate[seat.localIdx];
  if (acc) acc.curFood += amount;
}
// Advance every living, seated player's play-time by dt (called once per sim
// tick from simLoop, mirroring how advanceGlobalSpeed/ensureFoods run once
// per tick). A snake with no owning seat (shouldn't happen) or no
// accumulator yet (spectator, never was a player) is skipped.
function advanceFoodRateTimers(dt) {
  if (!FOOD_RATE.enabled || dt <= 0) return;
  for (let i = 0; i < S.slots.length; i++) {
    const s = S.slots[i];
    if (!s || !s.alive) continue;
    const seat = seatForSlot(i);
    const acc = seat && seat.conn.foodRate && seat.conn.foodRate[seat.localIdx];
    if (!acc) continue;
    acc.curPlayMs += dt;
    while (acc.curPlayMs >= FOOD_RATE.bucketMs) closeFoodRateBucket(acc);
  }
}
// Live snapshot for the broadcast (both while playing and while spectating
// between lives -- the accumulator outlives any one slot). Rate is rounded
// to one decimal for display; null when this seat has never been a player.
function foodRateSnapshot(conn, localIdx) {
  const acc = conn && conn.foodRate && conn.foodRate[localIdx];
  if (!acc) return null;
  return { ratePerMin: Math.round(acc.cachedRate * 10) / 10, locked: acc.locked };
}
// The value to submit to the food-rate leaderboard, or null if this seat
// hasn't cleared the floor yet (provisional-only, doesn't count -- spec).
function foodRateScoreForSeat(conn, localIdx) {
  const acc = conn && conn.foodRate && conn.foodRate[localIdx];
  if (!acc || !acc.locked) return null;
  return Math.round(acc.cachedRate * 100) / 100;
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
  S, cellFree, cellHasEntity, placeOneFood, ensureFoods, dropPinataFood, rerollFoods, targetFoodCount,
  pickupCap, boardPlayerCount, spawnSnake, newPlayerSlot, growSegment,
  removeSegments, currentLeaderIndex, currentTrailingIndex, playerSeatCount,
  allEqualLength, inBounds, hitsBody, currentMoveIntervalMs, targetMoveIntervalMs,
  advanceGlobalSpeed, isInverted, scoreMode, initialsForSlot, bumpRivalry,
  ensureFoodRateAcc, bumpFoodRatePoints, advanceFoodRateTimers, foodRateSnapshot,
  foodRateScoreForSeat, isSolidWallCell
};
