// Boost drift e2e test (round fifteen redesign): a turn made while boosting
// applies to the HEAD immediately (no more delayed-turn slide), the body
// skids sideways in the old travel direction for boost.driftMs (visible as
// the head moving diagonally while `sliding` is broadcast true), and boost
// forfeits the wall-grace stall (boosted wall hit dies one seq after
// reaching the last column; unboosted still gets the one-tick stall).
// Run: deno run --allow-net --allow-read --allow-write --allow-run
// --allow-env tests/pw_boostdrift.js
//
// In plain terms: this checks how the snake handles boosting and turning
// at the same time. Turning while boosted should turn the head right away,
// but the body should keep skidding sideways in the old direction for a
// short window (the "drift"), and hitting a wall while boosted should kill
// the snake instantly instead of getting the usual one-tick grace period.
import { connectClient, myPlayer, assert, sleep, stepToward, startServer, stopServer, runTest } from "./helpers.js";

const COLS = 48, ROWS = 28;

// Steers unboosted to roughly (tx,ty) using the shared greedy helper.
async function steerTo(client, tx, ty, timeoutMs) {
  const deadline = Date.now() + (timeoutMs || 20000);
  while (Date.now() < deadline) {
    const cur = client.state;
    const p = myPlayer(cur, 0);
    if (!p) throw new Error("seat not playing");
    const head = p.body[0];
    if (Math.abs(head.x - tx) <= 1 && Math.abs(head.y - ty) <= 1) return;
    const dirName = stepToward(cur, 0, tx, ty);
    if (dirName) client.send({ type: "dir", dir: dirName, local: 0 });
    // s => s !== cur is an arrow function (see docs/JS-CHEATSHEET.md);
    // .catch(() => {}) swallows the timeout error if we never see a new state
    await client.waitFor(s => s !== cur, 2000).catch(() => {});
  }
  throw new Error("timed out steering to staging point");
}

// Points the snake right (perpendicular first if it is currently going left).
async function ensureHeadingRight(client) {
  let p = myPlayer(client.state, 0);
  if (p.dir.x === 1) return;
  if (p.dir.x === -1) {
    const perp = p.body[0].y > ROWS / 2 ? "up" : "down";
    client.send({ type: "dir", dir: perp, local: 0 });
    await client.waitFor(s => myPlayer(s, 0).dir.x === 0, 3000);
  }
  client.send({ type: "dir", dir: "right", local: 0 });
  await client.waitFor(s => myPlayer(s, 0).dir.x === 1, 3000);
}

async function main() {
  const server = await startServer({
    grid: { cols: COLS, rows: ROWS, cellSize: 20 },
    move: { startIntervalMs: 120, minIntervalMs: 120, rampIntervalSec: 3600, rampStepMs: 0 },
    // rampMs/holdGraceMs 0 pin the pre-ramp instant-boost behavior this
    // test's drift-length assertions were written against; the ramp/grace
    // mechanics have their own test (pw_boostramp.js).
    boost: { enabled: true, boostSpeed: 2, driftMs: 360, rampMs: 0, holdGraceMs: 0 },
    wallGraceTicks: 1,
    spectatorPromoteDelayMs: 200,
    powerups: { spawnIntervalMs: 600000 } // no pickups wandering into the staging
  });
  try {
    const c1 = await connectClient();
    await c1.waitFor(s => myPlayer(s, 0) != null, 5000);

    // ---- Part A: immediate head turn + sideways body skid ----
    await steerTo(c1, 12, 8, 25000);
    await ensureHeadingRight(c1);
    c1.send({ type: "boost", on: true, local: 0 });
    await c1.waitFor(s => { const p = myPlayer(s, 0); return p && p.boost === true; }, 3000);
    const settleSeq = c1.state.seq;
    await c1.waitFor(s => s.seq >= settleSeq + 2, 3000); // settle into the boosted straight run
    const s0 = c1.state;
    const seq0 = s0.seq;
    c1.send({ type: "dir", dir: "down", local: 0 });
    const s1 = await c1.waitFor(s => { const p = myPlayer(s, 0); return p && p.dir.y === 1; }, 3000);
    assert(s1.seq - seq0 <= 4,
      "head must turn immediately, not after a multi-cell slide (turned after " + (s1.seq - seq0) + " seqs)");
    console.log("PASS: boosted turn applied to the head within " + (s1.seq - seq0) + " movement steps.");

    const sA = await c1.waitFor(s => { const p = myPlayer(s, 0); return p && p.sliding === true; }, 2000);
    console.log("PASS: sliding broadcast true during the drift window.");
    const hA = myPlayer(sA, 0).body[0];
    const sB = await c1.waitFor(s => s.seq >= sA.seq + 2 && myPlayer(s, 0).sliding === true, 2000);
    const hB = myPlayer(sB, 0).body[0];
    assert(hB.y > hA.y, "head must keep descending during the drift (y " + hA.y + " -> " + hB.y + ")");
    assert(hB.x > hA.x, "momentum must carry the snake sideways during the drift (x " + hA.x + " -> " + hB.x + ")");
    console.log("PASS: body skids sideways (old direction) while the head descends.");

    const sC = await c1.waitFor(s => { const p = myPlayer(s, 0); return p && p.sliding === false; }, 3000);
    const hC = myPlayer(sC, 0).body[0];
    const sD = await c1.waitFor(s => s.seq >= sC.seq + 2, 2000);
    const hD = myPlayer(sD, 0).body[0];
    assert(hD.x === hC.x, "sideways momentum must stop once the drift expires (x " + hC.x + " -> " + hD.x + ")");
    assert(hD.y > hC.y, "head keeps going in the turned direction after the drift");
    console.log("PASS: drift expires on its own clock; travel is clean afterwards.");

    // ---- Part B: no wall grace while boosting ----
    await ensureHeadingRight(c1); // still boosting: head turns right immediately
    const atWall = await c1.waitFor(s => { const p = myPlayer(s, 0); return p && p.alive && p.body[0].x === COLS - 1; }, 8000);
    const dead = await c1.waitFor(s => { const p = myPlayer(s, 0); return p && p.alive === false; }, 3000);
    assert(dead.seq - atWall.seq === 1,
      "boosted wall hit must die with NO grace stall (died " + (dead.seq - atWall.seq) + " seqs after reaching the wall)");
    console.log("PASS: no wall grace while boosting.");

    // ---- Part C (contrast): unboosted wall hit still gets the grace tick ----
    await c1.waitFor(s => { const p = myPlayer(s, 0); return p && p.alive === true; }, 8000); // respawn (boost auto-cleared on death)
    await sleep(200);
    await ensureHeadingRight(c1);
    const atWall2 = await c1.waitFor(s => { const p = myPlayer(s, 0); return p && p.alive && p.body[0].x === COLS - 1; }, 10000);
    const dead2 = await c1.waitFor(s => { const p = myPlayer(s, 0); return p && p.alive === false; }, 3000);
    assert(dead2.seq - atWall2.seq === 2,
      "unboosted wall hit must still get the one-tick grace stall (died " + (dead2.seq - atWall2.seq) + " seqs after reaching the wall)");
    console.log("PASS: unboosted wall grace unchanged.");

    c1.close();
  } finally {
    await stopServer(server);
  }
}

runTest(main);
