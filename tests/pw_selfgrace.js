// Self-collision wall-grace e2e test: the wall_grace_ticks stall (one extra
// tick before a fatal collision actually kills, server-rust/src/sim/
// collisions.rs::resolve_wall_collisions) now also applies to a snake's own
// body (resolve_self_collisions), via an independent self_stalls counter --
// same threshold/config knob, same "no grace while boosting/mid-ramp"
// exclusion, but never shares state with the wall counter. See the
// "Wall-grace tick scope" idea-backlog entry.
//
// Staging mirrors pw_scissors.js/pw_wormhole.js's self-collision scenario:
// a len-12 snake spawned heading right at (20,15) turns up, then left, then
// down -- the third turn steps the head onto its own body two cells behind
// (19,15). Body spans x=9..20 at y=15, so after "up" then "left" the head
// sits at (19,14), one cell short of the fatal (19,15) cell; that's the
// "about to hit" landmark both scenarios below measure from.
//
// Run: deno run --allow-net --allow-read --allow-write --allow-run
//      --allow-env tests/pw_selfgrace.js
import { connectClient, myPlayer, assert, startServer, stopServer, runTest, testHook } from "./helpers.js";

function baseConfig(wallGraceTicks) {
  return {
    maxPlayers: 4,
    grid: { cols: 80, rows: 30, cellSize: 20 },
    move: { startIntervalMs: 120, minIntervalMs: 120, rampIntervalSec: 3600, rampStepMs: 0 },
    boost: { enabled: true, rampMs: 0, holdGraceMs: 0 },
    minSnakeLength: 3,
    wallGraceTicks,
    enableDebug: false,
    powerups: {
      spawnIntervalMs: 3600000, maxConcurrentPickups: 8,
      wormhole: { enabled: false }, scissors: { enabled: false },
      growthSpurt: { enabled: false }, iceTrail: { enabled: false },
      poisonTrail: { enabled: false }, speedBoost: { enabled: false },
      blueShell: { enabled: false }, bananaTrail: { enabled: false }
    }
  };
}

const SPAWN = [{ x: 20, y: 15, dir: "right", len: 12 }];

// Turns the staged snake up, then left, waits for the head to land on the
// pre-collision cell (19,14), and returns {client, server, preSeq}.
async function stageAtPreCollision(wallGraceTicks) {
  const server = await startServer(
    baseConfig(wallGraceTicks),
    { SNAKE_TEST_HOOKS: "1", SNAKE_TEST_SPAWNS: JSON.stringify(SPAWN) }
  );
  const c1 = await connectClient();
  // `s => ...` is an arrow function callback (see docs/JS-CHEATSHEET.md).
  await c1.waitFor(s => myPlayer(s, 0) != null, 5000);
  c1.send({ type: "dir", dir: "up", local: 0 });
  c1.send({ type: "dir", dir: "left", local: 0 });
  const pre = await c1.waitFor(s => {
    const p = myPlayer(s, 0);
    return p && p.body[0].x === 19 && p.body[0].y === 14;
  }, 5000);
  const p = myPlayer(pre, 0);
  assert(p.alive === true, "snake must still be alive at the pre-collision cell");
  return { server, c1, preSeq: pre.seq };
}

// --- Scenario 1: no grace (wallGraceTicks: 0) -- dies on the very next tick
async function scenarioNoGrace() {
  // Destructuring: pulls server/c1/preSeq out of the returned object in one
  // step (see docs/JS-CHEATSHEET.md, "Destructuring").
  const { server, c1, preSeq } = await stageAtPreCollision(0);
  try {
    c1.send({ type: "dir", dir: "down", local: 0 }); // steps onto own body
    const dead = await c1.waitFor(s => { const p = myPlayer(s, 0); return p && p.alive === false; }, 5000);
    assert(dead.seq - preSeq === 1,
      "with wallGraceTicks:0 a self-collision must kill with NO stall (died " + (dead.seq - preSeq) + " seqs after the pre-collision cell)");
    // `dead.kills || []` falls back to an empty array if kills is missing --
    // see docs/JS-CHEATSHEET.md, "Nullish coalescing / defaults `a || b`".
    const kill = (dead.kills || []).find(k => k.cause === "self");
    assert(kill != null, "death cause must be 'self' (got " + JSON.stringify(dead.kills) + ")");
    console.log("PASS: wallGraceTicks:0 gives a self-collision no grace stall.");
  } finally {
    c1.close();
    await stopServer(server);
  }
}

// --- Scenario 2: default grace (wallGraceTicks: 1) -- one extra stall tick
async function scenarioWithGrace() {
  const { server, c1, preSeq } = await stageAtPreCollision(1);
  try {
    c1.send({ type: "dir", dir: "down", local: 0 }); // steps onto own body
    // The stall tick: head must hold at (19,14), still alive, one seq later.
    const stalled = await c1.waitFor(s => s.seq === preSeq + 1, 4000);
    const sp = myPlayer(stalled, 0);
    assert(sp.alive === true, "the grace tick must not kill the snake immediately");
    assert(sp.body[0].x === 19 && sp.body[0].y === 14,
      "the grace tick must hold the head in place, not step onto the body (got " + JSON.stringify(sp.body[0]) + ")");
    const dead = await c1.waitFor(s => { const p = myPlayer(s, 0); return p && p.alive === false; }, 5000);
    assert(dead.seq - preSeq === 2,
      "with wallGraceTicks:1 a self-collision must die exactly one tick after the stall (died " + (dead.seq - preSeq) + " seqs after the pre-collision cell)");
    const kill = (dead.kills || []).find(k => k.cause === "self");
    assert(kill != null, "death cause must still be 'self' after the grace tick (got " + JSON.stringify(dead.kills) + ")");
    console.log("PASS: wallGraceTicks:1 gives a self-collision one grace stall tick before dying.");
  } finally {
    c1.close();
    await stopServer(server);
  }
}

async function main() {
  await scenarioNoGrace();
  await scenarioWithGrace();
}

runTest(main, { attempts: 3, watchdogMs: 60000 });
