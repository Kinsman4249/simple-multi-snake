// Kill feed / death attribution e2e (v3.6.8, handoff.md item #1): asserts
// the server emits a `kills` event on the state broadcast for the death tick,
// with the right cause and killer credit -- WALL (no killer), self-inflicted
// BODY-vs-BODY (killer credited, rivalry tally starts at 1), and a mutual
// HEAD-ON (both die, no killer credit, cause "headon"). The client-side HUD
// (ui.js pushKillFeed) is DOM, not canvas -- no wasm rebuild / no parity work
// needed for this feature; these scripted WS clients cover the authoritative
// server side, which is where the attribution logic actually lives.
//
// Run: deno run --allow-net --allow-read --allow-write --allow-run --allow-env
// --unstable-detect-cjs tests/pw_killfeed.js
import { connectClient, myPlayer, sleep, startServer, stopServer, runTest, assert } from "./helpers.js";

const INTERVAL = 200; // ms per cell -- generous enough for reliable polling

// async function + await: pauses here until each Promise resolves --
// see docs/JS-CHEATSHEET.md
async function testWallDeath() {
  const server = await startServer({
    grid: { cols: 21, rows: 19, cellSize: 20 },
    move: { startIntervalMs: INTERVAL, minIntervalMs: INTERVAL, rampIntervalSec: 3600, rampStepMs: 0 },
    wallGraceTicks: 0,
    powerups: { spawnIntervalMs: 999999, wormhole: { enabled: false } }
  // JSON.stringify converts this array to text to pass as an env var --
  // see docs/JS-CHEATSHEET.md
  }, {
    SNAKE_TEST_SPAWNS: JSON.stringify([{ x: 0, y: 5, dir: "left", len: 3 }])
  });
  try {
    const c = await connectClient();
    // arrow function passed as a callback -- see docs/JS-CHEATSHEET.md
    await c.waitFor(s => myPlayer(s, 0) != null, 5000);
    const state = await c.waitFor(s => s.kills && s.kills.length > 0, INTERVAL * 10);
    const ev = state.kills.find(k => k.cause === "wall");
    assert(ev, "expected a wall-death kill event, got: " + JSON.stringify(state.kills));
    assert(ev.killer === null && ev.killerColor === null, "wall death must credit no killer");
    assert(typeof ev.victim === "string" && ev.victim.length > 0, "wall death must name the victim");
    assert(ev.victimColor && typeof ev.victimColor.head === "string", "wall death must carry the victim's color");
    console.log("PASS: wall death emits a killer-less kill event.");
    c.close();
  } finally {
    await stopServer(server);
  }
}

async function testBodyKill() {
  const server = await startServer({
    grid: { cols: 21, rows: 19, cellSize: 20 },
    move: { startIntervalMs: INTERVAL, minIntervalMs: INTERVAL, rampIntervalSec: 3600, rampStepMs: 0 },
    // B is parked nose-first against the top wall with a huge grace window,
    // so it STALLS in place (server-rust/src/sim.rs resolve_wall_collisions) instead of
    // dying -- a truly stationary body column at x=10, y=0..9, for as long
    // as this test needs. A then runs a plain open-loop straight line into
    // its flank: a deterministic T-bone, no reactive steering required.
    wallGraceTicks: 999,
    powerups: { spawnIntervalMs: 999999, wormhole: { enabled: false } }
  }, {
    SNAKE_TEST_SPAWNS: JSON.stringify([
      { x: 5, y: 5, dir: "right", len: 3 },
      { x: 10, y: 0, dir: "up", len: 10 }
    ])
  });
  try {
    const c = await connectClient();
    await c.waitFor(s => myPlayer(s, 0) != null, 5000);
    c.send({ type: "setInitials", local: 0, value: "AAA" });
    c.send({ type: "joinLocal" });
    await c.waitFor(s => myPlayer(s, 1) != null, 5000);
    c.send({ type: "setInitials", local: 1, value: "BBB" });

    const state = await c.waitFor(s => s.kills && s.kills.some(k => k.cause === "body"), INTERVAL * 20);
    const ev = state.kills.find(k => k.cause === "body");
    assert(ev.victim === "AAA", "the ramming snake (A) should be the victim, got: " + JSON.stringify(ev));
    assert(ev.killer === "BBB", "the snake whose body was hit (B) should get kill credit, got: " + JSON.stringify(ev));
    assert(ev.killerColor && typeof ev.killerColor.head === "string" && ev.killerColor.head !== ev.victimColor.head,
      "killer/victim colors should both be present and distinct");
    assert(ev.rivalryCount === 1, "first kill of this pair should start the rivalry tally at 1, got: " + ev.rivalryCount);
    console.log("PASS: a body-hit death credits the killer and starts the rivalry tally.");
    c.close();
  } finally {
    await stopServer(server);
  }
}

async function testHeadOn() {
  const R = 9;
  const server = await startServer({
    grid: { cols: 21, rows: 19, cellSize: 20 },
    move: { startIntervalMs: INTERVAL, minIntervalMs: INTERVAL, rampIntervalSec: 3600, rampStepMs: 0 },
    powerups: { spawnIntervalMs: 999999, wormhole: { enabled: false } }
  }, {
    SNAKE_TEST_SPAWNS: JSON.stringify([
      { x: 4, y: R, dir: "right", len: 3 },
      { x: 10, y: R, dir: "left", len: 3 }
    ])
  });
  try {
    const c = await connectClient();
    await c.waitFor(s => myPlayer(s, 0) != null, 5000);
    c.send({ type: "joinLocal" });
    await c.waitFor(s => myPlayer(s, 1) != null, 5000);

    const state = await c.waitFor(s => s.kills && s.kills.some(k => k.cause === "headon"), INTERVAL * 20);
    const headonEvents = state.kills.filter(k => k.cause === "headon");
    assert(headonEvents.length === 2, "a mutual head-on should emit one killer-less event per victim, got: " + JSON.stringify(state.kills));
    for (const ev of headonEvents) {
      assert(ev.killer === null && ev.killerColor === null, "a mutual head-on must credit no killer: " + JSON.stringify(ev));
    }
    console.log("PASS: a mutual head-on emits two killer-less kill events.");
    c.close();
  } finally {
    await stopServer(server);
  }
}

runTest(async () => {
  await testWallDeath();
  await testBodyKill();
  await testHeadOn();
}, { attempts: 3 });
