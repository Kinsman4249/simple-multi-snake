// Wormhole e2e test: pickup arms the independent charge, then a fatal wall
// collision auto-fires it (teleport, no death, charge consumed) instead of
// killing the snake. Run: deno run --allow-net --allow-read --allow-write
// --allow-run --allow-env tests/pw_wormhole.js
import { connectClient, myPlayer, assert, sleep, startServer, stopServer, collectNextPickup, runTest } from "./helpers.js";

async function main() {
  const server = await startServer({
    grid: { cols: 12, rows: 12, cellSize: 20 },
    move: { startIntervalMs: 60, minIntervalMs: 60, rampIntervalSec: 3600, rampStepMs: 0 },
    powerups: {
      spawnIntervalMs: 300, maxConcurrentPickups: 3,
      wormhole: { enabled: true, lookaheadDepth: 3 },
      growthSpurt: { enabled: false }, iceTrail: { enabled: false },
      poisonTrail: { enabled: false }, speedBoost: { enabled: false }, blueShell: { enabled: false }
    }
  });
  try {
    const c1 = await connectClient();
    await c1.waitFor(s => myPlayer(s, 0) != null, 5000);

    console.log("Collecting wormhole pickup...");
    await collectNextPickup(c1, 0, 20000);
    let p = myPlayer(c1.state, 0);
    assert(p.wormholeCharge === true, "pickup should arm wormholeCharge");
    console.log("Armed. Driving into a wall...");

    // Let the snake continue on its current heading (no further steering)
    // until it either dies or the wormhole fires -- in a 12x12 bounded grid
    // it must reach a wall eventually.
    const result = await c1.waitFor(s => {
      const pp = myPlayer(s, 0);
      return pp && (pp.teleport === true || pp.alive === false);
    }, 20000);
    const after = myPlayer(result, 0);
    assert(after.alive === true, "snake should survive via wormhole, not die at the wall");
    assert(after.teleport === true, "state should carry a one-shot teleport flag");
    assert(after.wormholeCharge === false, "charge must be consumed on fire");
    console.log("PASS: wormhole fired, snake survived, charge consumed.");

    // The teleport flag must be one-shot: the NEXT broadcast should not
    // still carry it.
    await sleep(200);
    const next = c1.state;
    const nextP = myPlayer(next, 0);
    assert(!nextP.teleport, "teleport flag must clear after one broadcast");
    console.log("PASS: teleport flag is one-shot.");

    c1.close();
  } finally {
    await stopServer(server);
  }
}

runTest(main);
