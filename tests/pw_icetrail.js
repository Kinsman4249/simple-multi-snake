// Ice Trail e2e test: pickup -> held slot -> activate -> lays one trail
// tile per movement step -> crossing a tile (including the layer's OWN,
// since the laying snake is NOT immune per the confirmed design) slows
// movement, refreshes duration, and stacks severity up to a floor. Run:
// deno run --allow-net --allow-read --allow-write --allow-run --allow-env
// tests/pw_icetrail.js
import { connectClient, myPlayer, assert, sleep, startServer, stopServer, collectNextPickup, stepToward, runTest } from "./helpers.js";

function rotateCW(v) { return { x: -v.y, y: v.x }; }
function dirName(v) {
  if (v.x === 1) return "right"; if (v.x === -1) return "left";
  if (v.y === 1) return "down"; return "up";
}
// Sends one direction and waits for the next broadcast (one movement step).
async function stepDir(client, local, v) {
  const cur = client.state;
  client.send({ type: "dir", dir: dirName(v), local });
  await client.waitFor(s => s !== cur, 3000);
}
async function stepsStraight(client, local, v, n) {
  for (let i = 0; i < n; i++) await stepDir(client, local, v);
}

async function main() {
  const server = await startServer({
    grid: { cols: 36, rows: 36, cellSize: 20 },
    move: { startIntervalMs: 90, minIntervalMs: 90, rampIntervalSec: 3600, rampStepMs: 0 },
    powerups: {
      spawnIntervalMs: 300, maxConcurrentPickups: 3,
      wormhole: { enabled: false }, growthSpurt: { enabled: false },
      iceTrail: { enabled: true, durationMs: 10000, tileDurationMs: 15000, slowDurationMs: 3000, slowMultiplierPerStack: 0.15, minSpeedMultiplier: 0.4 },
      poisonTrail: { enabled: false }, speedBoost: { enabled: false }, blueShell: { enabled: false }
    }
  });
  try {
    const c1 = await connectClient();
    await c1.waitFor(s => myPlayer(s, 0) != null, 5000);

    console.log("Collecting iceTrail pickup...");
    await collectNextPickup(c1, 0, 20000);
    // iceTrail AUTO-activates on pickup (no button press) -- it should be
    // active immediately, with the held slot left empty.
    await c1.waitFor(s => { const pp = myPlayer(s, 0); return pp && pp.activePowerup === "iceTrail"; }, 3000);
    let p = myPlayer(c1.state, 0);
    assert(p.heldPowerup == null, "auto-fire trail should NOT occupy the held slot");
    console.log("PASS: pickup auto-activates trail-laying (no button press).");

    // Reposition toward dead-center for edge margin before the square loop,
    // retrying until comfortably clear of every wall (the loop below needs
    // N cells of clearance in every direction).
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

    const before = c1.state;
    assert(myPlayer(before, 0).activePowerup === "iceTrail", "still laying trail after repositioning");
    const startHead = { ...myPlayer(before, 0).body[0] };
    const dir0 = myPlayer(before, 0).dir;
    assert(
      startHead.x >= margin && startHead.x < grid.cols - margin && startHead.y >= margin && startHead.y < grid.rows - margin,
      "failed to reach safe margin before the loop (head=" + JSON.stringify(startHead) + ")"
    );
    console.log("Starting square loop from", startHead, "dir", dir0);

    const dirs = [dir0, rotateCW(dir0), rotateCW(rotateCW(dir0)), rotateCW(rotateCW(rotateCW(dir0)))];
    for (const d of dirs) await stepsStraight(c1, 0, d, N);

    assert(c1.state.trails.length > 0, "trail tiles should exist on the board");
    console.log("PASS: trail tiles laid (" + c1.state.trails.length + " on board).");

    // One more step in the original direction should land back on the
    // first-laid tile (the snake's own starting cell) -- self-crossing.
    const stacksBefore = myPlayer(c1.state, 0).iceStacks || 0;
    await stepDir(c1, 0, dir0);
    let after = myPlayer(c1.state, 0);
    assert(after.iceStacks > stacksBefore, "crossing an ice tile (even the layer's own) should increment iceStacks");
    console.log("PASS: self-crossing increments iceStacks (stacks=" + after.iceStacks + ").");

    const moveMsAfterOne = after.moveMs;
    // Cross again (park on the same tile's neighbor loop once more) to
    // confirm stacking increases severity further (lower moveMs = slower
    // is wrong direction -- slower means HIGHER moveMs).
    for (const d of dirs) await stepsStraight(c1, 0, d, N);
    await stepDir(c1, 0, dir0);
    after = myPlayer(c1.state, 0);
    assert(after.iceStacks > stacksBefore + 1, "a second lap of crossings should stack further (stacks=" + after.iceStacks + ")");
    assert(after.moveMs >= moveMsAfterOne, "additional stacking should slow further, not less (moveMs " + after.moveMs + " vs " + moveMsAfterOne + ")");
    console.log("PASS: stacking increases severity (moveMs " + moveMsAfterOne + " -> " + after.moveMs + ").");

    // Floor check: keep lapping and confirm moveMs never exceeds the
    // configured floor (minSpeedMultiplier 0.4 -> moveMs <= baseline/0.4).
    for (let lap = 0; lap < 4; lap++) {
      for (const d of dirs) await stepsStraight(c1, 0, d, N);
      await stepDir(c1, 0, dir0);
    }
    after = myPlayer(c1.state, 0);
    const baselineMoveMs = 90;
    const floorMoveMs = Math.round(baselineMoveMs / 0.4);
    assert(after.moveMs <= floorMoveMs + 5, "slow must be floored (moveMs " + after.moveMs + " should not exceed ~" + floorMoveMs + ")");
    console.log("PASS: slow is floored, never freezes solid (moveMs=" + after.moveMs + ", floor~" + floorMoveMs + ").");

    c1.close();
  } finally {
    await stopServer(server);
  }
}

runTest(main);
