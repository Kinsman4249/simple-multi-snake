// Momentum drift e2e test (v3.4.0): speed is per-snake STATE, not boost-key
// state. Releasing boost at speed keeps the snake fast while it decelerates
// over boost.decelMs (multi-frame, faster than the ramp-up), and drift
// eligibility follows the SPEED: a turn made just after release still skids
// (momentum >= driftThreshold), while a turn after the decay has finished is
// a plain turn with no skid.
// Run: deno run --allow-net --allow-read --allow-write --allow-run
//      --allow-env tests/pw_momentum.js
import { connectClient, myPlayer, assert, sleep, startServer, stopServer, runTest } from "./helpers.js";

const COLS = 64, ROWS = 32;
const INTERVAL = 120;
const BOOST = { enabled: true, boostSpeed: 2, driftMs: 400, rampMs: 200, holdGraceMs: 0, decelMs: 400, driftThreshold: 0.3 };

// async function + await: pauses here until each Promise resolves --
// see docs/JS-CHEATSHEET.md
async function ensureHeadingRight(client) {
  let p = myPlayer(client.state, 0);
  if (p.dir.x === 1) return;
  if (p.dir.x === -1) {
    const perp = p.body[0].y > ROWS / 2 ? "up" : "down";
    client.send({ type: "dir", dir: perp, local: 0 });
    // arrow function passed as a callback -- see docs/JS-CHEATSHEET.md
    await client.waitFor(s => myPlayer(s, 0).dir.x === 0, 3000);
  }
  client.send({ type: "dir", dir: "right", local: 0 });
  await client.waitFor(s => myPlayer(s, 0).dir.x === 1, 3000);
}

async function main() {
  const server = await startServer({
    grid: { cols: COLS, rows: ROWS, cellSize: 20 },
    move: { startIntervalMs: INTERVAL, minIntervalMs: INTERVAL, rampIntervalSec: 3600, rampStepMs: 0 },
    boost: BOOST,
    powerups: { spawnIntervalMs: 600000 }
  // JSON.stringify converts this array to text to pass as an env var --
  // see docs/JS-CHEATSHEET.md
  }, { SNAKE_TEST_SPAWNS: JSON.stringify([{ x: 8, y: 16, dir: "right" }]) });
  try {
    const c1 = await connectClient();
    await c1.waitFor(s => myPlayer(s, 0) != null, 5000);

    // ---- Part A: releasing boost keeps momentum, then decays to base ----
    await ensureHeadingRight(c1);
    c1.send({ type: "boost", on: true, local: 0 });
    const fullMoveMs = Math.round(INTERVAL / BOOST.boostSpeed);
    await c1.waitFor(s => { const p = myPlayer(s, 0); return p && Math.abs(p.moveMs - fullMoveMs) <= 5; }, 4000);
    c1.send({ type: "boost", on: false, local: 0 });
    // Right after release the snake must STILL be fast (mid-decay moveMs
    // strictly between full boost and base speed on some broadcast).
    let sawMomentum = false;
    const watchUntil = Date.now() + BOOST.decelMs;
    while (Date.now() < watchUntil) {
      const p = myPlayer(c1.state, 0);
      if (p && p.moveMs > fullMoveMs + 5 && p.moveMs < INTERVAL - 10) { sawMomentum = true; break; }
      await sleep(20);
    }
    assert(sawMomentum, "released boost must decay through intermediate speeds, not snap to base");
    await c1.waitFor(s => { const p = myPlayer(s, 0); return p && p.moveMs >= INTERVAL - 3; }, 3000);
    console.log("PASS: boost release keeps momentum and decays back to base over decelMs.");

    // ---- Part B: a turn just after release still drifts ----
    await ensureHeadingRight(c1);
    c1.send({ type: "boost", on: true, local: 0 });
    await c1.waitFor(s => { const p = myPlayer(s, 0); return p && Math.abs(p.moveMs - fullMoveMs) <= 5; }, 4000);
    c1.send({ type: "boost", on: false, local: 0 });
    await sleep(60); // well inside the decay, momentum still >= threshold
    c1.send({ type: "dir", dir: "down", local: 0 });
    await c1.waitFor(s => { const p = myPlayer(s, 0); return p && p.sliding === true; }, 2000);
    console.log("PASS: turn made after boost release still skids (drift follows speed, not the key).");
    await c1.waitFor(s => { const p = myPlayer(s, 0); return p && p.sliding === false; }, 5000);

    // ---- Part C: after the decay finishes, a turn is a plain turn ----
    await sleep(BOOST.decelMs + 300); // momentum fully decayed
    await ensureHeadingRight(c1);
    c1.send({ type: "dir", dir: "up", local: 0 });
    let slid = false;
    const calmUntil = Date.now() + 800;
    while (Date.now() < calmUntil) {
      const p = myPlayer(c1.state, 0);
      if (p && p.sliding === true) { slid = true; break; }
      await sleep(30);
    }
    assert(!slid, "a turn made after momentum has decayed below the threshold must not skid");
    console.log("PASS: no skid once momentum has decayed below driftThreshold.");

    c1.close();
  } finally {
    await stopServer(server);
  }
}

runTest(main);
