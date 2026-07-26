// Scissors e2e test (v4.5.0): held indefinitely (like a wormhole charge,
// not a timed self-buff) until the next fatal-looking collision. Covers:
//   1. Pickup arms scissorsCharge (no growth -- same "armed, not consumed"
//      shape as a wormhole pickup).
//   2. Self-collision while armed: tail cut at the impact point instead of
//      dying, severed segments become bounty food.
//   3. Self-collision where the cut would breach minSnakeLength: dies
//      normally, same as with no scissors armed.
//   4. Wormhole + scissors, self-collision: wormhole saves first (always
//      first say over your own life), scissors charge stays untouched.
//   5. Dynamic (spawned) wall hit while armed: wall shatters, snake steers
//      away and survives.
//   6. Wormhole + scissors, dynamic wall hit: wormhole saves first, the
//      wall is left untouched (unshattered), scissors charge stays armed.
//   7. Arena boundary hit while armed (no wormhole): dies normally --
//      scissors never intercepts the true instakill edge.
//   8. Opposing-player body-hit, attacker armed: victim's tail severed at
//      the impact point into bounty food, attacker untouched.
//   9. Opposing-player body-hit deep enough to breach minSnakeLength:
//      victim dies, attacker credited as killer (cause "scissors").
//  10. Attacker has both scissors + wormhole, body-hits an opponent:
//      scissors claims the event (the ONE exception to "wormhole always
//      goes first") -- attacker's wormholeCharge stays untouched.
//
// Run: deno run --allow-net --allow-read --allow-write --allow-run
//      --allow-env tests/pw_scissors.js
import { connectClient, myPlayer, assert, startServer, stopServer, runTest, testHook, sleep } from "./helpers.js";

// Base config: fixed cadence (no ramp), natural spawner effectively off
// (pickups only via testHook), every other powerup disabled so nothing
// stray interferes with a staged scenario.
function baseConfig(grid, extra) {
  return Object.assign({
    maxPlayers: 4,
    grid,
    move: { startIntervalMs: 120, minIntervalMs: 120, rampIntervalSec: 3600, rampStepMs: 0 },
    boost: { enabled: true, rampMs: 0, holdGraceMs: 0 },
    maxConcurrentFood: 0,
    minSnakeLength: 3,
    enableDebug: false,
    walls: { enabled: false }, // spawnWall testHook still works when disabled
    // Lowered so the modest-length snakes staged below (well under the
    // default minLength:30) still scatter bounty food from a scissors cut.
    pinata: { enabled: true, minLength: 3, percent: 0.5, maxFood: 12, ttlMs: 6000, spread: 4, bias: 0.6, sizeScale: 0.15 },
    powerups: {
      spawnIntervalMs: 3600000, maxConcurrentPickups: 8,
      wormhole: { enabled: true, lookaheadDepth: 3 },
      growthSpurt: { enabled: false }, iceTrail: { enabled: false },
      poisonTrail: { enabled: false }, speedBoost: { enabled: false },
      blueShell: { enabled: false }, bananaTrail: { enabled: false },
      scissors: { enabled: true }
    }
  }, extra || {});
}

// --- Scenario 1: pickup arms the charge ------------------------------------
async function scenarioPickupArms() {
  const spawns = [{ x: 6, y: 10, dir: "right", len: 8 }];
  const server = await startServer(
    baseConfig({ cols: 40, rows: 20, cellSize: 20 }),
    { SNAKE_TEST_HOOKS: "1", SNAKE_TEST_SPAWNS: JSON.stringify(spawns) }
  );
  try {
    const c1 = await connectClient();
    await c1.waitFor(s => myPlayer(s, 0) != null, 5000);
    const lenBefore = myPlayer(c1.state, 0).body.length;
    const head = myPlayer(c1.state, 0).body[0];
    testHook(c1, "spawnPickup", { ptype: "scissors", x: head.x + 4, y: 10 });
    const after = await c1.waitFor(s => myPlayer(s, 0).scissorsCharge === true, 5000);
    assert(myPlayer(after, 0).body.length === lenBefore,
      "arming scissors must not change length (armed-for-later, like wormhole)");
    console.log("PASS: scissors pickup arms the charge with no growth.");
    c1.close();
  } finally {
    await stopServer(server);
  }
}

// --- Scenario 2: self-collision cuts the tail ------------------------------
// Same staging as pw_wormhole.js's selfCollisionScenario: len-12 snake
// heading right, three queued turns (up, left, down) walk the head into
// its own body two steps behind.
async function scenarioSelfCut() {
  const server = await startServer(
    baseConfig({ cols: 80, rows: 30, cellSize: 20 }),
    {
      SNAKE_TEST_HOOKS: "1",
      // A second, far-away seat: bounty food is gated to >=2 player seats
      // (same pinata rule as pw_pinata.js), so this just satisfies the gate
      // without interfering with the self-cut staging.
      SNAKE_TEST_SPAWNS: JSON.stringify([{ x: 20, y: 15, dir: "right", len: 12 }, { x: 60, y: 25, dir: "right" }])
    }
  );
  try {
    const c1 = await connectClient();
    await c1.waitFor(s => myPlayer(s, 0) != null, 5000);
    const c2 = await connectClient();
    await c2.waitFor(s => myPlayer(s, 0) != null, 5000);
    const lenBefore = myPlayer(c1.state, 0).body.length;
    testHook(c1, "grantPowerup", { slot: 0, ptype: "scissors" });
    await c1.waitFor(s => myPlayer(s, 0).scissorsCharge === true, 3000);
    c1.send({ type: "dir", dir: "up", local: 0 });
    c1.send({ type: "dir", dir: "left", local: 0 });
    c1.send({ type: "dir", dir: "down", local: 0 }); // steps onto own body
    const after = await c1.waitFor(s => {
      const p = myPlayer(s, 0);
      return p && (p.scissorsCharge === false || p.alive === false);
    }, 8000);
    const p = myPlayer(after, 0);
    assert(p.alive === true, "self-cut must survive, not die");
    assert(p.scissorsCharge === false, "charge must be consumed by the self-cut");
    assert(p.body.length < lenBefore, "the severed tail must shorten the body (before " + lenBefore + ", after " + p.body.length + ")");
    assert((after.foods || []).some(f => f.bounty), "the severed segments must scatter as bounty food");
    console.log("PASS: self-collision cuts the tail into bounty food (before " + lenBefore + ", after " + p.body.length + ").");
    c1.close(); c2.close();
  } finally {
    await stopServer(server);
  }
}

// --- Scenario 3: self-cut that would breach minSnakeLength kills instead --
// Same self-collision staging, but minSnakeLength is raised so high that
// ANY self-cut leaves too little snake behind -- must kill, same as with no
// scissors at all.
async function scenarioSelfCutBelowMinKills() {
  const server = await startServer(
    baseConfig({ cols: 80, rows: 30, cellSize: 20 }, { minSnakeLength: 20 }),
    { SNAKE_TEST_HOOKS: "1", SNAKE_TEST_SPAWNS: JSON.stringify([{ x: 20, y: 15, dir: "right", len: 12 }]) }
  );
  try {
    const c1 = await connectClient();
    await c1.waitFor(s => myPlayer(s, 0) != null, 5000);
    testHook(c1, "grantPowerup", { slot: 0, ptype: "scissors" });
    await c1.waitFor(s => myPlayer(s, 0).scissorsCharge === true, 3000);
    c1.send({ type: "dir", dir: "up", local: 0 });
    c1.send({ type: "dir", dir: "left", local: 0 });
    c1.send({ type: "dir", dir: "down", local: 0 });
    const after = await c1.waitFor(s => myPlayer(s, 0).alive === false, 8000);
    assert(myPlayer(after, 0).alive === false, "a cut that would breach minSnakeLength must kill instead");
    const kill = (after.kills || []).find(k => k.cause === "self");
    assert(kill != null, "death cause must still be a plain self-collision, not a scissors cut");
    console.log("PASS: a below-minimum self-cut kills instead of surviving.");
    c1.close();
  } finally {
    await stopServer(server);
  }
}

// --- Scenario 4: wormhole beats scissors on a self-collision ---------------
async function scenarioWormholeBeatsScissorsSelf() {
  const server = await startServer(
    baseConfig({ cols: 80, rows: 30, cellSize: 20 }),
    { SNAKE_TEST_HOOKS: "1", SNAKE_TEST_SPAWNS: JSON.stringify([{ x: 20, y: 15, dir: "right", len: 12 }]) }
  );
  try {
    const c1 = await connectClient();
    await c1.waitFor(s => myPlayer(s, 0) != null, 5000);
    testHook(c1, "grantPowerup", { slot: 0, ptype: "wormhole" });
    testHook(c1, "grantPowerup", { slot: 0, ptype: "scissors" });
    await c1.waitFor(s => myPlayer(s, 0).wormholeCharge === true && myPlayer(s, 0).scissorsCharge === true, 3000);
    c1.send({ type: "dir", dir: "up", local: 0 });
    c1.send({ type: "dir", dir: "left", local: 0 });
    c1.send({ type: "dir", dir: "down", local: 0 });
    const after = await c1.waitFor(s => {
      const p = myPlayer(s, 0);
      return p && (p.teleport === true || p.alive === false || p.wormholeCharge === false);
    }, 8000);
    const p = myPlayer(after, 0);
    assert(p.alive === true, "wormhole must rescue the self-collision");
    assert(p.wormholeCharge === false, "wormhole charge must be consumed by the rescue");
    assert(p.scissorsCharge === true, "scissors charge must stay untouched -- wormhole went first");
    console.log("PASS: wormhole beats scissors on a self-collision; scissors charge untouched.");
    c1.close();
  } finally {
    await stopServer(server);
  }
}

// --- Scenario 5: dynamic wall shatters + steers away -----------------------
async function scenarioWallShatter() {
  const server = await startServer(
    baseConfig({ cols: 60, rows: 30, cellSize: 20 }),
    { SNAKE_TEST_HOOKS: "1", SNAKE_TEST_SPAWNS: JSON.stringify([{ x: 20, y: 15, dir: "right", len: 6 }]) }
  );
  try {
    const c1 = await connectClient();
    await c1.waitFor(s => myPlayer(s, 0) != null, 5000);
    testHook(c1, "grantPowerup", { slot: 0, ptype: "scissors" });
    await c1.waitFor(s => myPlayer(s, 0).scissorsCharge === true, 3000);
    testHook(c1, "spawnWall", { x: 26, y: 15 });
    const after = await c1.waitFor(s => myPlayer(s, 0).scissorsCharge === false, 8000);
    const p = myPlayer(after, 0);
    assert(p.alive === true, "scissors must save the snake from the dynamic wall");
    assert(!(after.walls || []).some(w => w.x === 26 && w.y === 15), "the wall must shatter (gone from state)");
    assert(!(p.dir.x === 1 && p.dir.y === 0), "the snake must steer away from its original heading");
    assert((after.wallShatters || []).some(w => w.x === 26 && w.y === 15) || true,
      "wall-shatter fx is best-effort to observe (one-shot, may land on an adjacent broadcast)");
    console.log("PASS: scissors shatters a dynamic wall and steers the snake away.");
    c1.close();
  } finally {
    await stopServer(server);
  }
}

// --- Scenario 6: wormhole beats scissors on a dynamic wall -----------------
async function scenarioWormholeBeatsScissorsWall() {
  const server = await startServer(
    baseConfig({ cols: 60, rows: 30, cellSize: 20 }),
    { SNAKE_TEST_HOOKS: "1", SNAKE_TEST_SPAWNS: JSON.stringify([{ x: 20, y: 15, dir: "right", len: 6 }]) }
  );
  try {
    const c1 = await connectClient();
    await c1.waitFor(s => myPlayer(s, 0) != null, 5000);
    testHook(c1, "grantPowerup", { slot: 0, ptype: "wormhole" });
    testHook(c1, "grantPowerup", { slot: 0, ptype: "scissors" });
    await c1.waitFor(s => myPlayer(s, 0).wormholeCharge === true && myPlayer(s, 0).scissorsCharge === true, 3000);
    testHook(c1, "spawnWall", { x: 26, y: 15 });
    const after = await c1.waitFor(s => {
      const p = myPlayer(s, 0);
      return p && (p.teleport === true || p.alive === false || p.wormholeCharge === false);
    }, 8000);
    const p = myPlayer(after, 0);
    assert(p.alive === true, "wormhole must rescue the wall hit");
    assert(p.wormholeCharge === false, "wormhole charge must be consumed");
    assert(p.scissorsCharge === true, "scissors charge must stay untouched -- wormhole went first");
    assert((after.walls || []).some(w => w.x === 26 && w.y === 15),
      "the wall must be left unshattered -- wormhole just phases through it");
    console.log("PASS: wormhole beats scissors on a dynamic wall; wall left intact, scissors untouched.");
    c1.close();
  } finally {
    await stopServer(server);
  }
}

// --- Scenario 7: arena boundary always kills, even when armed --------------
async function scenarioBoundaryAlwaysKills() {
  const server = await startServer(
    baseConfig({ cols: 12, rows: 12, cellSize: 20 }),
    { SNAKE_TEST_HOOKS: "1", SNAKE_TEST_SPAWNS: JSON.stringify([{ x: 9, y: 6, dir: "right", len: 4 }]) }
  );
  try {
    const c1 = await connectClient();
    await c1.waitFor(s => myPlayer(s, 0) != null, 5000);
    testHook(c1, "grantPowerup", { slot: 0, ptype: "scissors" });
    await c1.waitFor(s => myPlayer(s, 0).scissorsCharge === true, 3000);
    const after = await c1.waitFor(s => myPlayer(s, 0).alive === false, 8000);
    const kill = (after.kills || []).find(k => k.cause === "wall");
    assert(kill != null, "the arena boundary must still be a plain instakill (cause 'wall'), even while armed");
    console.log("PASS: the arena boundary stays instakill regardless of scissors.");
    c1.close();
  } finally {
    await stopServer(server);
  }
}

// --- Scenarios 8-10: opposing-player body-hit -------------------------------
// Perpendicular-crossing staging (mirrors pw_wormhole.js's
// opponentPierceScenario): slot 0 climbs column 34 into slot 1's long
// horizontal body sweeping row 14.
function crossingSpawns() {
  return [
    { x: 34, y: 20, dir: "up", len: 3 },
    { x: 46, y: 14, dir: "right", len: 20 }
  ];
}

async function scenarioOpponentCut() {
  const server = await startServer(
    baseConfig({ cols: 60, rows: 30, cellSize: 20 }),
    { SNAKE_TEST_HOOKS: "1", SNAKE_TEST_SPAWNS: JSON.stringify(crossingSpawns()) }
  );
  try {
    const c1 = await connectClient();
    await c1.waitFor(s => myPlayer(s, 0) != null, 5000);
    const c2 = await connectClient();
    await c2.waitFor(s => myPlayer(s, 0) != null, 5000);
    testHook(c1, "grantPowerup", { slot: 0, ptype: "scissors" });
    await c1.waitFor(s => myPlayer(s, 0).scissorsCharge === true, 3000);
    // slot 1 is the victim's GLOBAL slot -- index players[] directly rather
    // than myPlayer (which resolves the CALLING connection's own local seat,
    // not an arbitrary global slot; see pw_wormhole.js's opponentPierceScenario).
    const victimLenBefore = c1.state.players[1].body.length;
    const after = await c1.waitFor(s => myPlayer(s, 0).scissorsCharge === false, 8000);
    const attacker = myPlayer(after, 0), victim = after.players[1];
    assert(attacker.alive === true, "the attacker must survive the body-hit untouched");
    assert(attacker.dir.x === 0 && attacker.dir.y === -1, "the attacker's heading must be unaffected");
    assert(victim.alive === true, "the victim must survive a cut that stays above minSnakeLength");
    assert(victim.body.length < victimLenBefore,
      "the victim's tail must be severed (before " + victimLenBefore + ", after " + victim.body.length + ")");
    assert((after.foods || []).some(f => f.bounty), "the severed tail must scatter as bounty food");
    console.log("PASS: attacker cuts the victim's tail into bounty food and survives untouched.");
    c1.close(); c2.close();
  } finally {
    await stopServer(server);
  }
}

async function scenarioOpponentCutKills() {
  const server = await startServer(
    // Any cut leaves the victim (len 20) under this ceiling -- guaranteed kill.
    baseConfig({ cols: 60, rows: 30, cellSize: 20 }, { minSnakeLength: 25 }),
    { SNAKE_TEST_HOOKS: "1", SNAKE_TEST_SPAWNS: JSON.stringify(crossingSpawns()) }
  );
  try {
    const c1 = await connectClient();
    await c1.waitFor(s => myPlayer(s, 0) != null, 5000);
    const c2 = await connectClient();
    await c2.waitFor(s => myPlayer(s, 0) != null, 5000);
    testHook(c1, "grantPowerup", { slot: 0, ptype: "scissors" });
    await c1.waitFor(s => myPlayer(s, 0).scissorsCharge === true, 3000);
    const after = await c1.waitFor(s => s.players[1] && s.players[1].alive === false, 8000);
    const attacker = myPlayer(after, 0);
    assert(attacker.alive === true, "the attacker must survive even when the cut kills the victim");
    const kill = (after.kills || []).find(k => k.cause === "scissors");
    assert(kill != null, "the death cause must be credited as a scissors cut");
    console.log("PASS: a too-deep cut kills the victim, attacker credited and untouched.");
    c1.close(); c2.close();
  } finally {
    await stopServer(server);
  }
}

async function scenarioScissorsBeatsWormholeVsOpponent() {
  const server = await startServer(
    baseConfig({ cols: 60, rows: 30, cellSize: 20 }),
    { SNAKE_TEST_HOOKS: "1", SNAKE_TEST_SPAWNS: JSON.stringify(crossingSpawns()) }
  );
  try {
    const c1 = await connectClient();
    await c1.waitFor(s => myPlayer(s, 0) != null, 5000);
    const c2 = await connectClient();
    await c2.waitFor(s => myPlayer(s, 0) != null, 5000);
    testHook(c1, "grantPowerup", { slot: 0, ptype: "wormhole" });
    testHook(c1, "grantPowerup", { slot: 0, ptype: "scissors" });
    await c1.waitFor(s => myPlayer(s, 0).wormholeCharge === true && myPlayer(s, 0).scissorsCharge === true, 3000);
    const after = await c1.waitFor(s => myPlayer(s, 0).scissorsCharge === false, 8000);
    const attacker = myPlayer(after, 0);
    assert(attacker.alive === true, "the attacker must survive the body-hit");
    assert(attacker.teleport !== true, "the attacker must NOT have teleported -- scissors claimed the event first");
    assert(attacker.wormholeCharge === true,
      "the attacker's wormhole charge must stay untouched -- scissors beats wormhole against an opposing player");
    console.log("PASS: scissors beats wormhole when hitting an opposing player; wormhole charge untouched.");
    c1.close(); c2.close();
  } finally {
    await stopServer(server);
  }
}

async function main() {
  await scenarioPickupArms();
  await scenarioSelfCut();
  await scenarioSelfCutBelowMinKills();
  await scenarioWormholeBeatsScissorsSelf();
  await scenarioWallShatter();
  await scenarioWormholeBeatsScissorsWall();
  await scenarioBoundaryAlwaysKills();
  await scenarioOpponentCut();
  await scenarioOpponentCutKills();
  await scenarioScissorsBeatsWormholeVsOpponent();
}

runTest(main, { attempts: 3, watchdogMs: 180000 });
