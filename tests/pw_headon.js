// Head-on collision e2e: when two snakes collide head-on -- meeting in the
// same cell OR trading cells (a swap) -- BOTH must die. Regression for round
// eighteen, where a swap killed only the first-resolved snake and the second
// glided through the still-solid corpse and survived.
//
// Deterministic staging via SNAKE_TEST_SPAWNS (a test-only fixed-spawn hook):
// the two snakes spawn on the SAME ROW at opposite ends, already facing each
// other, so we just drive them straight in -- no walking/homing. An EVEN gap
// between the heads meets in the same cell; an ODD gap swaps. We run both.
// Run: deno run --allow-net --allow-read --allow-write --allow-run --allow-env
// --unstable-detect-cjs tests/pw_headon.js
import { connectClient, myPlayer, sleep, startServer, stopServer, runTest, assert } from "./helpers.js";

const R = 9; // shared row

async function collide(gapKind) {
  // p0 on the left facing right, p1 on the right facing left, spawned CLOSE and
  // centred so they collide in 1-2 ticks -- minimal travel means minimal chance
  // of eating stray food mid-approach (which could turn the meeting into a
  // body-ram and spuriously fail the both-die assertion). leftX + gap = rightX;
  // gap even (2) -> same-cell meeting, gap odd (3) -> swap.
  const leftX = 9;
  const rightX = gapKind === "even" ? 11 : 12; // gap 2 (even) or 3 (odd)
  const server = await startServer(
    {
      grid: { cols: 21, rows: 19, cellSize: 20 },
      move: { startIntervalMs: 100, minIntervalMs: 100, rampIntervalSec: 3600, rampStepMs: 0 },
      powerups: { spawnIntervalMs: 999999, wormhole:{enabled:false}, growthSpurt:{enabled:false}, iceTrail:{enabled:false}, poisonTrail:{enabled:false}, speedBoost:{enabled:false}, blueShell:{enabled:false} }
    },
    { SNAKE_TEST_SPAWNS: JSON.stringify([
      { x: leftX, y: R, dir: "right" },
      { x: rightX, y: R, dir: "left" }
    ]) }
  );
  try {
    const c = await connectClient();
    await c.waitFor(s => myPlayer(s,0)!=null, 5000);
    c.send({ type: "joinLocal" });
    await c.waitFor(s => myPlayer(s,1)!=null, 5000);

    const p0 = myPlayer(c.state,0), p1 = myPlayer(c.state,1);
    assert(p0.body[0].y === R && p1.body[0].y === R, "snakes should spawn on row R");
    assert(p0.dir.x === 1 && p1.dir.x === -1, "snakes should face each other");

    // No steering needed: they spawn facing each other and auto-move straight
    // in. Just watch for the collision (they close ~2 cells/tick and meet in
    // the middle within a few ticks).
    for (let t = 0; t < 30; t++) {
      await sleep(80);
      const a = myPlayer(c.state,0), b = myPlayer(c.state,1);
      const aDead = !a || !a.alive, bDead = !b || !b.alive;
      if (aDead || bDead) {
        assert(aDead && bDead, `${gapKind}-gap head-on must kill BOTH (p0.alive=${a&&a.alive}, p1.alive=${b&&b.alive})`);
        console.log(`PASS: ${gapKind}-gap head-on killed both snakes.`);
        c.close();
        return;
      }
    }
    throw new Error(`${gapKind}-gap snakes never collided`);
  } finally {
    await stopServer(server);
  }
}

async function main() {
  await collide("even"); // same-cell head-on
  await collide("odd");  // swap head-on
}

runTest(main, { attempts: 3 });
