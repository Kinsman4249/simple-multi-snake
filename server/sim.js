// ============================================================
// Simulation: the fixed-rate loop, per-snake movement cadence, drift
// slides, collision resolution (wall/self/snake + wormhole interception),
// food/pickup collection, trails, kill bonuses, expiry, blue shell
// projectiles, and the powerup pickup spawner.
// ============================================================
const {
  CFG, SIM_MS, BOOST, boostRamp, updateMomentum, POWERUPS, POWERUP_TYPES, POWERUP_MODULES,
  HELD_TYPES, TRAIL_TYPES, SPEED_MULT_TYPES, WALL_GRACE_TICKS, MIN_SNAKE_LENGTH, dlog, PERF, RUBBERBAND
} = require("./config");
const {
  S, cellFree, ensureFoods, pickupCap, advanceGlobalSpeed, growSegment,
  removeSegments, currentLeaderIndex, playerSeatCount, allEqualLength,
  inBounds, hitsBody, currentMoveIntervalMs
} = require("./state");
const { broadcastState } = require("./net");
const { lifecycleSweep, handleDeath } = require("./lifecycle");

// Powerup pickup spawn cadence: independent of food's reactive placement.
// Interval-gated, capped at maxConcurrentPickups, one random enabled type
// per spawn, rejection-sampled onto a cell with no snake/food/other pickup.
function maybeSpawnPowerupPickup(now) {
  if (S.lastPowerupSpawnAt === null) S.lastPowerupSpawnAt = now;
  let enabledTypes = POWERUP_TYPES.filter(t => POWERUPS[t].enabled);
  // Blue shell needs someone to fire it AT: with fewer than two people still
  // in the game (see playerSeatCount -- dead-awaiting-respawn counts,
  // disconnected does not) the shell never spawns. The pickup handler has a
  // matching fizzle for shells already on the board when the count drops.
  // ORDER MATTERS: this gate runs BEFORE the rubberband shell pressure below,
  // so pressure can never re-introduce a blueShell the gate removed.
  if (playerSeatCount() < 2) enabledTypes = enabledTypes.filter(t => t !== "blueShell");
  // Equal-length gate (v3.6.0): a shell needs a length spread to threaten
  // anyone, so it never spawns when every living snake is the same length.
  // Re-checked at fire time too (the pickup handler fizzles a shell collected
  // once lengths have equalized), so this is continuously enforced, not a
  // one-time spawn decision.
  if (allEqualLength()) enabledTypes = enabledTypes.filter(t => t !== "blueShell");
  // Longest & second-longest living snake -- drives shell pressure and the
  // blue-shell spawn weight below.
  let best = 0, second = 0;
  for (const s of S.slots) {
    if (!s || !s.alive) continue;
    const len = s.body.length;
    if (len > best) { second = best; best = len; }
    else if (len > second) second = len;
  }
  // Rubberband shell pressure: leader >= leadRatio x the second-longest living
  // snake -> shells spawn sooner (interval scaled down) and weigh heavier in
  // the type roll. Needs a second living snake by construction (second > 0).
  const sp = RUBBERBAND.shellPressure;
  const pressure = sp.enabled && enabledTypes.includes("blueShell") && second > 0 && best >= sp.leadRatio * second;
  const effectiveIntervalMs = POWERUPS.spawnIntervalMs * (pressure ? sp.intervalScale : 1);
  if (now - S.lastPowerupSpawnAt < effectiveIntervalMs) return;
  // Live cap scales with player count (pickupCap: max(1, ceil(players/4)) up
  // to the configured ceiling), recomputed every attempt so a join/leave
  // takes effect immediately.
  if (S.powerupPickups.length >= pickupCap()) return;
  if (enabledTypes.length === 0) { S.lastPowerupSpawnAt = now; return; }
  // Weighted type pick. The blue shell's weight is 1 normally, x shellPressure
  // typeWeight under pressure, and x blueShell.shortLeaderFactor while the
  // LEADER is short (< blueShell.shortLeaderLength, default 15) so shells stay
  // rare until someone is genuinely long -- a short leader barely threatens
  // anyone. All other types keep weight 1.
  const bs = POWERUPS.blueShell;
  let shellWeight = 1;
  if (pressure) shellWeight = sp.typeWeight;
  if (best < bs.shortLeaderLength) shellWeight *= bs.shortLeaderFactor;
  let totalW = 0;
  for (const t of enabledTypes) totalW += (t === "blueShell" ? shellWeight : 1);
  let roll = Math.random() * totalW;
  let type = enabledTypes[enabledTypes.length - 1];
  for (const t of enabledTypes) {
    roll -= (t === "blueShell" ? shellWeight : 1);
    if (roll < 0) { type = t; break; }
  }
  let x, y, attempts = 0;
  do {
    x = Math.floor(Math.random() * CFG.grid.cols);
    y = Math.floor(Math.random() * CFG.grid.rows);
    attempts++;
  } while (
    attempts < 200 &&
    (!cellFree(x, y) || S.foods.some(f => f.x === x && f.y === y) || S.powerupPickups.some(p => p.x === x && p.y === y))
  );
  if (attempts >= 200) { S.lastPowerupSpawnAt = now; return; } // board too crowded, try again next interval
  S.powerupPickups.push({ id: S.nextPowerupId++, type, x, y });
  S.lastPowerupSpawnAt = now;
  dlog && dlog("powerup spawned", { type, x, y });
}

// Fixed-rate simulation loop: sample inputs every tick, move on cadence.
// Scheduling is against an ABSOLUTE next-tick time (nextSimAt) rather than a
// relative setTimeout(SIM_MS): timer callbacks always fire late by some
// jitter, and a relative delay accumulates that jitter into a permanently
// slower effective tick rate. Anchoring to absolute time keeps the long-run
// rate exact, which the client's lock-step interpolation relies on.
function simLoop() {
  const now = Date.now();
  const dt = S.lastSimAt == null ? SIM_MS : Math.min(now - S.lastSimAt, 250);
  S.lastSimAt = now;
  lifecycleSweep();
  // Ease the global speed toward its average-length target, and keep the food
  // count matched to the current player count -- both recomputed every tick so
  // growth and join/leave are reflected continuously and smoothly.
  advanceGlobalSpeed(dt);
  ensureFoods();
  maybeSpawnPowerupPickup(now);
  const interval = currentMoveIntervalMs();
  // Per-snake movement accumulators. A boosting snake's accumulator fills
  // BOOST.boostSpeed times faster, so it crosses the shared ramped interval
  // sooner and takes extra movement steps -- speed is per snake while
  // collision resolution stays step-synchronous (movers vs. everyone).
  // Speed Boost (powerup) and Ice Trail slow both multiply into this SAME
  // increment rather than forking the loop, so hold-to-boost and the
  // speed-boost powerup stack multiplicatively (confirmed design) and ice
  // slow composes the same way.
  let moved = false;
  let guard = 0;
  do {
    const movers = [];
    for (let i = 0; i < S.slots.length; i++) {
      const s = S.slots[i];
      if (!s || !s.alive) continue;
      if (guard === 0) {
        // Momentum first (v3.4.0): rampProgress climbs while the hold is
        // engaged and DECAYS over decelMs after release, so speed is a
        // per-snake state, not a key state -- a released boost still moves
        // (and drifts) fast until it winds down.
        updateMomentum(s, now, dt);
        let mult = 1;
        mult *= 1 + (BOOST.boostSpeed - 1) * boostRamp(s, now);
        // Every speedMultiplier hook stacks multiplicatively (speedBoost,
        // ice slow, helloWorld, ... -- see SPEED_MULT_TYPES): a new
        // speed-affecting powerup only writes the hook, never this loop.
        for (const t of SPEED_MULT_TYPES) mult *= POWERUP_MODULES[t].speedMultiplier(s, POWERUPS);
        s.moveAccumMs += dt * mult;
      }
      if (s.moveAccumMs >= interval) { s.moveAccumMs -= interval; movers.push({ s, i }); }
    }
    if (movers.length === 0) break;
    if (PERF) {
      const t0 = process.hrtime.bigint();
      movementStep(movers);
      const d = process.hrtime.bigint() - t0;
      PERF.mvNs += d; PERF.mvCalls++; if (d > PERF.mvMaxNs) PERF.mvMaxNs = d;
    } else movementStep(movers);
    moved = true;
    guard++;
  } while (guard < 5); // guard: a huge dt (event-loop stall) can owe several steps
  // Blue Shell projectiles move on their OWN cadence (POWERUPS.blueShell.
  // moveIntervalMs), independent of any snake's speed -- driven straight off
  // dt rather than the per-snake accumulator loop above.
  if (updateBlueShells(dt)) moved = true;
  if (moved) {
    if (PERF) {
      const t0 = process.hrtime.bigint();
      broadcastState();
      const d = process.hrtime.bigint() - t0;
      PERF.bcNs += d; PERF.bcCalls++; if (d > PERF.bcMaxNs) PERF.bcMaxNs = d;
    } else broadcastState();
  }
  S.nextSimAt = (S.nextSimAt == null ? now : S.nextSimAt) + SIM_MS;
  if (S.nextSimAt < now) S.nextSimAt = now + SIM_MS; // fell too far behind: re-anchor
  setTimeout(simLoop, Math.max(0, S.nextSimAt - Date.now()));
}
// Advance one movement step for the given movers. Snakes NOT moving this
// step (slower, not boosting) still participate as static obstacles: body
// collisions are checked against every living snake, not just the movers.
function movementStep(movers) {
  const allAlive = [];
  for (let i = 0; i < S.slots.length; i++) {
    if (S.slots[i] && S.slots[i].alive) allAlive.push({ s: S.slots[i], i });
  }
  applyDriftSlides(movers);
  const newHeads = computeNewHeads(movers);
  const died = new Map();
  const stalled = new Set();
  resolveWallCollisions(movers, newHeads, died, stalled);
  resolveSelfCollisions(movers, newHeads, died, stalled);
  resolveSnakeCollisions(movers, newHeads, died, stalled, allAlive);
  clearMutualKills(died);
  applyMovementAndFood(movers, newHeads, died, stalled);
  applyKillBonuses(died);
  for (const [victimIndex] of died) handleDeath(victimIndex);
  expirePowerupsAndTrails();
  S.moveSeq++;
}
// NOTE: a turn consumed early here to dodge a wall deliberately does NOT
// start a drift even if it was made while boosting -- the head is jammed
// against a wall, where a lateral body skid would clamp anyway.
function consumeInboundsTurn(s) {
  const head = s.body[0];
  for (let k = 0; k < s.inputQueue.length; k++) {
    const d = s.inputQueue[k];
    if (d.x === -s.dir.x && d.y === -s.dir.y) continue;
    if (inBounds({ x: head.x + d.x, y: head.y + d.y })) {
      for (let j = 0; j <= k; j++) if (s.inputQueue[j].seq != null) s.lastAck = s.inputQueue[j].seq;
      s.inputQueue.splice(0, k + 1);
      return d;
    }
  }
  return null;
}
// Boost drift (redesigned): a turn made while boosting is applied to the
// HEAD immediately like any other turn -- but it also starts a drift: for
// BOOST.driftMs the whole body keeps skidding one cell per movement step in
// the previous travel direction (applyDriftSlides, run before the head
// advances each step). The skid is a rigid translation of the entire body,
// so the snake stays connected while it visibly slides out of the corner.
//
// Drift collision rules (maintainer-specced):
//   - The skidding body CLAMPS at obstacles: if the translation would push
//     any segment out of bounds or into another snake's body, the whole
//     translation is skipped that step (the skid grinds to a halt; the
//     drift window still runs out on its own clock). It never kills the
//     drifting snake by itself.
//   - The drifted body is fully solid to everyone else, automatically:
//     collision scans always read live body positions.
//   - The head is under normal rules throughout -- and boosting gets NO
//     wall-grace stall (see resolveWallCollisions), so boosting into a wall
//     without a saving turn queued is fatal.
function applyDriftSlides(active) {
  const now = Date.now();
  for (const { s, i } of active) {
    if (!s.driftDir) continue;
    if (now >= s.driftUntilMs) { s.driftDir = null; continue; }
    const d = s.driftDir;
    let blocked = false;
    for (const seg of s.body) {
      const c = { x: seg.x + d.x, y: seg.y + d.y };
      if (!inBounds(c)) { blocked = true; break; }
      for (let j = 0; j < S.slots.length && !blocked; j++) {
        const other = S.slots[j];
        if (j === i || !other || !other.alive) continue;
        if (hitsBody(other.body, c, false)) blocked = true;
      }
      if (blocked) break;
    }
    if (blocked) continue;
    for (const seg of s.body) { seg.x += d.x; seg.y += d.y; }
  }
}
function computeNewHeads(active) {
  const newHeads = new Map();
  for (const { s, i } of active) {
    if (s.inputQueue.length > 0) {
      const inp = s.inputQueue.shift();
      const prevDir = s.dir;
      s.dir = { x: inp.x, y: inp.y };
      if (inp.seq != null) s.lastAck = inp.seq;
      // A turn made while boosting starts the body drift in the direction
      // the snake WAS traveling. The drift begins translating on the NEXT
      // step (applyDriftSlides runs before this), which keeps the first
      // post-turn step fully connected.
      // inp.drift is the boost RAMP PROGRESS (0..1) at keypress time: the
      // skid window scales with how close to top speed the snake actually
      // was when the player turned. 0 (not engaged) starts no drift.
      if (inp.drift) {
        s.driftDir = prevDir;
        s.driftUntilMs = Date.now() + BOOST.driftMs * inp.drift;
      }
    }
    const head = s.body[0];
    newHeads.set(i, { x: head.x + s.dir.x, y: head.y + s.dir.y });
  }
  return newHeads;
}
// ---------------------------------------------------------------
// Wormhole: independent single-charge auto-trigger, state machine.
//
// States (per slot):
//   ARMED -- s.wormholeCharge === true. Picked up, waiting.
//   IDLE  -- s.wormholeCharge === false. No charge held.
//
// The ONLY transition out of ARMED is a fatal-collision INTERCEPTION at
// resolveWallCollisions/resolveSelfCollisions/resolveSnakeCollisions time,
// for THIS slot's own new head this step. There is no manual activation
// message and no re-arm: firing always sets wormholeCharge back to false,
// win or lose -- a failed landing (nowhere safe to phase to) still consumes
// the charge and the snake dies normally; it is not a repeatable shield.
// ---------------------------------------------------------------
function tryWormholeOrDie(idx, killerIdxOrNull, died, stalled, newHeads) {
  const s = S.slots[idx];
  if (s && s.wormholeCharge) {
    // A split-step head-on can kill a snake that is NOT moving this step --
    // it has no newHeads entry, and its fatal contact point is simply its own
    // (stationary) head cell.
    const fatalHead = newHeads.get(idx) || s.body[0];
    // The landing scan still IGNORES the snake's own body (idx): the classic
    // wall rescue steps back through the snake's own head cell, and blocking
    // that would fizzle every tight-quarters rescue. With threading (below)
    // a landing on/near the own body means a brief self-overlap while the
    // tail drains through the entry -- transient and harmless (a cell is
    // solid to OTHERS regardless, and the head only dies if it re-enters a
    // body cell on a later step).
    const result = POWERUP_MODULES.wormhole.attemptWormhole(idx, s, fatalHead, S.slots, CFG.grid, POWERUPS.wormhole.lookaheadDepth);
    s.wormholeCharge = false;
    if (result) {
      // Per-segment threading (v3.4.0, replaces the whole-body instant
      // relocation): ONLY the head exits at the landing cell this step; the
      // body is untouched. Because movement is head-unshift/tail-pop, every
      // trailing segment then drains through the entry point one per step,
      // following the same entry->exit path individually -- the chain stays
      // continuous through the transition (self-body wormholes included)
      // instead of the whole snake snapping across the board at once.
      // predict.js's teleport flag still suppresses the correction glide for
      // the head's jump.
      s.body.unshift({ x: result.landing.x, y: result.landing.y });
      s.body.pop();
      s.dir = result.dir;
      s.teleportedThisTick = true;
      // Mark the whole body as in-transit: for the next (body.length - 1)
      // movement steps the tail drains through the entry while the head leads
      // from the landing, so the body is briefly DISCONTINUOUS. During that
      // window the head's wall and self collisions are exempt (see
      // resolveWallCollisions/resolveSelfCollisions) -- otherwise a landing
      // on/near the snake's own still-present body, or a step past the
      // wormhole's short verified-safe path, reads as a false death. The
      // counter decrements one per drained (popped) segment in
      // applyMovementAndFood and normal collision resumes at zero.
      s.teleportDrain = s.body.length - 1;
      stalled.add(idx); // this step's normal movement/food/pickup logic is skipped for the teleported snake
      dlog && dlog("wormhole fired", { slot: idx, landing: result.landing });
      return;
    }
    dlog && dlog("wormhole fizzled, no landing", { slot: idx });
  }
  died.set(idx, killerIdxOrNull);
}
function resolveWallCollisions(active, newHeads, died, stalled) {
  for (const { s, i } of active) {
    if (died.has(i)) continue;
    let h = newHeads.get(i);
    if (inBounds(h)) { s.wallStalls = 0; continue; }
    // Wormhole threading: while the body is mid-drain its positions are
    // transient, so never die at a wall during the transition -- hold the head
    // in place this step (it stays on-board, alive) until the drain completes.
    if (s.teleportDrain > 0) { stalled.add(i); newHeads.set(i, { x: s.body[0].x, y: s.body[0].y }); continue; }
    const saved = consumeInboundsTurn(s);
    if (saved) { s.dir = saved; h = { x: s.body[0].x + saved.x, y: s.body[0].y + saved.y }; newHeads.set(i, h); s.wallStalls = 0; continue; }
    // No wall grace while boosting (maintainer-specced with the drift
    // redesign): boost is a risk -- a boosted head aimed at a wall with no
    // saving turn queued dies without the stall tick.
    if (s.wallStalls < WALL_GRACE_TICKS && boostRamp(s, Date.now()) === 0) { s.wallStalls++; stalled.add(i); newHeads.set(i, { x: s.body[0].x, y: s.body[0].y }); continue; }
    tryWormholeOrDie(i, null, died, stalled, newHeads);
    s.wallStalls = 0;
  }
}
function resolveSelfCollisions(active, newHeads, died, stalled) {
  for (const { s, i } of active) {
    if (died.has(i) || stalled.has(i)) continue;
    // Wormhole threading: the head is passing through the snake's own
    // still-draining body -- exempt from self-collision until the drain
    // completes (see teleportDrain), so threading never reads as self-death.
    if (s.teleportDrain > 0) continue;
    if (hitsBody(s.body, newHeads.get(i), true)) tryWormholeOrDie(i, null, died, stalled, newHeads);
  }
}
// Movers are checked against EVERY living snake (allAlive), not just other
// movers: with per-snake boost cadence a slower snake may not step this
// tick, but its body is still a solid obstacle. A non-mover's tail does NOT
// vacate this step, so skipTail is false for them.
//
// HEAD-ON (both die) has TWO shapes, and both must kill both:
//   - Same-step: both snakes move this step into the same cell (or trade
//     cells -- the swap is caught by the body-hit branch plus
//     clearMutualKills).
//   - Split-step (the real-play common case, round nineteen): movement is
//     per-snake accumulators (s.moveAccumMs), and two snakes that joined at
//     different times cross the movement threshold on DIFFERENT sim ticks --
//     so in a live game two equal-speed snakes almost never move in the same
//     movers set. A head-on then resolves sequentially: the snake whose tick
//     fires first lands on the other's STATIONARY head. That is still two
//     snakes meeting face-to-face -- if the mover's new head lands exactly on
//     a non-mover's head cell while their directions oppose, BOTH die, no
//     kill credit. (Landing on a head cell with a perpendicular heading is a
//     T-bone into the side of the head: a normal ram, only the mover dies.)
function resolveSnakeCollisions(active, newHeads, died, stalled, allAlive) {
  for (const { s: me, i } of active) {
    if (died.has(i) || stalled.has(i)) continue;
    const h = newHeads.get(i);
    for (const { s: other, i: j } of allAlive) {
      if (j === i) continue;
      const otherHead = newHeads.get(j); // undefined when j isn't moving this step
      // Whether j actually advances this step. A snake that dies THIS step is
      // NOT skipped here: its body is still solid until handleDeath clears it,
      // so another snake swapping into its cell must still collide with it.
      // (Skipping died snakes let a head-on SWAP -- two snakes trading cells
      // -- kill only the first-processed one; the second glided through the
      // corpse and survived. See round eighteen.) A died/stalled snake does
      // not move, so its tail does NOT vacate (skipTail false) and its head
      // is not a same-cell head-on partner.
      const jMoves = otherHead !== undefined && !stalled.has(j) && !died.has(j);
      if (jMoves && h.x === otherHead.x && h.y === otherHead.y) {
        // Same-step head-on into the SAME cell: each side is checked
        // INDEPENDENTLY for a wormhole charge, so one snake phasing away does
        // not block the other's own charge from also firing (or dying
        // normally). No kill credit -- nobody survived the exchange.
        tryWormholeOrDie(i, null, died, stalled, newHeads);
        tryWormholeOrDie(j, null, died, stalled, newHeads);
        if (died.has(i) || stalled.has(i)) break; // i is resolved; stop checking further pairs against it
        continue;
      }
      // Split-step head-on: j is not moving this step (different accumulator
      // phase), but the mover's new head lands exactly on j's head cell while
      // the two face each other. Both die. !died.has(j) keeps a corpse from
      // re-dying (a corpse is a plain solid obstacle, handled below).
      const oh = other.body.length ? other.body[0] : null;
      if (!jMoves && !died.has(j) && oh && h.x === oh.x && h.y === oh.y &&
          other.dir && other.dir.x === -me.dir.x && other.dir.y === -me.dir.y) {
        tryWormholeOrDie(i, null, died, stalled, newHeads);
        tryWormholeOrDie(j, null, died, stalled, newHeads);
        if (died.has(i) || stalled.has(i)) break;
        continue;
      }
      if (hitsBody(other.body, h, jMoves)) {
        tryWormholeOrDie(i, j, died, stalled, newHeads);
        break; // i is resolved (died or teleported); stop checking further pairs
      }
    }
  }
}
// A head-on SWAP (two snakes trading cells) is caught by the body-hit branch
// above, which records each as the OTHER's killer. But nobody survived, so
// that is not a kill: strip mutual kill credit so neither corpse scores off
// the other (matching the same-cell head-on, which already credits no one).
function clearMutualKills(died) {
  const mutual = [];
  for (const [victim, killer] of died) {
    if (killer != null && died.get(killer) === victim) mutual.push(victim);
  }
  for (const v of mutual) died.set(v, null);
}
// Applies a powerup's activation effect to a slot: either a one-shot (blueShell
// launches an independent seeking projectile) or a timed self-buff (everything
// else -- sets activePowerup with a tick-based expiry). Shared by the pickup
// path (auto-firing types, fired the instant collected) and the activatePowerup
// message (the held speedBoost). Not used for wormhole -- see tryWormholeOrDie.
function firePowerup(slot, slotIndex, type) {
  if (type === "blueShell") {
    // Re-targets the CURRENT leader every step (see updateBlueShells), so the
    // firer is not exempt from being hit by their own shell. The pickup path
    // additionally gates on playerSeatCount() >= 2 before calling this.
    const head = slot.body[0];
    // stepAxis seeds the staircase alternator in updateBlueShells; "y" means
    // the first off-axis diagonal step flips to "x" (horizontal-first).
    S.blueShells.push({ id: S.nextPowerupId++, x: head.x, y: head.y, ownerSlot: slotIndex, moveAccumMs: 0, stepAxis: "y" });
    dlog && dlog("blueShell launched", { slot: slotIndex, x: head.x, y: head.y });
  } else {
    const durationMs = POWERUPS[type].durationMs;
    const total = Math.ceil(durationMs / currentMoveIntervalMs());
    slot.activePowerup = { type, startTick: S.moveSeq, expiresAtTick: S.moveSeq + total };
    dlog && dlog("powerup activated", { slot: slotIndex, type });
  }
  // Optional module hook: runs once at activation (either path). Receives
  // dlog so a module can log without importing anything.
  if (typeof POWERUP_MODULES[type].onActivate === "function") {
    POWERUP_MODULES[type].onActivate(slot, slotIndex, dlog);
  }
  // One-shot activation-flash marker (client draws a brief colored pop, and
  // for a one-shot like blueShell it's the only "it fired" cue). Cleared after
  // the next broadcast, like teleportedThisTick.
  slot.activatedFx = type;
}
function applyMovementAndFood(active, newHeads, died, stalled) {
  // Equal-length snapshot taken BEFORE any head is unshifted below: inside the
  // loop a mover's body is transiently one longer (new head added, tail not
  // yet popped), which would make the collector look longer than everyone
  // else and wrongly let its blue shell fire. This settled-length snapshot is
  // the correct "moment of fire evaluation" the equal-length rule means.
  const equalLengths = allEqualLength();
  for (const { s, i } of active) {
    if (died.has(i) || stalled.has(i)) continue;
    const h = newHeads.get(i);
    s.body.unshift(h);
    let grew = false;
    // Multi-food: the head may land on any active food cell. Remove that one
    // and let ensureFoods (next sim tick) top the count back up to target.
    const fi = S.foods.findIndex(f => f.x === h.x && f.y === h.y);
    if (fi !== -1) {
      s.score += 1;
      const mult = POWERUP_MODULES.growthSpurt.foodGrowthMultiplier(s, POWERUPS);
      for (let n = 1; n < mult; n++) growSegment(s);
      S.foods.splice(fi, 1);
      ensureFoods();
      grew = true;
    }
    // Powerup pickup collection, mirroring the food check above (head lands
    // on the entity). Three cases:
    //   - wormhole: arms the independent charge (no held slot).
    //   - HELD_TYPES (speedBoost): occupies the shared held slot, fired later
    //     with the activate key.
    //   - everything else: AUTO-fires immediately (firePowerup) -- trails start
    //     laying, blueShell launches, growth begins -- no button press.
    // A pickup that would be "wasted" (charge already armed, held slot full,
    // or the same timed effect already running) instead grants the +1 segment
    // fallback that eating food gives, with no state change.
    const pk = S.powerupPickups.find(p => p.x === h.x && p.y === h.y);
    if (pk) {
      const type = pk.type;
      let blocked;
      if (type === "wormhole") {
        blocked = s.wormholeCharge;
        if (!blocked) s.wormholeCharge = true;
      } else if (HELD_TYPES.has(type)) {
        blocked = s.heldPowerup != null || (s.activePowerup && s.activePowerup.type === type);
        if (!blocked) s.heldPowerup = type;
      } else {
        // Auto-fire. A timed self-buff of the SAME type already running is
        // "wasted" (fallback +1). A blueShell fizzles the same way -- acting
        // like food (+1), not launching -- when there is nobody meaningful to
        // aim it at: fewer than two people still in the game (a shell can
        // outlive the second player's DISCONNECT -- a merely-dead opponent
        // still counts, so a lone survivor's pickup fires and self-nukes,
        // maintainer-specced), OR every living snake is the SAME length
        // (v3.6.0 equal-length rule). This is evaluated HERE at fire time, so
        // a shell picked up after lengths equalized fizzles even though it
        // spawned when they differed; an already-launched projectile is
        // unaffected.
        blocked = !!(s.activePowerup && s.activePowerup.type === type) ||
                  (type === "blueShell" && (playerSeatCount() < 2 || equalLengths));
        if (!blocked) firePowerup(s, i, type);
      }
      // NOTE: growSegment WITHOUT grew=true -- the unshifted head still pops
      // below, so the net is exactly +1, matching the food fallback the
      // comment above promises (grew=true here double-counted to +2).
      if (blocked) growSegment(s);
      S.powerupPickups = S.powerupPickups.filter(p => p.id !== pk.id);
      dlog && dlog("powerup collected", { slot: i, type, blocked, auto: type !== "wormhole" && !HELD_TYPES.has(type) });
    }
    // Tail-emitted trails: capture the cell this step's tail vacates BEFORE
    // the pop, so a laid trail streams out from behind the snake (its TAIL
    // end) rather than from just behind the head. When the snake grew this
    // step nothing is vacated, so this stays the current tail cell.
    const vacatedTail = s.body[s.body.length - 1];
    if (!grew) s.body.pop();
    // Wormhole threading: a real (non-growing) step popped one still-in-transit
    // tail segment, so the body is one cell closer to contiguous again. When
    // the last stale segment drains (counter hits 0) normal wall/self collision
    // resumes on the next step.
    if (s.teleportDrain > 0 && !grew) s.teleportDrain--;
    // Trail crossing: this mover's new head landed on a laid tile. The
    // laying snake is NOT immune to its own trail (confirmed override).
    const trail = S.trails.find(t => t.x === h.x && t.y === h.y);
    if (trail) {
      if (trail.type === "iceTrail") {
        POWERUP_MODULES.iceTrail.onCross(s);
        s.iceExpiresAtTick = S.moveSeq + Math.ceil(POWERUPS.iceTrail.slowDurationMs / currentMoveIntervalMs());
        dlog && dlog("ice trail crossed", { slot: i, stacks: s.iceStacks });
      } else if (trail.type === "poisonTrail") {
        const before = s.body.length;
        POWERUP_MODULES.poisonTrail.onCross(s, null, trail, MIN_SNAKE_LENGTH);
        if (s.body.length < before) dlog && dlog("poison trail crossed", { slot: i, length: s.body.length });
      } else if (trail.type === "bananaTrail") {
        // Slipping on a banana REVERSES the crosser's controls for a while
        // (the transform itself lives in the dir handler; this just stamps
        // the sim-clock window, same shape as the ice slow). Re-crossing
        // refreshes the window.
        POWERUP_MODULES.bananaTrail.onCross(s);
        s.invertUntilTick = S.moveSeq + Math.ceil(POWERUPS.bananaTrail.invertDurationMs / currentMoveIntervalMs());
        dlog && dlog("banana trail crossed", { slot: i, untilTick: s.invertUntilTick });
      }
    }
    // Trail laying: one tile per movement step while this mover's
    // activePowerup is a trail type, laid at the cell the TAIL just vacated so
    // the trail streams out from behind the snake (from its tail end) rather
    // than from just behind the head. One entry per (x,y) -- a later lay on an
    // occupied cell replaces it.
    if (s.activePowerup && TRAIL_TYPES.has(s.activePowerup.type)) {
      const type = s.activePowerup.type;
      const layCell = vacatedTail || h;
      const expiresAtTick = S.moveSeq + Math.ceil(POWERUPS[type].tileDurationMs / currentMoveIntervalMs());
      // Gap fill: at higher snake speeds (a boost drift rigidly skids the whole
      // body sideways while the head also advances, and the length-scaled
      // global speed takes several movement steps per sim tick) the vacated
      // tail can jump MORE than one cell between consecutive lays. Laying only
      // the endpoint left the trail DASHED -- gaps a snake could slip through
      // without ever crossing a tile. Walk from the previous laid cell to this
      // one (x first, then y, so a diagonal drift+follow jump fills as an L)
      // and lay a tile on every cell in between, all sharing this step's expiry.
      const prev = s.lastTrailCell;
      const cells = [];
      if (prev && (prev.x !== layCell.x || prev.y !== layCell.y)) {
        let cx = prev.x, cy = prev.y;
        const sx = Math.sign(layCell.x - cx), sy = Math.sign(layCell.y - cy);
        // Cap the walk so a pathological jump (not expected in normal play)
        // can never paint a full line across the board.
        let guard = CFG.grid.cols + CFG.grid.rows;
        while ((cx !== layCell.x || cy !== layCell.y) && guard-- > 0) {
          if (cx !== layCell.x) cx += sx; else cy += sy;
          cells.push({ x: cx, y: cy });
        }
      } else {
        cells.push({ x: layCell.x, y: layCell.y });
      }
      for (const c of cells) {
        S.trails = S.trails.filter(t => !(t.x === c.x && t.y === c.y));
        S.trails.push({ id: S.nextPowerupId++, type, x: c.x, y: c.y, ownerSlot: i, expiresAtTick });
      }
      s.lastTrailCell = { x: layCell.x, y: layCell.y };
    } else {
      // Not laying this step: drop the anchor so the NEXT activation starts a
      // fresh trail instead of drawing a line back from a stale, far-away cell.
      s.lastTrailCell = null;
    }
    s.wallStalls = 0;
  }
}
function applyKillBonuses(died) {
  for (const [, killerIndex] of died) {
    if (killerIndex === null) continue;
    const killer = S.slots[killerIndex];
    if (!killer || !killer.alive) continue;
    killer.score += CFG.killBonusScore;
    const growthAmt = CFG.killBonusGrowth + POWERUP_MODULES.growthSpurt.killBonusGrowthBonus(killer, POWERUPS);
    const tail = killer.body[killer.body.length - 1];
    for (let n = 0; n < growthAmt; n++) killer.body.push({ ...tail });
  }
}
// Sim-clock-based expiry (moveSeq ticks, not setTimeout) for laid trail
// tiles, each player's currently-active timed powerup effect, and the
// victim-side ice-slow status. Called once per movement step.
function expirePowerupsAndTrails() {
  // Reallocate the trails array only when something actually expired: this
  // runs EVERY movement step, and the common case (no trails, or none due)
  // shouldn't produce per-step garbage (Phase 7 profile-pass cleanup).
  for (let i = 0; i < S.trails.length; i++) {
    if (S.moveSeq >= S.trails[i].expiresAtTick) {
      S.trails = S.trails.filter(t => S.moveSeq < t.expiresAtTick);
      break;
    }
  }
  // Piñata bounty food expires on its own short TTL (expiresAtTick); same
  // reallocate-only-when-due pattern as trails. Normal food has no
  // expiresAtTick and is untouched here.
  for (let i = 0; i < S.foods.length; i++) {
    if (S.foods[i].bounty && S.moveSeq >= S.foods[i].expiresAtTick) {
      S.foods = S.foods.filter(f => !(f.bounty && S.moveSeq >= f.expiresAtTick));
      break;
    }
  }
  for (const s of S.slots) {
    if (!s) continue;
    if (s.activePowerup && S.moveSeq >= s.activePowerup.expiresAtTick) {
      dlog && dlog("powerup expired", { type: s.activePowerup.type });
      s.activePowerup = null;
    }
    if (s.iceStacks > 0 && S.moveSeq >= s.iceExpiresAtTick) s.iceStacks = 0;
  }
}
// Advances every in-flight Blue Shell one cell toward whoever is CURRENTLY
// the longest living snake's HEAD (re-targeted fresh every step, so a shell
// keeps homing on a new leader if the lead changes mid-flight -- and will
// happily hit its own launcher if they are or become the leader). It PHASES
// THROUGH every body (its own target's included) and only detonates on the
// target's HEAD cell, so you cannot shield with your tail -- it must be
// outrun, not blocked. When the target is off-axis on both axes it moves in a
// staircase (alternating x/y each step) rather than a rigid L, tracking the
// leader along a natural diagonal. Its step cadence is blueShell.speedRatio of the
// current game move interval, so it is faster than a normal snake at every
// game phase yet a fully-boosted snake (hold-boost x Speed Boost) can still
// outrun it: almost impossible to dodge, but dodgeable at maximum speed.
// Returns true if any shell moved (so simLoop broadcasts even on a tick where
// no snake itself advanced).
function updateBlueShells(dt) {
  let moved = false;
  const shellInterval = currentMoveIntervalMs() * POWERUPS.blueShell.speedRatio;
  for (const shell of S.blueShells.slice()) {
    shell.moveAccumMs = (shell.moveAccumMs || 0) + dt;
    if (shell.moveAccumMs < shellInterval) continue;
    shell.moveAccumMs -= shellInterval;
    const targetIdx = currentLeaderIndex();
    if (targetIdx === null) { S.blueShells = S.blueShells.filter(b => b.id !== shell.id); continue; }
    const targetHead = S.slots[targetIdx].body[0];
    const dx = targetHead.x - shell.x, dy = targetHead.y - shell.y;
    // Staircase tracking (v3.6.2): when the target is off-axis on BOTH axes,
    // alternate the step axis every frame (x, then y, then x...) so the shell
    // traces a smooth diagonal staircase instead of the old rigid L (all of
    // one axis, then all of the other). Once it lines up on one axis, dx or
    // dy is 0 and it simply closes the remaining gap on the other axis.
    let stepX;
    if (dx !== 0 && dy !== 0) {
      shell.stepAxis = shell.stepAxis === "x" ? "y" : "x"; // flip each diagonal step
      stepX = shell.stepAxis === "x";
    } else {
      stepX = dx !== 0; // only one axis left to travel -- move along it
    }
    if (stepX) shell.x += dx > 0 ? 1 : -1;
    else shell.y += dy > 0 ? 1 : -1;
    moved = true;
    // Head only -- phases through the body, detonates on the head cell.
    if (shell.x === targetHead.x && shell.y === targetHead.y) {
      triggerBlueShellImpact(shell, targetIdx);
      S.blueShells = S.blueShells.filter(b => b.id !== shell.id);
    }
  }
  return moved;
}
function triggerBlueShellImpact(shell, targetIdx) {
  const target = S.slots[targetIdx];
  const loss = POWERUP_MODULES.blueShell.segmentsLost(target.body.length, POWERUPS.blueShell.segmentLossPercent, MIN_SNAKE_LENGTH);
  removeSegments(target, loss);
  const cx = shell.x, cy = shell.y, r = POWERUPS.blueShell.explosionRadius;
  for (let i = 0; i < S.slots.length; i++) {
    if (i === targetIdx) continue;
    const s = S.slots[i];
    if (!s || !s.alive) continue;
    const inRadius = s.body.some(seg => Math.max(Math.abs(seg.x - cx), Math.abs(seg.y - cy)) <= r);
    if (inRadius) {
      const splash = POWERUP_MODULES.blueShell.segmentsLost(s.body.length, POWERUPS.blueShell.splashLossPercent, MIN_SNAKE_LENGTH);
      removeSegments(s, splash);
    }
  }
  S.explosions.push({ x: cx, y: cy, radius: r });
  dlog && dlog("blueShell impact", { targetIdx, loss, x: cx, y: cy });
}

module.exports = { simLoop, firePowerup, maybeSpawnPowerupPickup };
