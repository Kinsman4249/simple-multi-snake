// Head-on collision e2e: when two snakes collide head-on, BOTH must die.
// Covers BOTH tick-alignment shapes (see server.js resolveSnakeCollisions):
//
//   - SYNCED: both snakes move in the same movementStep. Meeting in the same
//     cell (even head gap) or trading cells (odd gap / the swap). Regression
//     for round eighteen, where the swap killed only the first-resolved snake.
//   - DESYNCED (split-step): the snakes' per-snake movement accumulators are
//     phase-offset (the REAL-PLAY norm -- two players never join in the same
//     16ms sim tick), so a head-on resolves sequentially: one snake's tick
//     fires first and its head lands on the other's STATIONARY head.
//     Regression for round nineteen, where that killed only the mover; the
//     stationary snake survived. On localhost both seats of one connection
//     spawn inside the same sim tick, which is why the synced tests alone
//     never caught it -- the desync variant staggers the second join by half
//     a move interval and then REQUIRES observing split-tick movement (a
//     broadcast where exactly one head advanced) before trusting the run.
//
// Deterministic staging via SNAKE_TEST_SPAWNS: same row, facing each other.
// Run: deno run --allow-net --allow-read --allow-write --allow-run --allow-env
// --unstable-detect-cjs tests/pw_headon.js
import { connectClient, myPlayer, sleep, startServer, stopServer, runTest, assert } from "./helpers.js";

const R = 9;             // shared row
const INTERVAL = 200;    // ms per cell -- big enough to stagger joins reliably

// One collision round. Returns the tick-alignment mode observed at death:
// "split" (a broadcast where exactly one head advanced -- desynced
// accumulators) or "same" (heads only ever advanced together). The mutual-
// death invariant is asserted EVERY round regardless of mode.
async function collide(label, spawns, staggerJoin) {
  const server = await startServer(
    {
      grid: { cols: 21, rows: 19, cellSize: 20 },
      move: { startIntervalMs: INTERVAL, minIntervalMs: INTERVAL, rampIntervalSec: 3600, rampStepMs: 0 },
      powerups: { spawnIntervalMs: 999999, wormhole:{enabled:false}, growthSpurt:{enabled:false}, iceTrail:{enabled:false}, poisonTrail:{enabled:false}, speedBoost:{enabled:false}, blueShell:{enabled:false} }
    },
    { SNAKE_TEST_SPAWNS: JSON.stringify(spawns) }
  );
  try {
    const c = await connectClient();
    await c.waitFor(s => myPlayer(s, 0) != null, 5000);
    if (staggerJoin) {
      // Nudge seat 1's spawn toward mid-phase: wait for a fresh broadcast (a
      // movement tick boundary), then sleep half the interval before joining.
      // Seat 0 keeps auto-moving right meanwhile; far-apart spawns absorb it.
      const cur = c.state;
      await c.waitFor(s => s !== cur, INTERVAL * 2).catch(() => {});
      await sleep(INTERVAL / 2);
    }
    c.send({ type: "joinLocal" });
    await c.waitFor(s => myPlayer(s, 1) != null, 5000);

    const p1 = myPlayer(c.state, 1);
    assert(p1.body[0].y === R && p1.dir.x === -1, "seat 1 should spawn on row R facing left");

    let prevA = null, prevB = null, sawSplit = false;
    for (let t = 0; t < 200; t++) {
      const cur = c.state;
      await c.waitFor(s => s !== cur, INTERVAL * 3).catch(() => {});
      const a = myPlayer(c.state, 0), b = myPlayer(c.state, 1);
      const aDead = !a || !a.alive, bDead = !b || !b.alive;
      if (aDead || bDead) {
        assert(aDead && bDead, label + " head-on must kill BOTH (p0.alive=" + (a && a.alive) + ", p1.alive=" + (b && b.alive) + ")");
        const mode = sawSplit ? "split" : "same";
        console.log("PASS: " + label + " head-on killed both snakes (" + mode + "-tick).");
        c.close();
        return mode;
      }
      const ha = a.body[0], hb = b.body[0];
      if (prevA && prevB) {
        const aMoved = ha.x !== prevA.x || ha.y !== prevA.y;
        const bMoved = hb.x !== prevB.x || hb.y !== prevB.y;
        if (aMoved !== bMoved) sawSplit = true;
      }
      prevA = { ...ha }; prevB = { ...hb };
    }
    throw new Error(label + " snakes never collided");
  } finally {
    await stopServer(server);
  }
}

async function main() {
  // Tick alignment cannot be forced from outside the server (join timing vs.
  // the 16ms sim grid is jittery), so run rounds -- varying spawn gap parity
  // and join stagger to push toward each mode -- until BOTH alignments have
  // produced a passing mutual death. Every round asserts the invariant.
  const seen = new Set();
  const rounds = [
    { label: "even-gap close", spawns: [{ x: 9, y: R, dir: "right" }, { x: 11, y: R, dir: "left" }], stagger: false },
    { label: "odd-gap close",  spawns: [{ x: 9, y: R, dir: "right" }, { x: 12, y: R, dir: "left" }], stagger: false },
    { label: "far staggered",  spawns: [{ x: 3, y: R, dir: "right" }, { x: 17, y: R, dir: "left" }], stagger: true }
  ];
  for (let n = 0; n < 12 && seen.size < 2; n++) {
    const r = rounds[n % rounds.length];
    seen.add(await collide(r.label, r.spawns, r.stagger));
  }
  assert(seen.has("split"), "never observed a split-tick (desynced) head-on in 12 rounds");
  assert(seen.has("same"), "never observed a same-tick (synced) head-on in 12 rounds");
  console.log("Covered both tick alignments: " + [...seen].join(", "));
}

runTest(main, { attempts: 3, watchdogMs: 360000 });
