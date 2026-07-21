// Wormhole e2e test (2026-07-20 directional-phasing rework): pickup arms
// the independent charge, then a fatal collision auto-fires it instead of
// killing the snake. New mechanics under test:
//   - board edges wrap to the opposite edge on the same axis, vector kept
//   - dynamic walls / own body / other snakes are phased straight through
//     (multi-segment runs included) to the first escapable cell beyond,
//     and cramped pockets right behind an obstacle are bypassed too
//   - purple portal markers (state.portalFx) appear at entry+exit and stay
//     until the tail finishes threading through (then a short linger)
// Also still covers SELF-collision rescues (plain and while boosting) and
// the per-segment threading drain, staged deterministically with
// SNAKE_TEST_SPAWNS + testHook. Run:
// deno run --allow-net --allow-read --allow-write --allow-run --allow-env
// tests/pw_wormhole.js
import { connectClient, myPlayer, assert, sleep, startServer, stopServer, collectNextPickup, runTest, testHook } from "./helpers.js";

// Self-collision rescue: len-12 snake heading right, three queued turns
// (up, left, down) walk the head straight into its own body two steps
// behind. With a charge armed the interception must teleport it instead.
async function selfCollisionScenario(withBoost) {
  const server = await startServer({
    maxPlayers: 4,
    grid: { cols: 80, rows: 30, cellSize: 20 },
    move: { startIntervalMs: 150, minIntervalMs: 150, rampIntervalSec: 3600, rampStepMs: 0 },
    boost: { enabled: true, rampMs: 0, holdGraceMs: 0 },
    minSnakeLength: 3,
    enableDebug: false,
    powerups: { spawnIntervalMs: 3600000, maxConcurrentPickups: 8 }
  }, { SNAKE_TEST_HOOKS: "1", SNAKE_TEST_SPAWNS: JSON.stringify([{ x: 20, y: 15, dir: "right", len: 12 }]) });
  try {
    const c1 = await connectClient();
    await c1.waitFor(s => myPlayer(s, 0) != null, 5000);
    testHook(c1, "grantPowerup", { slot: 0, ptype: "wormhole" });
    await c1.waitFor(s => myPlayer(s, 0).wormholeCharge === true, 3000);
    if (withBoost) {
      c1.send({ type: "boost", on: true, local: 0 });
      await sleep(400);
    }
    c1.send({ type: "dir", dir: "up", local: 0 });
    c1.send({ type: "dir", dir: "left", local: 0 });
    c1.send({ type: "dir", dir: "down", local: 0 }); // steps onto own body
    const result = await c1.waitFor(s => {
      const p = myPlayer(s, 0);
      return p && (p.teleport === true || p.alive === false || p.wormholeCharge === false);
    }, 8000);
    const after = myPlayer(result, 0);
    assert(after.alive === true, "snake must survive its own body via wormhole" + (withBoost ? " (boosting)" : ""));
    assert(after.wormholeCharge === false, "charge must be consumed by the self-collision rescue");
    console.log("PASS: wormhole rescued a self-collision" + (withBoost ? " while boosting" : "") + ".");
    c1.close();
  } finally {
    await stopServer(server);
  }
}

// v3.6.0 regression guard: a snake must stay alive through the ENTIRE
// segment-by-segment drain of a self-body wormhole, not just the fire step.
// The body is discontinuous during the transition (head at the landing, tail
// still draining through the entry), which previously read as a false wall/
// self collision partway through. Big empty board + no food + no boost so the
// only way to die in the watch window is the regression.
async function transitionSurvivalScenario() {
  const LEN = 10;
  const server = await startServer({
    maxPlayers: 4,
    grid: { cols: 120, rows: 120, cellSize: 20 },
    move: { startIntervalMs: 120, minIntervalMs: 120 },
    boost: { enabled: true, rampMs: 0, holdGraceMs: 0 },
    minSnakeLength: 3,
    enableDebug: false,
    maxConcurrentFood: 0, // no food: length stays LEN, drain count deterministic
    powerups: { spawnIntervalMs: 3600000, maxConcurrentPickups: 8 }
  }, { SNAKE_TEST_HOOKS: "1", SNAKE_TEST_SPAWNS: JSON.stringify([{ x: 60, y: 60, dir: "right", len: LEN }]) });
  try {
    const c1 = await connectClient();
    await c1.waitFor(s => myPlayer(s, 0) != null, 5000);
    testHook(c1, "grantPowerup", { slot: 0, ptype: "wormhole" });
    await c1.waitFor(s => myPlayer(s, 0).wormholeCharge === true, 3000);
    c1.send({ type: "dir", dir: "up", local: 0 });
    c1.send({ type: "dir", dir: "left", local: 0 });
    c1.send({ type: "dir", dir: "down", local: 0 }); // steps onto own body -> fires
    const fired = await c1.waitFor(s => {
      const p = myPlayer(s, 0);
      return p && (p.teleport === true || p.wormholeCharge === false);
    }, 8000);
    assert(myPlayer(fired, 0).alive === true, "wormhole must rescue the self-collision");
    // Alive must hold on EVERY broadcast until the body has fully threaded
    // through (>= LEN + 2 movement steps past the fire).
    const target = fired.seq + LEN + 2;
    let last = fired;
    while (last.seq < target) {
      last = await c1.waitFor(s => s.seq > last.seq, 5000);
      assert(myPlayer(last, 0).alive === true,
        "snake must stay alive through the WHOLE wormhole transition (died at seq " + last.seq + ")");
    }
    console.log("PASS: snake threads fully through a self-body wormhole with no false collision.");
    c1.close();
  } finally {
    await stopServer(server);
  }
}

// Shared config for the staged geometry scenarios below: fixed cadence, no
// random walls/pickups/food interfering with exact-cell assertions.
function stagedCfg(extra) {
  return Object.assign({
    maxPlayers: 4,
    grid: { cols: 40, rows: 20, cellSize: 20 },
    move: { startIntervalMs: 100, minIntervalMs: 100, rampIntervalSec: 3600, rampStepMs: 0 },
    boost: { enabled: true, rampMs: 0, holdGraceMs: 0 },
    minSnakeLength: 3,
    enableDebug: false,
    maxConcurrentFood: 0,
    walls: { enabled: false }, // spawnWall testHook still works when disabled
    powerups: { spawnIntervalMs: 3600000, maxConcurrentPickups: 8 }
  }, extra || {});
}

// Scenario B (board edge): hitting the left edge must exit at the RIGHT
// edge on the same row, vector preserved, with portal markers at both
// boundary cells.
async function edgeWrapScenario() {
  const server = await startServer(stagedCfg(), {
    SNAKE_TEST_HOOKS: "1",
    SNAKE_TEST_SPAWNS: JSON.stringify([{ x: 5, y: 10, dir: "left", len: 4 }])
  });
  try {
    const c1 = await connectClient();
    await c1.waitFor(s => myPlayer(s, 0) != null, 5000);
    testHook(c1, "grantPowerup", { slot: 0, ptype: "wormhole" });
    await c1.waitFor(s => myPlayer(s, 0).wormholeCharge === true, 3000);
    // No steering: the snake drives itself into the left edge.
    const fired = await c1.waitFor(s => {
      const p = myPlayer(s, 0);
      return p && (p.teleport === true || p.alive === false);
    }, 8000);
    const p = myPlayer(fired, 0);
    assert(p.alive === true, "edge hit must teleport, not kill");
    assert(p.body[0].x === 39 && p.body[0].y === 10,
      "edge wrap must land on the opposite edge, same row (got " + p.body[0].x + "," + p.body[0].y + ")");
    assert(p.dir.x === -1 && p.dir.y === 0, "movement vector must be preserved through the edge wrap");
    const cells = (fired.portalFx || []).map(q => q.x + "," + q.y);
    assert(cells.includes("0,10"), "entry portal must sit on the edge cell (0,10); got " + cells.join(" "));
    assert(cells.includes("39,10"), "exit portal must sit on the landing cell (39,10); got " + cells.join(" "));
    console.log("PASS: board-edge wormhole wraps to the opposite edge with portals at both ends.");
    c1.close();
  } finally {
    await stopServer(server);
  }
}

// Dynamic walls + the pocket-bypass rule: a two-cell wall block directly
// ahead, then a spike-walled pocket right behind it. The phase must skip
// the whole block AND the enclosed pocket cell (28,10) -- "not realistic
// to get out" -- and exit at the first open cell (30,10).
async function dynamicWallScenario() {
  const server = await startServer(stagedCfg(), {
    SNAKE_TEST_HOOKS: "1",
    SNAKE_TEST_SPAWNS: JSON.stringify([{ x: 20, y: 10, dir: "right", len: 4 }])
  });
  try {
    const c1 = await connectClient();
    await c1.waitFor(s => myPlayer(s, 0) != null, 5000);
    // Wall block ahead of the snake...
    testHook(c1, "spawnWall", { x: 26, y: 10 });
    testHook(c1, "spawnWall", { x: 27, y: 10 });
    // ...then a pocket behind it: (28,10) is free but boxed in ahead/above/
    // below, so it must be bypassed.
    testHook(c1, "spawnWall", { x: 28, y: 9 });
    testHook(c1, "spawnWall", { x: 28, y: 11 });
    testHook(c1, "spawnWall", { x: 29, y: 10 });
    testHook(c1, "grantPowerup", { slot: 0, ptype: "wormhole" });
    await c1.waitFor(s => myPlayer(s, 0).wormholeCharge === true, 3000);
    const fired = await c1.waitFor(s => {
      const p = myPlayer(s, 0);
      return p && (p.teleport === true || p.alive === false);
    }, 8000);
    const p = myPlayer(fired, 0);
    assert(p.alive === true, "solid wall hit must teleport, not kill");
    assert(p.body[0].x === 30 && p.body[0].y === 10,
      "phase must skip the wall block AND the enclosed pocket, landing at (30,10); got (" +
      p.body[0].x + "," + p.body[0].y + ")");
    assert(p.dir.x === 1 && p.dir.y === 0, "movement vector must be preserved through the wall");
    const cells = (fired.portalFx || []).map(q => q.x + "," + q.y);
    assert(cells.includes("26,10"), "entry portal must sit on the first wall cell (26,10); got " + cells.join(" "));
    assert(cells.includes("30,10"), "exit portal must sit on the landing cell (30,10); got " + cells.join(" "));
    console.log("PASS: dynamic-wall phase pierces the block, bypasses the pocket, portals at entry/exit.");
    c1.close();
  } finally {
    await stopServer(server);
  }
}

// Portal lifecycle: the pair stays in the broadcast while the tail is
// still threading through the entry, then clears (drain + linger).
async function portalLifecycleScenario() {
  const LEN = 8;
  const server = await startServer(stagedCfg({ grid: { cols: 40, rows: 20, cellSize: 20 } }), {
    SNAKE_TEST_HOOKS: "1",
    SNAKE_TEST_SPAWNS: JSON.stringify([{ x: 6, y: 10, dir: "left", len: LEN }])
  });
  try {
    const c1 = await connectClient();
    await c1.waitFor(s => myPlayer(s, 0) != null, 5000);
    testHook(c1, "grantPowerup", { slot: 0, ptype: "wormhole" });
    await c1.waitFor(s => myPlayer(s, 0).wormholeCharge === true, 3000);
    const fired = await c1.waitFor(s => myPlayer(s, 0) && myPlayer(s, 0).teleport === true, 8000);
    assert((fired.portalFx || []).length === 2, "exactly one entry+exit portal pair after fire");
    // Mid-drain (a couple of steps in) the portals must still be there.
    const mid = await c1.waitFor(s => s.seq >= fired.seq + 2, 5000);
    assert((mid.portalFx || []).length === 2, "portals must persist while the tail is threading through");
    // After the full drain (LEN-1 steps) plus the 600ms linger, gone.
    await c1.waitFor(s => s.seq >= fired.seq + LEN + 2, 8000);
    await sleep(900);
    assert((c1.state.portalFx || []).length === 0, "portals must close after the drain + linger");
    console.log("PASS: portals persist through the threading drain, then close.");
    c1.close();
  } finally {
    await stopServer(server);
  }
}

// Scenario D (another player's body): driving into an opponent's snake
// with a charge must phase through to the safe cell on the far side,
// vector preserved, with portals at the entry and exit. Staged as a
// perpendicular crossing of a LONG horizontal opponent so the contact
// cell stays occupied under either tick alignment: slot 0 climbs up
// column 34, slot 1's 20-segment body sweeps right along row 14 and
// covers x=34 for many ticks around the collision window.
async function opponentPierceScenario() {
  const server = await startServer(stagedCfg({ grid: { cols: 60, rows: 30, cellSize: 20 } }), {
    SNAKE_TEST_HOOKS: "1",
    SNAKE_TEST_SPAWNS: JSON.stringify([
      { x: 34, y: 20, dir: "up", len: 3 },
      // Opponent: head (46,14) moving right, body trailing back through
      // (27..46,14). By the time slot 0 reaches row 14 (6 steps), the body
      // still covers x=34 with a wide margin either side.
      { x: 46, y: 14, dir: "right", len: 20 }
    ])
  });
  try {
    const c1 = await connectClient();
    await c1.waitFor(s => myPlayer(s, 0) != null, 5000);
    const c2 = await connectClient();
    await c2.waitFor(s => myPlayer(s, 0) != null, 5000);
    testHook(c1, "grantPowerup", { slot: 0, ptype: "wormhole" });
    await c1.waitFor(s => myPlayer(s, 0).wormholeCharge === true, 3000);
    const fired = await c1.waitFor(s => {
      const p = myPlayer(s, 0);
      return p && (p.teleport === true || p.alive === false);
    }, 8000);
    const p = myPlayer(fired, 0);
    assert(p.alive === true, "opponent body hit must teleport, not kill");
    assert(p.dir.x === 0 && p.dir.y === -1, "movement vector must be preserved through the opponent");
    assert(p.body[0].x === 34 && p.body[0].y === 13,
      "must exit at the first safe cell past the opponent, (34,13); got (" + p.body[0].x + "," + p.body[0].y + ")");
    const opp = myPlayer(c2.state, 0) || fired.players[1];
    assert(!opp.body.some(seg => seg.x === p.body[0].x && seg.y === p.body[0].y),
      "landing must not overlap the opponent's body");
    const cells = (fired.portalFx || []).map(q => q.x + "," + q.y);
    assert(cells.includes("34,14"), "entry portal must sit on the contact cell (34,14); got " + cells.join(" "));
    assert(cells.includes("34,13"), "exit portal must sit on the landing cell (34,13); got " + cells.join(" "));
    console.log("PASS: opponent-body phase exits clean on the far side, vector preserved.");
    c1.close();
    c2.close();
  } finally {
    await stopServer(server);
  }
}

async function main() {
  const server = await startServer({
    grid: { cols: 12, rows: 12, cellSize: 20 },
    move: { startIntervalMs: 60, minIntervalMs: 60, rampIntervalSec: 3600, rampStepMs: 0 },
    powerups: {
      spawnIntervalMs: 300, maxConcurrentPickups: 3,
      wormhole: { enabled: true, lookaheadDepth: 3 },
      growthSpurt: { enabled: false }, iceTrail: { enabled: false },
      poisonTrail: { enabled: false }, speedBoost: { enabled: false }, blueShell: { enabled: false }
    }
  });
  try {
    const c1 = await connectClient();
    await c1.waitFor(s => myPlayer(s, 0) != null, 5000);

    console.log("Collecting wormhole pickup...");
    await collectNextPickup(c1, 0, 20000);
    let p = myPlayer(c1.state, 0);
    assert(p.wormholeCharge === true, "pickup should arm wormholeCharge");
    console.log("Armed. Driving into a wall...");

    // Let the snake continue on its current heading (no further steering)
    // until it either dies or the wormhole fires -- in a 12x12 bounded grid
    // it must reach a wall eventually.
    const result = await c1.waitFor(s => {
      const pp = myPlayer(s, 0);
      return pp && (pp.teleport === true || pp.alive === false);
    }, 20000);
    const after = myPlayer(result, 0);
    assert(after.alive === true, "snake should survive via wormhole, not die at the wall");
    assert(after.teleport === true, "state should carry a one-shot teleport flag");
    assert(after.wormholeCharge === false, "charge must be consumed on fire");
    // Per-segment threading (v3.4.0): ONLY the head exits at the landing;
    // the body drains through the entry afterwards. The old whole-body
    // relocation rebuilt body[n] = landing - dir*n exactly -- with threading
    // body[1] is the snake's OLD head (still on the entry side), never the
    // cell directly behind the landing along the exit direction.
    const head = after.body[0], neck = after.body[1], d = after.dir;
    assert(!(neck.x === head.x - d.x && neck.y === head.y - d.y),
      "body must thread through the wormhole (old head trailing), not relocate wholesale behind the landing");
    console.log("PASS: wormhole fired, snake survived, charge consumed, body threads per-segment.");

    // The teleport flag must be one-shot: the NEXT broadcast should not
    // still carry it.
    await sleep(200);
    const next = c1.state;
    const nextP = myPlayer(next, 0);
    assert(!nextP.teleport, "teleport flag must clear after one broadcast");
    console.log("PASS: teleport flag is one-shot.");

    c1.close();
  } finally {
    await stopServer(server);
  }

  await selfCollisionScenario(false);
  await selfCollisionScenario(true);
  await transitionSurvivalScenario();
  await edgeWrapScenario();
  await dynamicWallScenario();
  await portalLifecycleScenario();
  await opponentPierceScenario();
}

runTest(main);
