// Speed Boost e2e test: pickup -> held slot -> activate -> moveMs reflects
// speedMult, stacks MULTIPLICATIVELY with hold-to-boost, reverts after
// durationMs. Run: deno run --allow-net --allow-read --allow-write
// --allow-run --allow-env tests/pw_speedboost.js
import { connectClient, myPlayer, assert, sleep, startServer, stopServer, collectNextPickup, runTest } from "./helpers.js";

async function main() {
  const server = await startServer({
    grid: { cols: 20, rows: 20, cellSize: 20 },
    move: { startIntervalMs: 200, minIntervalMs: 200, rampIntervalSec: 3600, rampStepMs: 0 },
    // rampMs/holdGraceMs 0: this test asserts the multiplicative STACKING of
    // hold-boost x speedBoost, so it samples moveMs right after boost turns
    // on -- pin instant engagement rather than waiting out the default ramp
    // (the ramp itself is covered by pw_boostramp.js).
    boost: { enabled: true, boostSpeed: 2, slideDistance: 3, rampMs: 0, holdGraceMs: 0 },
    powerups: {
      spawnIntervalMs: 300, maxConcurrentPickups: 3,
      wormhole: { enabled: false }, growthSpurt: { enabled: false },
      iceTrail: { enabled: false }, poisonTrail: { enabled: false }, blueShell: { enabled: false },
      scissors: { enabled: false },
      speedBoost: { enabled: true, durationMs: 2500, speedMult: 1.6 }
    }
  });
  try {
    const c1 = await connectClient();
    // `s => ...` is an arrow function callback (see docs/JS-CHEATSHEET.md).
    await c1.waitFor(s => myPlayer(s, 0) != null, 5000);
    const baseline = myPlayer(c1.state, 0).moveMs;
    console.log("baseline moveMs =", baseline);

    console.log("Collecting speedBoost pickup...");
    await collectNextPickup(c1, 0, 20000);
    let p = myPlayer(c1.state, 0);
    assert(p.heldPowerup === "speedBoost", "pickup should occupy heldPowerup");
    console.log("PASS: pickup occupies heldPowerup.");

    c1.send({ type: "activatePowerup", local: 0 });
    await c1.waitFor(s => { const pp = myPlayer(s, 0); return pp && pp.activePowerup === "speedBoost"; }, 3000);
    p = myPlayer(c1.state, 0);
    const boosted = p.moveMs;
    console.log("boosted moveMs =", boosted);
    const expected = Math.round(baseline / 1.6);
    assert(Math.abs(boosted - expected) <= 1, "moveMs should reflect speedMult 1.6x (expected ~" + expected + ", got " + boosted + ")");
    console.log("PASS: speedBoost powerup speeds up movement.");

    // Stack with hold-to-boost: should combine multiplicatively.
    c1.send({ type: "boost", on: true, local: 0 });
    await c1.waitFor(s => { const pp = myPlayer(s, 0); return pp && pp.boost === true; }, 3000);
    p = myPlayer(c1.state, 0);
    const stacked = p.moveMs;
    console.log("stacked moveMs =", stacked);
    const expectedStacked = Math.round(baseline / (1.6 * 2));
    assert(Math.abs(stacked - expectedStacked) <= 1, "hold-boost + speedBoost should stack multiplicatively (expected ~" + expectedStacked + ", got " + stacked + ")");
    console.log("PASS: stacks multiplicatively with hold-to-boost.");
    c1.send({ type: "boost", on: false, local: 0 });

    // Wait out the duration and confirm reversion.
    await c1.waitFor(s => { const pp = myPlayer(s, 0); return pp.activePowerup !== "speedBoost"; }, 6000);
    p = myPlayer(c1.state, 0);
    assert(p.moveMs === baseline, "moveMs should revert to baseline after expiry (got " + p.moveMs + ")");
    console.log("PASS: reverted after expiry.");

    c1.close();
  } finally {
    await stopServer(server);
  }
}

runTest(main);
