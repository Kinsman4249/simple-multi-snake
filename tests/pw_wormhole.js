// Wormhole e2e test: pickup arms the independent charge, then a fatal wall
// collision auto-fires it (teleport, no death, charge consumed) instead of
// killing the snake. Also covers SELF-collision rescues (plain and while
// boosting), staged deterministically with SNAKE_TEST_SPAWNS + testHook
// (maintainer-confirmed 2026-07-16: the charge must save you from your own
// body exactly like it saves you from a wall). Run:
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
}

runTest(main);
