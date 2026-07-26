// Trail gap regression (v3.6.7): powerup trails are laid at the cell the TAIL
// vacates each movement step. A boost DRIFT rigidly skids the whole body one
// cell sideways while the head also advances, so the vacated tail jumps MORE
// than one cell between consecutive lays. Before the gap-fill fix the trail
// came out DASHED -- disconnected tiles with holes a snake could slip through
// without crossing. This drives a boosted turn (which starts a drift) while an
// iceTrail is active and asserts the laid tiles stay a single contiguous blob.
// Run: deno run --allow-net --allow-read --allow-write --allow-run --allow-env
// tests/pw_trailgap.js
import { connectClient, myPlayer, assert, sleep, stepToward, startServer, stopServer, collectNextPickup, runTest, assertTrailContiguous } from "./helpers.js";

const COLS = 48, ROWS = 40;

async function steerTo(client, tx, ty, timeoutMs) {
  const deadline = Date.now() + (timeoutMs || 20000);
  while (Date.now() < deadline) {
    const cur = client.state;
    const p = myPlayer(cur, 0);
    if (!p) throw new Error("seat not playing");
    const head = p.body[0];
    if (Math.abs(head.x - tx) <= 1 && Math.abs(head.y - ty) <= 1) return;
    const dn = stepToward(cur, 0, tx, ty);
    if (dn) client.send({ type: "dir", dir: dn, local: 0 });
    await client.waitFor(s => s !== cur, 2000).catch(() => {});
  }
  throw new Error("timed out steering to staging point");
}

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
    move: { startIntervalMs: 100, minIntervalMs: 100, rampIntervalSec: 3600, rampStepMs: 0 },
    // Instant boost (no ramp/grace) so the drift fires deterministically on the
    // turn; a fast (2x) skid makes the tail's per-step jump unmistakable.
    boost: { enabled: true, boostSpeed: 2, driftMs: 800, rampMs: 0, holdGraceMs: 0 },
    powerups: {
      spawnIntervalMs: 400, maxConcurrentPickups: 1,
      wormhole: { enabled: false }, growthSpurt: { enabled: false },
      // Huge durations: the trail stays active and its tiles never expire for
      // the whole test, so the contiguity check sees the entire laid path.
      iceTrail: { enabled: true, durationMs: 600000, tileDurationMs: 600000, slowDurationMs: 1, slowMultiplierPerStack: 0.01, minSpeedMultiplier: 0.95 },
      poisonTrail: { enabled: false }, speedBoost: { enabled: false }, blueShell: { enabled: false },
      scissors: { enabled: false }
    }
  });
  try {
    const c1 = await connectClient();
    await c1.waitFor(s => myPlayer(s, 0) != null, 5000);

    console.log("Collecting iceTrail pickup...");
    await collectNextPickup(c1, 0, 20000);
    await c1.waitFor(s => { const p = myPlayer(s, 0); return p && p.activePowerup === "iceTrail"; }, 6000);
    console.log("PASS: iceTrail active, laying trail.");

    // Stage near the top-left, heading right, with room to skid down-right.
    await steerTo(c1, 10, 8, 25000);
    await ensureHeadingRight(c1);

    c1.send({ type: "boost", on: true, local: 0 });
    await c1.waitFor(s => { const p = myPlayer(s, 0); return p && p.boost === true; }, 3000);
    const settle = c1.state.seq;
    await c1.waitFor(s => s.seq >= settle + 2, 3000); // settle into the boosted straight run

    // Turn down WHILE boosting -> head turns immediately, body skids right for
    // the drift window: this is exactly the multi-cell tail jump that used to
    // leave gaps.
    const seq0 = c1.state.seq;
    c1.send({ type: "dir", dir: "down", local: 0 });
    await c1.waitFor(s => { const p = myPlayer(s, 0); return p && p.dir.y === 1; }, 3000);
    // Ride out the drift for several steps so the skidding tail lays a good run.
    const drifted = await c1.waitFor(s => { const p = myPlayer(s, 0); return p && p.sliding === true; }, 3000);
    await c1.waitFor(s => s.seq >= drifted.seq + 6, 4000);

    const tiles = c1.state.trails.length;
    assert(tiles >= 6, "expected a decent run of laid tiles (got " + tiles + ")");
    assertTrailContiguous(c1.state, "iceTrail under boost drift");
    console.log("PASS: trail stays contiguous through the boost drift (" + tiles + " tiles, single blob).");

    c1.close();
  } finally {
    await stopServer(server);
  }
}

runTest(main);
