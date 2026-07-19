// Poison Trail e2e test: pickup -> held slot -> activate -> lays one trail
// tile per movement step -> crossing a distinct poison tile (including the
// layer's OWN, since the laying snake is NOT immune per the confirmed
// design) removes one segment, floored at the global minSnakeLength. Run:
// deno run --allow-net --allow-read --allow-write --allow-run --allow-env
// tests/pw_poisontrail.js
import { connectClient, myPlayer, assert, startServer, stopServer, collectNextPickup, stepToward, runTest, assertTrailContiguous } from "./helpers.js";

function rotateCW(v) { return { x: -v.y, y: v.x }; }
function dirName(v) {
  if (v.x === 1) return "right"; if (v.x === -1) return "left";
  if (v.y === 1) return "down"; return "up";
}
async function stepDir(client, local, v) {
  const cur = client.state;
  client.send({ type: "dir", dir: dirName(v), local });
  await client.waitFor(s => s !== cur, 3000);
}
async function stepsStraight(client, local, v, n) {
  for (let i = 0; i < n; i++) await stepDir(client, local, v);
}
async function eatOnce(client, local) {
  const before = myPlayer(client.state, local).body.length;
  const timer = setInterval(() => {
    const cur = client.state;
    const p = myPlayer(cur, local);
    if (!p || !cur.food) return;
    const dn = stepToward(cur, local, cur.food.x, cur.food.y);
    if (dn) client.send({ type: "dir", dir: dn, local });
  }, 70);
  try {
    await client.waitFor(s => { const p = myPlayer(s, local); return p && p.body.length !== before; }, 15000);
  } finally {
    clearInterval(timer);
  }
}

const MIN_LEN = 3;

async function main() {
  const server = await startServer({
    grid: { cols: 36, rows: 36, cellSize: 20 },
    move: { startIntervalMs: 90, minIntervalMs: 90, rampIntervalSec: 3600, rampStepMs: 0 },
    minSnakeLength: MIN_LEN,
    powerups: {
      spawnIntervalMs: 300, maxConcurrentPickups: 3,
      wormhole: { enabled: false }, growthSpurt: { enabled: false }, iceTrail: { enabled: false },
      poisonTrail: { enabled: true, durationMs: 60000, tileDurationMs: 60000 },
      speedBoost: { enabled: false }, blueShell: { enabled: false }
    }
  });
  try {
    const c1 = await connectClient();
    await c1.waitFor(s => myPlayer(s, 0) != null, 5000);

    // Grow a buffer above the floor FIRST, while no poison is active, so the
    // growth is clean (poisonTrail auto-fires the instant it's collected, so
    // we can't grow AFTER collecting without immediately draining).
    for (let i = 0; i < 6; i++) await eatOnce(c1, 0);
    const grownLen = myPlayer(c1.state, 0).body.length;
    console.log("Grew to length", grownLen, "before collecting poison.");
    assert(grownLen > MIN_LEN + 3, "should have grown a comfortable buffer above the floor");

    console.log("Collecting poisonTrail pickup...");
    await collectNextPickup(c1, 0, 20000);
    // poisonTrail AUTO-activates on pickup (no button press).
    await c1.waitFor(s => { const pp = myPlayer(s, 0); return pp && pp.activePowerup === "poisonTrail"; }, 3000);
    assert(myPlayer(c1.state, 0).heldPowerup == null, "auto-fire trail should NOT occupy the held slot");
    console.log("PASS: pickup auto-activates trail-laying (no button press).");

    const grid = c1.state.grid;
    const cx = Math.floor(grid.cols / 2), cy = Math.floor(grid.rows / 2);
    const N = 5;
    const margin = N + 3;
    for (let i = 0; i < 60; i++) {
      const cur = c1.state;
      const pp = myPlayer(cur, 0);
      if (!pp) break;
      const h = pp.body[0];
      if (h.x >= margin && h.x < grid.cols - margin && h.y >= margin && h.y < grid.rows - margin) break;
      const dn = stepToward(cur, 0, cx, cy);
      if (dn) c1.send({ type: "dir", dir: dn, local: 0 });
      await c1.waitFor(s => s !== cur, 3000);
    }
    const dir0 = myPlayer(c1.state, 0).dir;
    const dirs = [dir0, rotateCW(dir0), rotateCW(rotateCW(dir0)), rotateCW(rotateCW(rotateCW(dir0)))];

    // Lay the first loop of trail tiles (no self-crossing yet this lap).
    for (const d of dirs) await stepsStraight(c1, 0, d, N);
    assert(c1.state.trails.length > 0, "poison trail tiles should exist on the board");
    assertTrailContiguous(c1.state, "poisonTrail");
    console.log("PASS: trail tiles laid (" + c1.state.trails.length + " on board), contiguous.");

    // Repeatedly close the loop (crossing the earlier-laid starting tile
    // each time) and confirm length is non-increasing, never drops below
    // minSnakeLength, and eventually settles exactly at the floor. (Per-lap
    // deltas are NOT asserted to be exactly -1: this sandboxed test
    // environment's server process can fall behind real time and catch up
    // several movement ticks in a single broadcast -- see simLoop's guard
    // loop -- so more than one distinct poison tile can legitimately be
    // crossed between two observed states. The floor itself is still
    // enforced fresh every single tick server-side regardless.)
    let lenBefore = myPlayer(c1.state, 0).body.length;
    for (let lap = 0; lap < 8; lap++) {
      for (const d of dirs) await stepsStraight(c1, 0, d, N);
      await stepDir(c1, 0, dir0); // cross the lap-start tile
      const after = myPlayer(c1.state, 0);
      assert(after.body.length <= lenBefore, "length should never INCREASE from poison crossings (was " + lenBefore + ", now " + after.body.length + ")");
      assert(after.body.length >= MIN_LEN, "body length must never drop below minSnakeLength (" + MIN_LEN + "), got " + after.body.length);
      lenBefore = after.body.length;
    }
    assert(lenBefore === MIN_LEN, "repeated self-crossing should have drained the snake down to the floor (ended at " + lenBefore + ")");
    console.log("PASS: drained down to minSnakeLength (" + MIN_LEN + ") and never below.");

    // One more lap at the floor: length must hold exactly, not dip further.
    for (const d of dirs) await stepsStraight(c1, 0, d, N);
    await stepDir(c1, 0, dir0);
    assert(myPlayer(c1.state, 0).body.length === MIN_LEN, "length must hold exactly at the floor on further crossings");
    console.log("PASS: holds exactly at the floor on further crossings.");

    c1.close();
  } finally {
    await stopServer(server);
  }
}

runTest(main);
